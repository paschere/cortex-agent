import { type BrowserContext, type Page, chromium } from 'patchright';
import { AUDIO_TAP_SCRIPT } from './audio-tap';
import type { Config } from './config';
import { DeepgramStream, type Transcript } from './deepgram';
import { ensureGoogleSession } from './google-login';
import { chromeLaunchOptions, evaluateInMain, humanPause, looksKicked } from './stealth';
import { VoiceBrain } from './voice-brain';
import { VOICE_INJECT_SCRIPT } from './voice-inject';

/**
 * UNA REUNIÓN VIVA: el bot dentro de un Meet, escuchando.
 *
 * Entra como INVITADO anónimo (default). Google quema las cuentas que se
 * loguean desde un datacenter y las saca de la llamada; un guest no tiene
 * cuenta que marcar. Contra la detección: Patchright (Chrome real, headed,
 * sin Runtime.enable) + perfil efímero + fingerprint de persona (locale,
 * timezone, viewport real). El audio se toca DESPUÉS de estar dentro, para
 * no regalar CDP en la pre-sala.
 *
 * MEET_MODE=account reusa el camino viejo (sesión de Google del tenant).
 */
export interface MeetSessionEvents {
  onTranscript: (t: Transcript) => void;
  onStatus: (status: MeetStatus, detail?: string) => void;
}

export type MeetStatus = 'joining' | 'waiting-admit' | 'live' | 'ended' | 'failed';

const JOIN_BUTTON =
  'button:has-text("Ask to join"), button:has-text("Solicitar unirse"), button:has-text("Request to join"), button:has-text("Join now"), button:has-text("Unirte ahora"), button:has-text("Unirse ahora"), button:has-text("Join anyway"), button:has-text("Unirse")';

const LEAVE_BUTTON =
  '[aria-label*="Leave call"], [aria-label*="Abandonar"], button[aria-label*="Salir"], [aria-label*="Leave meeting"]';

const NAME_FIELD =
  'input[aria-label*="name" i], input[aria-label*="nombre" i], input[placeholder*="name" i], input[placeholder*="nombre" i], input[type="text"]';

