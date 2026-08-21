import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import type { BrowserContext, Page } from 'playwright';
import { AUDIO_TAP_SCRIPT } from './audio-tap';
import type { Config } from './config';
import { DeepgramStream, type Transcript } from './deepgram';
import { ensureGoogleSession } from './google-login';
import {
  AdmissionError,
  AuthSessionError,
  type BotConfig,
  inspectGoogleMeetCall,
  joinGoogleMeeting,
  leaveGoogleMeet,
  resetEscalation,
  setGoogleMeetMicrophone,
  setHooks,
  waitForGoogleMeetingAdmission,
} from './join';
import { humanPause, launchPersistentBrowser, warmUpProfile } from './stealth';
import { VoiceBrain } from './voice-brain';
import { VOICE_INJECT_SCRIPT } from './voice-inject';

/**
 * UNA REUNIÓN VIVA: el bot dentro de un Meet, escuchando.
 *
 * El join es el de Vexa (Playwright + humanized X11 + selectores + admisión).
 * Encima, Cortex mantiene: proxy residencial, warmup de perfil, invite de
 * Calendar, tap de audio → Deepgram, y voz.
 */
export interface MeetingParticipant {
  id: string;
  name: string;
  speaking: boolean;
  self: boolean;
}

export interface MeetSessionEvents {
  onTranscript: (t: Transcript) => void;
  onStatus: (status: MeetStatus, detail?: string) => void;
  onRoster: (people: MeetingParticipant[]) => void;
}

export type MeetStatus = 'joining' | 'waiting-admit' | 'live' | 'ended' | 'failed';

async function importProfileFromBrowserService(
  browserServiceUrl: string,
  serviceToken: string,
  owner: string,
  profileDir: string,
): Promise<boolean> {
  const safeOwner = owner.replace(/[^A-Za-z0-9_-]/g, '_');
  const url = `${browserServiceUrl}/profile/export`;
  console.log(`[cortex-meet] importando perfil de ${url} para owner=${safeOwner}`);

  const res = await fetch(url, {
    headers: { authorization: `Bearer ${serviceToken}`, 'x-cortex-owner': owner },
  });
  if (!res.ok) {
    console.log(
      `[cortex-meet] browser service respondió ${res.status}, no hay perfil que importar`,
    );
    return false;
  }

  rmSync(profileDir, { recursive: true, force: true });
  mkdirSync(profileDir, { recursive: true });

  if (!res.body) {
    console.log('[cortex-meet] browser service respondió sin body');
    return false;
  }

  const nodeStream = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);

  return new Promise<boolean>((resolve) => {
    const tar = spawn('tar', ['-xzf', '-', '-C', profileDir]);
    nodeStream.pipe(tar.stdin);
    tar.on('close', (code) => {
      if (code === 0) {
        console.log(`[cortex-meet] perfil importado a ${profileDir}`);
        resolve(true);
      } else {
        console.error(`[cortex-meet] tar salió ${code} al importar perfil`);
        resolve(false);
      }
    });
    tar.on('error', (err) => {
      console.error(`[cortex-meet] error al importar perfil: ${err.message}`);
      resolve(false);
    });
  });
}

export class MeetSession {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private deepgram: DeepgramStream | null = null;
  private status: MeetStatus = 'joining';
  private finalCount = 0;
  private endedReason: string | null = null;
  private voice: VoiceBrain | null = null;
  private voiceEnabled: boolean;
  private recent: Transcript[] = [];
  private botConfig: BotConfig | null = null;
  private stopRemoval: (() => void) | null = null;
  private xvfb: ChildProcess | null = null;
  private display: string | undefined;
  private rosterTimer: ReturnType<typeof setInterval> | null = null;
  private roster: MeetingParticipant[] = [];
  private finishing = false;
  private sawOthers = false;
  private aloneSince: number | null = null;

  constructor(
    readonly id: string,
    private readonly owner: string,
    private readonly meetUrl: string,
    private readonly botName: string,
    private readonly config: Config,
    private readonly events: MeetSessionEvents,
    voiceEnabled = false,
  ) {
    this.voiceEnabled = voiceEnabled;
  }

  setVoiceMuted(muted: boolean): void {
    this.voice?.setMuted(muted);
    if (this.page) void setGoogleMeetMicrophone(this.page, !muted);
  }

