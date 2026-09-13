import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import type { BrowserContext, Page } from 'playwright';
import { AUDIO_TAP_SCRIPT } from './audio-tap';
import { chunksStalled, shouldRestartCapture, shouldRewireTracks } from './capture-health';
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
import { retainTranscript } from './live-captions';
import { LocalWakeDetector } from './local-wake';
import { MeetLiveVoice } from './meet-live-voice';
import { humanPause, launchPersistentBrowser, warmUpProfile } from './stealth';
import { resolveVirtualCamera } from './virtual-camera';
import { type CallEvent, rosterDiff, shouldTakeFrame, uploadVisualFrame } from './visual-log';
import { isBotSpeaker, isEchoOfBot } from './voice-brain';
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
  presenting?: boolean;
}

export interface MeetSessionEvents {
  onTranscript: (t: Transcript) => void;
  onStatus: (status: MeetStatus, detail?: string) => void;
  onRoster: (people: MeetingParticipant[]) => void;
  onVisual?: (event: CallEvent) => void;
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
  private liveVoice: MeetLiveVoice | null = null;
  private localWake: LocalWakeDetector | null = null;
  private voiceEnabled: boolean;
  private recent: Transcript[] = [];
  private heardAt = Date.now();
  private botSaid: Array<{ text: string; at: number }> = [];
  private botConfig: BotConfig | null = null;
  private stopRemoval: (() => void) | null = null;
  private xvfb: ChildProcess | null = null;
  private display: string | undefined;
  private rosterTimer: ReturnType<typeof setInterval> | null = null;
  private captureTimer: ReturnType<typeof setInterval> | null = null;
  private visualTimer: ReturnType<typeof setInterval> | null = null;
  private roster: MeetingParticipant[] = [];
  private timeline: CallEvent[] = [];
  private lastPresenting: string | null = null;
  private lastFrameAt = -100;
  private framesTaken = 0;
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
    this.liveVoice?.setMuted(muted);
    if (this.page) void setGoogleMeetMicrophone(this.page, !muted, this.botName, this.display);
  }

  /**
   * Lo que Cortex dice no pasa por Deepgram (el tap no oye el micro inyectado,
   * y si lo oye es un eco). Se escribe aquí para que viva en la sala, el
   * archivo y el contexto del siguiente turno.
   */
  private recordBotSpeech(text: string): void {
    const line = text.trim();
    if (!line) return;
    this.botSaid.push({ text: line, at: Date.now() });
    if (this.botSaid.length > 40) this.botSaid.shift();
    const t: Transcript = {
      text: line,
      isFinal: true,
      speaker: this.botName,
      at: (Date.now() - this.heardAt) / 1000,
    };
    this.recent.push(t);
    if (this.recent.length > 200) this.recent.shift();
    this.events.onTranscript(t);
    console.log(`[cortex-meet] ${this.id} said ${this.botName}: ${line.slice(0, 80)}`);
  }

  private ingestHeard(t: Transcript): void {
    const speaker =
      t.speaker ||
      this.roster.find((p) => p.speaking && !p.self)?.name ||
      this.roster.find((p) => p.speaking)?.name ||
      null;
    const line = { ...t, speaker };
    if (isBotSpeaker(line.speaker, this.botName)) return;
    const cutoff = Date.now() - 20_000;
    if (this.botSaid.some((s) => s.at >= cutoff && isEchoOfBot(line.text, s.text))) return;
    if (line.isFinal) {
      if (this.finalCount === 1 || this.finalCount % 25 === 0) {
        console.log(
          `[cortex-meet] ${this.id} transcript #${this.finalCount} ${speaker ?? '?'}: ${line.text.slice(0, 80)}`,
        );
      }
      this.recent.push(line);
      if (this.recent.length > 200) this.recent.shift();
    }
    this.events.onTranscript(line);
  }

  /**
   * Dice una frase en la reunión (desde el chat: «Cortex, háblale»). Enciende
   * el micro de Meet si hacía falta y reproduce TTS en el micrófono suplanto.
   */
  async speakText(text: string): Promise<{ ok: boolean; detail?: string }> {
    const ready = await this.ensureVoiceReady();
    if (ready && this.liveVoice) {
      const ok = await this.liveVoice.say(text);
      return { ok, ...(ok ? {} : { detail: 'GPT-Live no está listo' }) };
    }
    return { ok: false, detail: 'GPT-Live no está listo' };
  }

  currentStatus(): { status: MeetStatus; detail: string | null } {
    return { status: this.status, detail: this.endedReason };
  }

  snapshotTimeline(): CallEvent[] {
    return this.timeline.slice();
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

    const camera = await resolveVirtualCamera({
      spec: this.config.camera,
      name: this.botName,
      subtitle: this.config.cameraSubtitle,
      accent: this.config.cameraColor,
    });
    console.log(
      `[cortex-meet] ${this.id} cámara virtual mode=${camera.mode} enabled=${camera.enabled}`,
    );

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
    if (camera.script) {
      await this.context.addInitScript(camera.script);
      await page.evaluate(camera.script).catch(() => undefined);
    }
    if (this.voiceEnabled) {
      await this.context.addInitScript(VOICE_INJECT_SCRIPT);
      await page.evaluate(VOICE_INJECT_SCRIPT).catch(() => undefined);
    }

    await this.context.exposeBinding(
      '__cortexAudioChunk',
      (_src, payload: { b64: string; rms?: number; speaker: string | null }) => {
        this.deepgram?.setSpeaker(payload.speaker);
        if (payload.b64) {
          const pcm = Buffer.from(payload.b64, 'base64');
          this.deepgram?.push(pcm);
          this.localWake?.push(pcm);
          this.liveVoice?.push(pcm);
        }
      },
    );

    if (!this.voiceEnabled) {
      this.deepgram = new DeepgramStream(this.config.deepgramKey, this.config.sttLanguage, (t) => {
        this.ingestHeard(t);
      });
      this.deepgram.start();
    }

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
      cameraEnabled: camera.enabled,
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

    await this.keepPageAudible(page);
    this.logPulseSinks();
    await this.armAudioTap(page);
    this.startRosterWatch(page);
    this.startCaptureWatch(page);
    if (!this.voiceEnabled) this.startVisualWatch(page);
    if (camera.enabled) await this.armVirtualCamera(page);
    if (this.voiceEnabled && !(await this.ensureVoiceReady())) {
      this.setStatus(
        'failed',
        'No se pudo activar el detector local y GPT-Live. Revisa la configuración de voz.',
      );
      await this.leave();
      return;
    }
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

  private async keepPageAudible(page: Page): Promise<void> {
    await page.bringToFront().catch(() => undefined);
    try {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Page.setWebLifecycleState', { state: 'active' });
      await cdp.detach().catch(() => undefined);
    } catch {
      /* Chrome viejo o CDP cortado */
    }
  }

  private logPulseSinks(): void {
    if (process.platform !== 'linux') return;
    try {
      const sinks = execFileSync('pactl', ['list', 'short', 'sinks'], {
        encoding: 'utf8',
        timeout: 2_000,
      });
      console.log(
        `[cortex-meet] ${this.id} pulse sinks: ${sinks.replace(/\s+/g, ' ').trim() || '(vacío)'}`,
      );
    } catch (err) {
      console.log(
        `[cortex-meet] ${this.id} pulse ausente: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private async armVirtualCamera(page: Page): Promise<void> {
    const result = await page
      .evaluate(
        '(window.__cortexCamera && window.__cortexCamera.arm()) || {ok:false,reason:"sin cámara"}',
      )
      .catch((err: Error) => ({ ok: false, reason: err.message }));
    console.log(`[cortex-meet] ${this.id} camera arm ${JSON.stringify(result)}`);
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
          .evaluate(
            '(window.__cortexTap && (window.__cortexTap.peek || window.__cortexTap.level)()) || {peak:0,chunks:0}',
          )
          .then((lvl) =>
            console.log(
              `[cortex-meet] ${this.id} audio level @${delay / 1000}s ${JSON.stringify(lvl)}`,
            ),
          )
          .catch(() => undefined);
      }, delay);
    }
  }

  /**
   * Si el worklet/ScriptProcessor se muere o las pistas se reciclan en silencio,
   * Deepgram se queda ciego a mitad de llamada. Cada 10 s se mira el snapshot
   * del tap y se reengancha o se recrea el grafo, como el rescan de Vexa.
   */
  private startCaptureWatch(page: Page): void {
    let lastChunks = 0;
    let stallRounds = 0;
    let silentRounds = 0;
    const tick = async () => {
      if (this.status !== 'live' || page.isClosed()) return;
      const lvl = (await page
        .evaluate(
          '(window.__cortexTap && window.__cortexTap.level()) || {peak:0,recentPeak:0,chunks:0,live:0,playing:0,speaker:null}',
        )
        .catch(() => null)) as {
        chunks?: number;
        live?: number;
        recentPeak?: number;
        peak?: number;
        playing?: number;
        speaker?: string | null;
        capture?: string;
        trackInfo?: string;
        meetPlay?: string;
        meetSrc?: number;
        sampleRate?: number;
      } | null;
      if (!lvl) return;
      const chunks = lvl.chunks ?? 0;
      if (chunksStalled(lastChunks, chunks)) stallRounds += 1;
      else stallRounds = 0;
      lastChunks = chunks;
      const snapshot = {
        silentRounds,
        speaker: lvl.speaker ?? null,
        live: lvl.live ?? 0,
        recentPeak: lvl.recentPeak ?? 0,
      };
      if (snapshot.live > 0 && snapshot.recentPeak < 0.0005) silentRounds += 1;
      else silentRounds = 0;
      snapshot.silentRounds = silentRounds;
      console.log(
        `[cortex-meet] ${this.id} audio watch chunks=${chunks} live=${snapshot.live} recentPeak=${snapshot.recentPeak.toFixed(4)} stall=${stallRounds} silent=${silentRounds} capture=${lvl.capture ?? '?'} tracks=${lvl.trackInfo ?? ''} meet=${lvl.meetPlay ?? ''} src=${lvl.meetSrc ?? 0} sr=${lvl.sampleRate ?? 0}`,
      );

      if (shouldRestartCapture(stallRounds)) {
        stallRounds = 0;
        silentRounds = 0;
        const result = await page
          .evaluate(
            '(window.__cortexTap && window.__cortexTap.restart && window.__cortexTap.restart()) || {ok:false}',
          )
          .catch((err: Error) => ({ ok: false, reason: err.message }));
        console.log(
          `[cortex-meet] ${this.id} audio restart (chunks stalled) ${JSON.stringify(result)}`,
        );
        return;
      }
      if (shouldRewireTracks(snapshot)) {
        silentRounds = 0;
        const result = await page
          .evaluate(
            '(window.__cortexTap && window.__cortexTap.rewire && window.__cortexTap.rewire()) || {ok:false}',
          )
          .catch((err: Error) => ({ ok: false, reason: err.message }));
        console.log(
          `[cortex-meet] ${this.id} audio rewire (live tracks silent) ${JSON.stringify(result)}`,
        );
      }
    };
    this.captureTimer = setInterval(() => void tick(), 10_000);
  }

  private rememberEvent(event: CallEvent): void {
    this.timeline.push(event);
    if (this.timeline.length > 400) this.timeline.shift();
    this.events.onVisual?.(event);
  }

  private startVisualWatch(page: Page): void {
    const tick = async () => {
      if (this.status !== 'live' || page.isClosed()) return;
      const scene = (await page
        .evaluate(
          '(window.__cortexTap && window.__cortexTap.scene && window.__cortexTap.scene()) || {presenting:null}',
        )
        .catch(() => null)) as { presenting?: string | null } | null;
      const presenting = scene?.presenting?.trim() || null;
      const at = (Date.now() - this.heardAt) / 1000;
      const presentingChanged = presenting !== this.lastPresenting;
      this.lastPresenting = presenting;
      if (
        !shouldTakeFrame({
          presentingChanged,
          presenting: Boolean(presenting),
          secondsSinceFrame: at - this.lastFrameAt,
          framesTaken: this.framesTaken,
        })
      ) {
        return;
      }
      await this.captureFrame(page, at, presenting);
    };
    void tick();
    this.visualTimer = setInterval(() => void tick(), 5_000);
  }

  private async captureFrame(page: Page, at: number, speaker: string | null): Promise<void> {
    if (page.isClosed()) return;
    let jpeg: Buffer;
    try {
      jpeg = await page.screenshot({ type: 'jpeg', quality: 42, scale: 'css' });
    } catch (err) {
      console.log(`[cortex-meet] ${this.id} screenshot failed ${(err as Error).message}`);
      return;
    }
    const label = speaker ? `${speaker} · pantalla compartida` : 'Sala';
    const path = await uploadVisualFrame({
      cortexBaseUrl: this.config.cortexBaseUrl,
      serviceToken: this.config.serviceToken,
      owner: this.owner,
      sessionId: this.id,
      at,
      kind: 'frame',
      label,
      speaker,
      jpeg,
    });
    this.framesTaken += 1;
    this.lastFrameAt = at;
    this.rememberEvent({ at, kind: 'frame', label, speaker, path });
    console.log(
      `[cortex-meet] ${this.id} visual frame at=${at.toFixed(0)}s speaker=${speaker ?? '-'} path=${path ?? 'no'}`,
    );
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
        const at = (Date.now() - this.heardAt) / 1000;
        for (const ev of rosterDiff(this.roster, people, at)) this.rememberEvent(ev);
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
    await setGoogleMeetMicrophone(page, true, this.botName, this.display);
    const armed = await page
      .evaluate(
        () =>
          (
            window as unknown as { __cortexVoice?: { arm?: () => Promise<unknown> } }
          ).__cortexVoice?.arm?.() ?? { error: 'sin __cortexVoice.arm' },
      )
      .catch((err: Error) => ({ error: err.message }));
    console.log(`[cortex-meet] ${this.id} voice arm ${JSON.stringify(armed)}`);
    // Voice-enabled meetings use local wake detection; no cloud STT in standby.
    if (this.liveVoice) return true;
    if (!this.config.openaiKey) {
      console.error('[cortex-meet] GPT-Live requires OPENAI_API_KEY');
      return false;
    }
    await this.deepgram?.stop().catch(() => undefined);
    this.deepgram = null;
    if (this.visualTimer) clearInterval(this.visualTimer);
    this.visualTimer = null;
    this.liveVoice = new MeetLiveVoice({
      config: this.config,
      owner: this.owner,
      sessionId: this.id,
      captureView: async () => {
        if (this.status !== 'live' || page.isClosed()) return null;
        const scene = await page
          .evaluate(() =>
            (
              window as unknown as {
                __cortexTap?: { scene?: () => { presenting?: string | null } };
              }
            ).__cortexTap?.scene?.(),
          )
          .catch(() => null);
        if (!scene?.presenting) return null;
        const jpeg = await page.screenshot({
          type: 'jpeg',
          quality: 75,
          scale: 'css',
          timeout: 5000,
        });
        if (jpeg.length > 1_500_000) return null;
        return {
          imageBase64: jpeg.toString('base64'),
          capturedAt: Date.now(),
          scope: 'meeting-viewport',
        };
      },
      audio: async (pcm) => {
        await page.evaluate((b64) => {
          const voice = (
            window as unknown as {
              __cortexVoice?: { speakPcm: (b: string, rate: number) => unknown };
            }
          ).__cortexVoice;
          voice?.speakPcm(b64, 24000);
        }, pcm.toString('base64'));
      },
      clear: async () => {
        await page.evaluate(() => {
          (
            window as unknown as { __cortexVoice?: { stopPlayback: () => void } }
          ).__cortexVoice?.stopPlayback();
        });
      },
      playbackRemainingMs: async () =>
        page.evaluate(
          () =>
            (
              window as unknown as { __cortexVoice?: { playbackRemainingMs: () => number } }
            ).__cortexVoice?.playbackRemainingMs() ?? 0,
        ),
      recentContext: () =>
        this.recent
          .slice(-40)
          .map((line) => `${Math.round(line.at)}s ${line.speaker ?? 'Participante'}: ${line.text}`)
          .join('\n'),
      meetingStartedAt: this.heardAt,
      transcript: (row) => {
        const line = { ...row, speaker: row.role === 'assistant' ? this.botName : null };
        retainTranscript(this.recent, line);
        if (this.recent.length > 200) this.recent.shift();
        this.events.onTranscript(line);
      },
      status: (state) => {
        console.log(`[cortex-meet] ${this.id} GPT-Live: ${state}`);
        const cameraState =
          state === 'respondiendo'
            ? 'speaking'
            : state === 'conversando'
              ? 'listening'
              : ['preparando Cortex', 'conectando', 'consultando cerebro'].includes(state)
                ? 'processing'
                : 'idle';
        void page
          .evaluate(
            (value) =>
              (
                window as unknown as { __cortexCamera?: { setState: (state: string) => void } }
              ).__cortexCamera?.setState(value),
            cameraState,
          )
          .catch(() => undefined);
      },
    });
    this.localWake = new LocalWakeDetector({
      onWake: () => {
        void this.liveVoice?.wake();
      },
      onError: () => {
        console.error('[cortex-meet] local wake unavailable');
        void this.liveVoice?.sleep('detector no disponible');
      },
    });
    try {
      await this.localWake.start();
      return true;
    } catch {
      await this.localWake.stop();
      this.localWake = null;
      await this.liveVoice.sleep('detector no disponible');
      this.liveVoice = null;
      return false;
    }
  }

  async leave(): Promise<void> {
    if (this.status === 'live') this.setStatus('ended', 'Cerrada por Cortex.');
    this.finishing = true;
    await this.localWake?.stop();
    this.localWake = null;
    await this.liveVoice?.sleep('llamada terminada');
    this.liveVoice = null;
    if (this.rosterTimer) {
      clearInterval(this.rosterTimer);
      this.rosterTimer = null;
    }
    if (this.captureTimer) {
      clearInterval(this.captureTimer);
      this.captureTimer = null;
    }
    if (this.visualTimer) {
      clearInterval(this.visualTimer);
      this.visualTimer = null;
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
