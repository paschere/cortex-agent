import { type BrowserContext, type Page, chromium } from 'playwright';
import { AUDIO_TAP_SCRIPT } from './audio-tap';
import type { Config } from './config';
import { DeepgramStream, type Transcript } from './deepgram';
import { ensureGoogleSession } from './google-login';
import { VoiceBrain } from './voice-brain';
import { VOICE_INJECT_SCRIPT } from './voice-inject';

/**
 * UNA REUNIÓN VIVA: el bot autenticado dentro de un Meet, escuchando.
 *
 * ===========================================================================
 * LO QUE F0 DEJÓ PROBADO, Y AQUÍ ES DOCTRINA
 * ===========================================================================
 * El spike respondió las tres preguntas y sus respuestas son las reglas de
 * esta clase:
 *   1. El invitado anónimo NO entra — Meet corre un anti-bot al «Solicitar
 *      unirse». Se entra AUTENTICADO, con el perfil del tenant ya logueado.
 *   2. Contra la detección de automatización: launchPersistentContext + Chrome
 *      real + máscara de navigator.webdriver + sin --enable-automation.
 *   3. El audio de la sala se saca con el tap de Web Audio (audio-tap.ts), sin
 *      PulseAudio. RMS 0→0.08 al hablar, medido.
 *
 * ===========================================================================
 * UN PERFIL POR TENANT, IGUAL QUE EL NAVEGADOR
 * ===========================================================================
 * `<profilesDir>/<owner>` — la misma forma que services/browser/profiles.ts,
 * y por la misma razón: la sesión de Google del bot de una empresa es suya y
 * no la ve otra. El login de esa cuenta se hace una vez con el flujo de
 * secretos (la persona escribe la clave en la página de Google sin que el
 * modelo la vea); aquí solo se reusa.
 */
export interface MeetSessionEvents {
  onTranscript: (t: Transcript) => void;
  onStatus: (status: MeetStatus, detail?: string) => void;
}

export type MeetStatus = 'joining' | 'waiting-admit' | 'live' | 'ended' | 'failed';

export class MeetSession {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private deepgram: DeepgramStream | null = null;
  private status: MeetStatus = 'joining';
  private endedReason: string | null = null;
  private voice: VoiceBrain | null = null;
  private voiceEnabled: boolean;
  private recent: import('./deepgram').Transcript[] = [];

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

  /** El botón de mute de la sala, o el flag de plan que apaga la voz. */
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
    const profileDir = `${this.config.profilesDir}/${this.owner.replace(/[^A-Za-z0-9_-]/g, '_')}`;
    // El proxy residencial, si está configurado — por-contexto, como recomienda
    // la industria, para aislar el tráfico del bot y poder rotarlo. Es lo que
    // hace que Meet acepte al bot desde Railway (ver config.proxyServer).
    const proxy = this.config.proxyServer
      ? {
          server: this.config.proxyServer,
          ...(this.config.proxyUsername ? { username: this.config.proxyUsername } : {}),
          ...(this.config.proxyPassword ? { password: this.config.proxyPassword } : {}),
        }
      : undefined;