  /**
   * Dice una frase en la reunión (desde el chat: «Cortex, háblale»). Enciende
   * el micro de Meet si hacía falta y reproduce TTS en el micrófono suplanto.
   */
  async speakText(text: string): Promise<{ ok: boolean; detail?: string }> {
    const ready = await this.ensureVoiceReady();
    if (!ready || !this.voice) return { ok: false, detail: 'sin-sesion' };
    const ok = await this.voice.speakText(text);
    return ok ? { ok: true } : { ok: false, detail: 'no-pude-sintetizar' };
  }

  currentStatus(): { status: MeetStatus; detail: string | null } {
    return { status: this.status, detail: this.endedReason };
  }

  private setStatus(status: MeetStatus, detail?: string): void {
    this.status = status;
    if (detail) this.endedReason = detail;
    this.events.onStatus(status, detail);
  }

  async join(): Promise<void> {
    const guest = this.config.mode === 'guest';
    const profileDir = guest
      ? `${this.config.profilesDir}/guest_${this.id}`
      : `${this.config.profilesDir}/${this.owner.replace(/[^A-Za-z0-9_-]/g, '_')}`;

    mkdirSync(profileDir, { recursive: true });
    try {
      mkdirSync('/app/storage/screenshots', { recursive: true });
    } catch {
      mkdirSync('/tmp/cortex-meet-screenshots', { recursive: true });
    }

    console.log(
      `[cortex-meet] ${this.id} playwright guest=${guest} humanized=${this.config.uiInteractionMode} proxy=${Boolean(this.config.proxyServer)} voice=${this.voiceEnabled}`,
    );

    if (!guest && this.config.browserServiceUrl && !existsSync(`${profileDir}/Default`)) {
      console.log(`[cortex-meet] ${this.id} perfil local vacío, importando del browser service…`);
      await importProfileFromBrowserService(
        this.config.browserServiceUrl,
        this.config.serviceToken,
        this.owner,
        profileDir,
      );
    }

    this.display = await this.ensureDisplay();

    const { context, page } = await launchPersistentBrowser(profileDir, {
      proxyServer: this.config.proxyServer,
      proxyUsername: this.config.proxyUsername,
      proxyPassword: this.config.proxyPassword,
      locale: this.config.locale,
      timezone: this.config.timezone,
      display: this.display,
    });
    this.context = context;
    this.page = page;

    await this.context.addInitScript(AUDIO_TAP_SCRIPT);
    await page.evaluate(AUDIO_TAP_SCRIPT).catch(() => undefined);
    if (this.voiceEnabled) await this.context.addInitScript(VOICE_INJECT_SCRIPT);

    await this.context.exposeBinding(
      '__cortexAudioChunk',
      (_src, payload: { b64: string; rms?: number; speaker: string | null }) => {
        this.deepgram?.setSpeaker(payload.speaker);
        if (payload.b64) this.deepgram?.push(Buffer.from(payload.b64, 'base64'));
      },
    );

    this.deepgram = new DeepgramStream(this.config.deepgramKey, this.config.sttLanguage, (t) => {
      const speaker =
        t.speaker ||
        this.roster.find((p) => p.speaking && !p.self)?.name ||
        this.roster.find((p) => p.speaking)?.name ||
        null;
      const line = { ...t, speaker };
      if (line.isFinal) {
        // Rastro de que SÍ se oye: la primera frase y luego una de cada 25.
        // Sin esto, «entra pero no transcribe» no se puede distinguir de
        // «nadie habló» en los logs (pasó el 21-08).
        this.finalCount += 1;
        if (this.finalCount === 1 || this.finalCount % 25 === 0) {
          console.log(
            `[cortex-meet] ${this.id} transcript #${this.finalCount} ${speaker ?? '?'}: ${line.text.slice(0, 80)}`,
          );
        }
        this.recent.push(line);
        if (this.recent.length > 200) this.recent.shift();
        if (this.voice) void this.voice.onFinalLine(line);
      }
      this.events.onTranscript(line);
    });
    this.deepgram.start();

    this.setStatus('joining');

    if (!guest) {
      const login = await ensureGoogleSession(this.context, page, {
        email: this.config.googleEmail ?? undefined,
        password: this.config.googlePassword ?? undefined,
      });
      if (!login.ok) {
        this.setStatus('failed', login.reason);
        await this.leave();
        return;
      }
    }

    if (this.config.warmup) {
      await warmUpProfile(page);
    }

    const botConfig: BotConfig = {
      platform: 'google_meet',
      botName: this.botName,
      authenticated: !guest,
      uiInteractionMode: this.config.uiInteractionMode,
      display: this.display,
      voiceEnabled: this.voiceEnabled,
      automaticLeave: { waitingRoomTimeout: this.config.admissionTimeoutMs },
    };
    this.botConfig = botConfig;

    setHooks(
      {
        onState: (state, detail) => {
          if (state === 'joining') this.setStatus('joining');
          else if (state === 'awaiting_admission') this.setStatus('waiting-admit');
          else if (state === 'blocked' || state === 'needs_human_help') {
            this.setStatus(
              'waiting-admit',
              typeof detail === 'string' ? detail : JSON.stringify(detail ?? {}),
            );
          } else if (state === 'rejected') {
            this.setStatus('failed', typeof detail === 'string' ? detail : 'Meet rechazó al bot.');
          }
        },
        onStopRecording: async () => {
          await this.deepgram?.stop().catch(() => undefined);
        },
      },
      botConfig,
    );

    const maxAttempts = 3;
    let admitted = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      console.log(`[cortex-meet] ${this.id} join intento ${attempt}/${maxAttempts}`);
      resetEscalation();
      try {
        await joinGoogleMeeting(page, this.meetUrl, this.botName, botConfig);
        admitted = await waitForGoogleMeetingAdmission(
          page,
          this.config.admissionTimeoutMs,
          botConfig,
        );
        if (admitted) break;
      } catch (err) {
        if (err instanceof AuthSessionError) {
          this.setStatus('failed', err.message);
          await this.leave();
          return;
        }
        if (err instanceof AdmissionError && err.outcome === 'denial' && attempt < maxAttempts) {
          console.log(`[cortex-meet] ${this.id} denegado en lobby, reintentando: ${err.message}`);
          await humanPause(2_000, 4_000);
          continue;
        }
        const message = err instanceof Error ? err.message : String(err);
        this.setStatus('failed', message);
        await this.leave();
        return;
      }
    }