const DISMISS_BUTTONS = [
  'Continue as guest',
  'Continuar como invitado',
  'Join as guest',
  'Unirse como invitado',
  'Got it',
  'Entendido',
  'Dismiss',
  'Cerrar',
  'Not now',
  'Ahora no',
  'Use the browser',
  'Usar el navegador',
  'Join from your browser',
  'Unirse desde el navegador',
];

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

  /** El texto visible de la página, para saber QUÉ ve el bot cuando falla. */
  private async peek(page: Page): Promise<string> {
    return (await page
      .evaluate(
        'document.body ? document.body.innerText.slice(0, 800).replace(/\\n+/g, " | ") : "(vacío)"',
      )
      .catch(() => '(no se pudo leer)')) as string;
  }

  async join(): Promise<void> {
    const guest = this.config.mode === 'guest';
    const profileDir = guest
      ? `${this.config.profilesDir}/guest_${this.id}`
      : `${this.config.profilesDir}/${this.owner.replace(/[^A-Za-z0-9_-]/g, '_')}`;

    console.log(
      `[cortex-meet] ${this.id} chrome guest=${guest} proxy=${Boolean(this.config.proxyServer)} voice=${this.voiceEnabled}`,
    );

    this.context = await chromium.launchPersistentContext(
      profileDir,
      chromeLaunchOptions({
        proxyServer: this.config.proxyServer,
        proxyUsername: this.config.proxyUsername,
        proxyPassword: this.config.proxyPassword,
        locale: this.config.locale,
        timezone: this.config.timezone,
      }),
    );
    // La voz engancha getUserMedia ANTES de que Meet lo pida. Solo con voz:
    // el hook mismo es una huella, no se instala si solo vamos a escuchar.
    if (this.voiceEnabled) await this.context.addInitScript(VOICE_INJECT_SCRIPT);

    const page = this.context.pages()[0] || (await this.context.newPage());
    this.page = page;

    this.deepgram = new DeepgramStream(this.config.deepgramKey, this.config.sttLanguage, (t) => {
      if (t.isFinal) {
        this.recent.push(t);
        if (this.recent.length > 200) this.recent.shift();
        if (this.voice) void this.voice.onFinalLine(t);
      }
      this.events.onTranscript(t);
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

    await page.goto(this.meetUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await humanPause(1_200, 2_400);
    await this.dismissInterstitials(page);

    const kickedOnArrival = await this.peek(page);
    if (looksKicked(kickedOnArrival)) {
      this.setStatus('failed', `Meet rebotó al llegar. Pantalla: ${kickedOnArrival}`);
      await this.leave();
      return;
    }

    await this.muteDevices(page);
    await this.fillGuestName(page);
    await humanPause(400, 900);

    const joinBtn = page.locator(JOIN_BUTTON).first();
    const joinVisible = await joinBtn
      .waitFor({ state: 'visible', timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    if (!joinVisible) {
      this.setStatus('failed', `No vi el botón de unirse. Pantalla: ${await this.peek(page)}`);
      await this.leave();
      return;
    }
    await joinBtn.click({ timeout: 8_000 }).catch(() => undefined);
    this.setStatus('waiting-admit');

    const deadline = Date.now() + 120_000;
    let inRoom = false;
    while (Date.now() < deadline) {
      inRoom = await page
        .locator(LEAVE_BUTTON)
        .first()
        .isVisible()
        .catch(() => false);
      const screen = await this.peek(page);
      if (inRoom) break;
      if (looksKicked(screen)) {
        this.setStatus('failed', `Meet rebotó. Pantalla: ${screen}`);
        await this.leave();
        return;
      }
      await page.waitForTimeout(3_000);
    }
    if (!inRoom) {
      this.setStatus('failed', `No entré en 2 min. Pantalla: ${await this.peek(page)}`);
      await this.leave();
      return;
    }

    await this.muteDevices(page);
    await page.keyboard.press('Control+e').catch(() => undefined);
    if (!this.voiceEnabled) await page.keyboard.press('Control+d').catch(() => undefined);

    // CDP (binding + tap) recién aquí: si se instala en la pre-sala, Meet ve
    // el binding y echa al invitado antes de admitirlo.
    await this.armAudioTap(page);

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
              undefined,
              false,
            )
            .catch(() => undefined);
        },
        mute: async () => {
          await evaluateInMain(page, 'window.__cortexVoice && window.__cortexVoice.mute()').catch(
            () => undefined,
          );
        },
        unmute: async () => {
          await evaluateInMain(page, 'window.__cortexVoice && window.__cortexVoice.unmute()').catch(
            () => undefined,
          );
        },
      });
    }
    this.setStatus('live');
    void this.watchAlive(page);
  }

  private async armAudioTap(page: Page): Promise<void> {
    if (!this.context) return;
    await this.context.exposeBinding(
      '__cortexAudioChunk',
      (_src, payload: { b64: string; speaker: string | null }) => {
        this.deepgram?.setSpeaker(payload.speaker);
        if (payload.b64) this.deepgram?.push(Buffer.from(payload.b64, 'base64'));
      },
    );
    await evaluateInMain(page, AUDIO_TAP_SCRIPT).catch(() => undefined);
    await evaluateInMain(page, 'window.__cortexTap && window.__cortexTap.start()').catch(
      () => undefined,
    );
  }

  private async fillGuestName(page: Page): Promise<void> {
    const nameField = page.locator(NAME_FIELD).first();
    const visible = await nameField
      .waitFor({ state: 'visible', timeout: 12_000 })
      .then(() => true)
      .catch(() => false);
    if (!visible) return;
    await nameField.click().catch(() => undefined);
    await nameField.fill('').catch(() => undefined);
    await nameField
      .pressSequentially(this.botName, { delay: 70 + Math.random() * 50 })
      .catch(() => undefined);
  }

  private async dismissInterstitials(page: Page): Promise<void> {
    for (const label of DISMISS_BUTTONS) {
      const btn = page.getByRole('button', { name: label }).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click({ timeout: 1_500 }).catch(() => undefined);
        await humanPause(300, 700);
      }
    }
  }

  private async watchAlive(page: Page): Promise<void> {
    while (this.status === 'live') {
      await page.waitForTimeout(5_000);
      const alive = await page
        .locator(LEAVE_BUTTON)
        .first()
        .isVisible()
        .catch(() => false);
      const screen = await this.peek(page);
      if (!alive || looksKicked(screen)) {
        this.setStatus(
          'ended',
          looksKicked(screen)
            ? `Google nos sacó de la llamada. Pantalla: ${screen}`
            : 'La reunión terminó o el bot salió.',
        );
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
    if (this.config.mode === 'guest') {
      try {
        const { rmSync } = await import('node:fs');
        rmSync(`${this.config.profilesDir}/guest_${this.id}`, { recursive: true, force: true });
      } catch {
        // Un perfil que no se pudo borrar lo barre el próximo arranque.
      }
    }
  }
}