    this.context = await chromium.launchPersistentContext(profileDir, {
      channel: 'chrome',
      ...(proxy ? { proxy } : {}),
      // NUNCA headless: Meet degrada a los clientes headless. En Railway hay
      // Xvfb (DISPLAY=:99) que hace a Chrome headful sin abrir ventana; en un
      // Mac se ve la ventana. headless solo si de verdad no hay display Y no se
      // pidió headful — un caso que en la práctica no ocurre en producción.
      headless: false,
      permissions: ['microphone', 'camera'],
      viewport: { width: 1280, height: 800 },
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process,AutomationControlled',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    });
    await this.context.addInitScript(
      "Object.defineProperty(navigator,'webdriver',{get:()=>undefined}); window.chrome=window.chrome||{runtime:{}};",
    );
    // Suplantar el micro ANTES de que Meet lo pida, solo si la voz está activa.
    if (this.voiceEnabled) await this.context.addInitScript(VOICE_INJECT_SCRIPT);

    const page = this.context.pages()[0] || (await this.context.newPage());
    this.page = page;

    // El puente por el que el tap manda audio + hablante a este proceso.
    this.deepgram = new DeepgramStream(this.config.deepgramKey, this.config.sttLanguage, (t) => {
      if (t.isFinal) {
        this.recent.push(t);
        if (this.recent.length > 200) this.recent.shift();
        // Si le hablaron a Cortex, la voz decide (detrás del flag).
        if (this.voice) void this.voice.onFinalLine(t);
      }
      this.events.onTranscript(t);
    });
    this.deepgram.start();
    await this.context.exposeBinding(
      '__cortexAudioChunk',
      (_src, payload: { b64: string; speaker: string | null }) => {
        this.deepgram?.setSpeaker(payload.speaker);
        if (payload.b64) this.deepgram?.push(Buffer.from(payload.b64, 'base64'));
      },
    );

    this.setStatus('joining');

    // Asegurar sesión de Google (auto-login en Railway; no-op si ya logueado).
    const login = await ensureGoogleSession(this.context, page, {
      email: this.config.googleEmail ?? undefined,
      password: this.config.googlePassword ?? undefined,
    });
    if (!login.ok) {
      this.setStatus('failed', login.reason);
      await this.leave();
      return;
    }

    await page.goto(this.meetUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(4_000);

    // Apagar cámara y micro en la pre-sala. Selectores laxos y en dos idiomas;
    // se verifica el ESTADO (aria-label cambia a «Turn on…» al apagar) para no
    // volver a encenderlos por clickear dos veces.
    await this.muteDevices(page);
    const nameField = page.locator('input[type="text"]').first();
    if (await nameField.isVisible().catch(() => false)) {
      await nameField.pressSequentially(this.botName, { delay: 30 }).catch(() => undefined);
    }
    const joinBtn = page
      .locator(
        'button:has-text("Ask to join"), button:has-text("Solicitar unirse"), button:has-text("Join now"), button:has-text("Unirte ahora")',
      )
      .first();
    await joinBtn.click({ timeout: 5_000 }).catch(() => undefined);
    this.setStatus('waiting-admit');

    // Esperar admisión (hasta 2 min). La sala aparece con el botón de colgar.
    const deadline = Date.now() + 120_000;
    let inRoom = false;
    while (Date.now() < deadline) {
      inRoom = await page
        .locator(
          '[aria-label*="Leave call"], [aria-label*="Abandonar"], button[aria-label*="Salir"]',
        )
        .first()
        .isVisible()
        .catch(() => false);
      // Si Meet nos echó (anti-bot, o el anfitrión rechazó), no insistir.
      const bounced = await page
        .getByText(/no puedes unirte|can.t join|removed from the meeting/i)
        .first()
        .isVisible()
        .catch(() => false);
      if (inRoom || bounced) {
        if (bounced) {
          this.setStatus('failed', 'Meet no dejó entrar al bot (¿cuenta sin sesión o rechazado?).');
          return;
        }
        break;
      }
      await page.waitForTimeout(3_000);
    }
    if (!inRoom) {
      this.setStatus('failed', 'Nadie admitió al bot en la reunión.');
      return;
    }

    // Ya dentro: Meet a veces entra con la cámara encendida aunque se apagara en
    // la pre-sala. Se apaga otra vez, en la sala, donde los atajos sí aplican.
    // La cámara siempre; el micro solo sin voz (ver muteDevices).
    await this.muteDevices(page);
    await page.keyboard.press('Control+e').catch(() => undefined); // cámara (Meet)
    if (!this.voiceEnabled) await page.keyboard.press('Control+d').catch(() => undefined); // micro

    await page.evaluate(AUDIO_TAP_SCRIPT).catch(() => undefined);
    await page.evaluate('window.__cortexTap && window.__cortexTap.start()').catch(() => undefined);

    if (this.voiceEnabled) {
      // La voz: suplantar el micro (se instaló como initScript, aquí solo se
      // arma el cerebro que decide cuándo hablar). speak/mute cruzan a la
      // página; la reproducción ocurre en voice-inject.
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
            .evaluate('window.__cortexVoice && window.__cortexVoice.mute()')
            .catch(() => undefined);
        },
        unmute: async () => {
          await page
            .evaluate('window.__cortexVoice && window.__cortexVoice.unmute()')
            .catch(() => undefined);
        },
      });
    }
    this.setStatus('live');

    // Vigilar que sigamos dentro: si el bot es expulsado o la reunión termina,
    // la sala desaparece y la sesión se cierra sola.
    void this.watchAlive(page);
  }

  private async watchAlive(page: Page): Promise<void> {
    while (this.status === 'live') {
      await page.waitForTimeout(5_000);
      const alive = await page
        .locator('[aria-label*="Leave call"], [aria-label*="Abandonar"]')
        .first()
        .isVisible()
        .catch(() => false);
      if (!alive) {
        this.setStatus('ended', 'La reunión terminó o el bot salió.');
        await this.leave();
        return;
      }
    }
  }

  /**
   * Apaga la cámara siempre, y el micro SOLO si la voz está desactivada.
   *
   * El micro es la clave: cuando la voz está activa, es el micrófono
   * suplantado (voice-inject.ts) por el que Cortex habla — silenciarlo en Meet
   * lo dejaría mudo. Ese micro ya está en silencio por su nodo de ganancia
   * hasta que Cortex habla, así que dejarlo ENCENDIDO en Meet es a la vez
   * silencioso y funcional. Sin voz, sí se apaga: un participante que solo
   * escucha no necesita micro abierto.
   *
   * Mira el aria-label (encendido dice «Turn off…»/«Desactivar…») para no
   * reencender por clickear dos veces.
   */
  private async muteDevices(page: Page): Promise<void> {
    const cameraLabels = ['Turn off camera', 'Desactivar cámara', 'Apagar la cámara'];
    const micLabels = ['Turn off microphone', 'Desactivar micrófono', 'Apagar el micrófono'];
    const labels = this.voiceEnabled ? cameraLabels : [...cameraLabels, ...micLabels];
    for (const label of labels) {
      const btn = page.locator(`[aria-label*="${label}" i]`).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click({ timeout: 1_500 }).catch(() => undefined);
      }
    }
  }

  async leave(): Promise<void> {
    if (this.status === 'live') this.setStatus('ended', 'Cerrada por Cortex.');
    await this.deepgram?.stop().catch(() => undefined);
    await this.context?.close().catch(() => undefined);
    this.context = null;
    this.page = null;
  }
}