    if (!admitted) {
      this.setStatus('failed', `No me admitieron en ${maxAttempts} intentos.`);
      await this.leave();
      return;
    }

    await this.armAudioTap(page);
    this.startRosterWatch(page);
    if (this.voiceEnabled) await this.ensureVoiceReady();
    this.startCallEndWatch(page);
    this.setStatus('live');
  }

  private async ensureDisplay(): Promise<string | undefined> {
    if (process.platform !== 'linux') return process.env.DISPLAY;
    if (this.config.uiInteractionMode !== 'humanized') return process.env.DISPLAY || ':99';
    // Dedicated Xvfb per meeting so two humanized joins don't steal the pointer.
    const n = 110 + Math.floor(Math.random() * 80);
    const display = `:${n}`;
    const proc = spawn('Xvfb', [display, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'], {
      stdio: 'ignore',
    });
    await new Promise((r) => setTimeout(r, 400));
    if (proc.exitCode != null) {
      console.log(
        `[cortex-meet] Xvfb ${display} no arrancó, usando ${process.env.DISPLAY || ':99'}`,
      );
      return process.env.DISPLAY || ':99';
    }
    this.xvfb = proc;
    return display;
  }

  private async armAudioTap(page: Page): Promise<void> {
    if (!this.context) return;
    const started = await page
      .evaluate('(window.__cortexTap && window.__cortexTap.start()) || {ok:false,reason:"sin tap"}')
      .catch((err: Error) => ({ ok: false, reason: err.message }));
    console.log(`[cortex-meet] ${this.id} audio tap ${JSON.stringify(started)}`);
    // Tres lecturas, no una: a los 4 s casi siempre hay silencio; a los 30 s y
    // 2 min ya se sabe si el tap oye (peak > 0) o si la sala está muda para él.
    for (const delay of [4_000, 30_000, 120_000]) {
      setTimeout(() => {
        if (page.isClosed()) return;
        void page
          .evaluate('(window.__cortexTap && window.__cortexTap.level()) || {peak:0,chunks:0}')
          .then((lvl) =>
            console.log(
              `[cortex-meet] ${this.id} audio level @${delay / 1000}s ${JSON.stringify(lvl)}`,
            ),
          )
          .catch(() => undefined);
      }, delay);
    }
  }

  private startRosterWatch(page: Page): void {
    const tick = async () => {
      const people = (await page
        .evaluate(
          '(window.__cortexTap && window.__cortexTap.roster && window.__cortexTap.roster()) || []',
        )
        .catch(() => [])) as MeetingParticipant[];
      const json = JSON.stringify(people);
      if (json !== JSON.stringify(this.roster)) {
        this.roster = people;
        this.events.onRoster(people);
      }
      if (this.status !== 'live') return;
      const others = people.filter((p) => !p.self);
      if (others.length > 0) {
        this.sawOthers = true;
        this.aloneSince = null;
        return;
      }
      if (!this.sawOthers) return;
      const wait = this.config.everyoneLeftTimeoutMs;
      this.aloneSince ??= Date.now();
      if (Date.now() - this.aloneSince >= wait) {
        this.finish('Ya no quedó nadie en la llamada.');
      }
    };
    void tick();
    this.rosterTimer = setInterval(() => void tick(), 1000);
  }

  private startCallEndWatch(page: Page): void {
    let lostChromeSince: number | null = null;
    const liveAt = Date.now();
    page.on('close', () => this.finish('Se cerró la pestaña de Meet.'));

    const tick = async () => {
      if (this.status !== 'live' || this.finishing) return;
      const inspect = await inspectGoogleMeetCall(page);
      if (inspect.ended) {
        this.finish(inspect.reason || 'La reunión terminó.');
        return;
      }
      // Meet esconde la barra; los tiles no. Si desaparecen los dos un rato
      // seguido, ya no estamos en la sala — aunque el copy de despedida no
      // coincida (otro idioma, otro layout).
      if (Date.now() - liveAt > 12_000 && inspect.lostChrome) {
        lostChromeSince ??= Date.now();
        if (Date.now() - lostChromeSince >= 8_000) {
          this.finish('La sala de Meet desapareció: la llamada ya no está.');
        }
      } else {
        lostChromeSince = null;
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 1_500);
    this.stopRemoval = () => clearInterval(id);
  }

  private finish(reason: string): void {
    if (this.finishing) return;
    this.finishing = true;
    console.log(`[cortex-meet] ${this.id} call ended: ${reason}`);
    if (this.status !== 'ended' && this.status !== 'failed') {
      this.setStatus('ended', reason);
    }
    void this.leave();
  }

  private async ensureVoiceReady(): Promise<boolean> {
    const page = this.page;
    if (!page) return false;
    this.voiceEnabled = true;
    await page.evaluate(VOICE_INJECT_SCRIPT).catch(() => undefined);
    await setGoogleMeetMicrophone(page, true);
    if (this.voice) return true;
    this.voice = new VoiceBrain(this.owner, this.id, {
      config: this.config,
      recentTranscript: () => this.recent,
      speak: async (mp3B64) => {
        const result = await page
          .evaluate(
            (b64) =>
              (
                window as unknown as { __cortexVoice?: { speak: (b: string) => Promise<unknown> } }
              ).__cortexVoice?.speak(b64) ?? { error: 'sin __cortexVoice' },
            mp3B64,
          )
          .catch((err: Error) => ({ error: err.message }));
        // Si esto dice duration>0, gumAudio>0 y track live, el audio SALIÓ por
        // el micro suplantado; lo que quede es de Meet (micro apagado) o del
        // anfitrión.
        console.log(`[cortex-meet] ${this.id} speak ${JSON.stringify(result)}`);
      },
      mute: async () => {
        await setGoogleMeetMicrophone(page, false);
        await page
          .evaluate(() =>
            (window as unknown as { __cortexVoice?: { mute: () => void } }).__cortexVoice?.mute(),
          )
          .catch(() => undefined);
      },
      unmute: async () => {
        await setGoogleMeetMicrophone(page, true);
        await page
          .evaluate(() =>
            (
              window as unknown as { __cortexVoice?: { unmute: () => void } }
            ).__cortexVoice?.unmute(),
          )
          .catch(() => undefined);
      },
    });
    return true;
  }

  async leave(): Promise<void> {
    if (this.status === 'live') this.setStatus('ended', 'Cerrada por Cortex.');
    this.finishing = true;
    if (this.rosterTimer) {
      clearInterval(this.rosterTimer);
      this.rosterTimer = null;
    }
    this.stopRemoval?.();
    this.stopRemoval = null;
    if (this.page && this.botConfig) {
      await leaveGoogleMeet(this.page, this.botConfig, 'cortex_leave').catch(() => undefined);
    }
    await this.deepgram?.stop().catch(() => undefined);
    await this.context?.close().catch(() => undefined);
    this.context = null;
    this.page = null;
    if (this.xvfb) {
      this.xvfb.kill('SIGTERM');
      this.xvfb = null;
    }
    if (this.config.mode === 'guest') {
      try {
        rmSync(`${this.config.profilesDir}/guest_${this.id}`, { recursive: true, force: true });
      } catch {
        // Un perfil que no se pudo borrar lo barre el próximo arranque.
      }
    }
  }
}
