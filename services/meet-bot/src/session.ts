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
  joinGoogleMeeting,
  leaveGoogleMeet,
  resetEscalation,
  setGoogleMeetMicrophone,
  setHooks,
  startGoogleRemovalMonitor,
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

    setHooks({
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
    });

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
    if (this.voiceEnabled) await setGoogleMeetMicrophone(page, true);

    if (this.voiceEnabled) {
      this.voice = new VoiceBrain(this.owner, this.id, {
        config: this.config,
        recentTranscript: () => this.recent,
        speak: async (mp3B64) => {
          await page
            .evaluate(
              (b64) =>
                (
                  window as unknown as { __cortexVoice?: { speak: (b: string) => Promise<number> } }
                ).__cortexVoice?.speak(b64),
              mp3B64,
            )
            .catch(() => undefined);
        },
        mute: async () => {
          await page
            .evaluate(() =>
              (window as unknown as { __cortexVoice?: { mute: () => void } }).__cortexVoice?.mute(),
            )
            .catch(() => undefined);
        },
        unmute: async () => {
          await page
            .evaluate(() =>
              (
                window as unknown as { __cortexVoice?: { unmute: () => void } }
              ).__cortexVoice?.unmute(),
            )
            .catch(() => undefined);
        },
      });
    }

    this.stopRemoval = startGoogleRemovalMonitor(page, () => {
      this.setStatus('ended', 'Google nos sacó de la llamada.');
      void this.leave();
    });

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
    setTimeout(() => {
      void page
        .evaluate('(window.__cortexTap && window.__cortexTap.level()) || {peak:0,chunks:0}')
        .then((lvl) => console.log(`[cortex-meet] ${this.id} audio level ${JSON.stringify(lvl)}`))
        .catch(() => undefined);
    }, 4_000);
  }

  private startRosterWatch(page: Page): void {
    const tick = async () => {
      const people = (await page
        .evaluate(
          '(window.__cortexTap && window.__cortexTap.roster && window.__cortexTap.roster()) || []',
        )
        .catch(() => [])) as MeetingParticipant[];
      const json = JSON.stringify(people);
      if (json === JSON.stringify(this.roster)) return;
      this.roster = people;
      this.events.onRoster(people);
    };
    void tick();
    this.rosterTimer = setInterval(() => void tick(), 1000);
  }

  async leave(): Promise<void> {
    if (this.status === 'live') this.setStatus('ended', 'Cerrada por Cortex.');
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
