import type { CDPSession, Page } from 'playwright';
import type { WebSocket } from 'ws';
import { logger } from './logger';

/**
 * La pestaña, en vivo, en la pantalla de una persona — y sus manos de vuelta.
 *
 * ===========================================================================
 * POR QUÉ CDP CRUDO Y NO SCREENSHOTS EN BUCLE
 * ===========================================================================
 * `page.screenshot()` cada segundo funciona —es lo que la tarjeta usa de
 * respaldo— pero mirar a alguien conducir a un cuadro por segundo es mirar
 * diapositivas. `Page.startScreencast` emite un frame CUANDO ALGO CAMBIÓ y
 * ninguno cuando no, que es exactamente la cadencia de una página: ráfaga al
 * navegar, silencio mientras se lee.
 *
 * LAS DOS TRAMPAS, documentadas porque cuestan una tarde cada una:
 *
 *   1. EL ACK ES OBLIGATORIO. Chromium no emite el frame N+1 hasta recibir
 *      `screencastFrameAck` del frame N. Eso es una feature: es la
 *      contrapresión. El ack se manda cuando el navegador de la persona
 *      confirmó el frame (o tras un plazo, si la conexión se está arrastrando)
 *      — así una pantalla lenta recibe menos frames en vez de una cola de
 *      frames viejos con segundos de retraso.
 *
 *   2. LAS TECLAS NECESITAN `windowsVirtualKeyCode`. Sin él, Enter y
 *      Backspace sencillamente no llegan a la página. El cliente lo manda
 *      (`event.keyCode` sigue existiendo en todos los navegadores para
 *      exactamente esta clase de puente) y aquí solo se reenvía.
 *
 * ===========================================================================
 * UN ESPECTADOR POR SESIÓN
 * ===========================================================================
 * Dos screencasts sobre la misma página duplican el trabajo de encoding y se
 * ahogan mutuamente esperando acks. El que llega reemplaza al que estaba —
 * que es además lo que una reconexión necesita: la pestaña que se recargó no
 * debe quedar bloqueada por el fantasma de su socket anterior.
 *
 * ===========================================================================
 * LO QUE ESTE ARCHIVO NO DECIDE
 * ===========================================================================
 * Si la persona PUEDE conducir no se decide aquí: el dueño de la sesión pasa
 * `mayDrive` y se consulta EN CADA GESTO, no al abrir el socket. Un socket
 * abierto no es permiso (control.ts explica por qué), así que devolver el
 * volante corta el input a mitad de sesión sin cerrar la pantalla.
 */

interface FrameMessage {
  type: 'frame';
  /** JPEG en base64. */
  data: string;
  /** Tamaño del viewport real, para que el cliente mapee sus clicks. */
  width: number;
  height: number;
}

type InboundMessage =
  | { type: 'ack' }
  | {
      type: 'mouse';
      kind: 'mousePressed' | 'mouseReleased' | 'mouseMoved';
      x: number;
      y: number;
      button?: 'left' | 'right' | 'middle' | 'none';
      /** Bitmask CDP de botones apretados (1 = izquierdo). El arrastre es esto. */
      buttons?: number;
      clickCount?: number;
      modifiers?: number;
    }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | {
      type: 'key';
      kind: 'keyDown' | 'keyUp';
      key: string;
      code: string;
      text?: string;
      windowsVirtualKeyCode?: number;
      modifiers?: number;
    }
  | { type: 'text'; text: string }
  | { type: 'nav'; action: 'back' | 'refresh' };

export class Screencast {
  private cdp: CDPSession | null = null;
  private socket: WebSocket | null = null;
  private stopped = false;
  /** El plazo del ack pendiente, para no esperar eternamente a un cliente ido. */
  private ackTimer: NodeJS.Timeout | null = null;
  private pendingCdpAck: number | null = null;

  constructor(
    private readonly page: Page,
    private readonly viewport: { width: number; height: number },
    private readonly mayDrive: () => boolean,
    /**
     * Un gesto humano ES actividad de la sesión: sin esto, alguien resolviendo
     * un captcha con calma vería al barrendero llevarse la pestaña debajo de
     * sus manos, porque mirar no toca (ver peekSession en browser.ts).
     */
    private readonly onGesture: () => void = () => undefined,
  ) {}

  /** Conecta un espectador. El anterior, si lo había, se despide primero. */
  async attach(socket: WebSocket): Promise<void> {
    // El screencast anterior se apaga ENTERO, no solo su socket: un CDP vivo
    // sin espectador seguiría emitiendo frames a nadie y compitiendo por los
    // acks con el que está a punto de nacer.
    await this.stopCdp();
    this.detachSocket();
    this.socket = socket;

    socket.on('message', (raw) => {
      void this.onMessage(raw.toString());
    });
    socket.on('close', () => {
      if (this.socket === socket) void this.stop();
    });
    socket.on('error', () => {
      if (this.socket === socket) void this.stop();
    });

    this.stopped = false;
    const cdp = await this.page.context().newCDPSession(this.page);
    this.cdp = cdp;

    cdp.on('Page.screencastFrame', (frame) => {
      // Se reenvía y se espera el ack del cliente ANTES de ack-ear a Chromium.
      // Si el cliente no contesta en 2s, se ack-ea igual: un espectador lento
      // ve frames más espaciados, pero la pestaña nunca queda congelada
      // esperándolo.
      if (this.ackTimer) clearTimeout(this.ackTimer);
      this.pendingCdpAck = frame.sessionId;
      this.send({
        type: 'frame',
        data: frame.data,
        width: this.viewport.width,
        height: this.viewport.height,
      });
      this.ackTimer = setTimeout(() => this.ackChromium(), 2_000);
    });

    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      // 55 y no 70: en una página (texto, bordes, planos) la diferencia no se
      // ve a tamaño de dock y el frame pesa cerca de la mitad — que es lag de
      // menos en cada uno de los cientos que cruzan una navegación.
      quality: 55,
      maxWidth: this.viewport.width,
      maxHeight: this.viewport.height,
      everyNthFrame: 1,
    });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.stopCdp();
    this.detachSocket();
  }

  private async stopCdp(): Promise<void> {
    if (this.ackTimer) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }
    this.pendingCdpAck = null;
    const cdp = this.cdp;
    this.cdp = null;
    if (cdp) {
      await cdp.send('Page.stopScreencast').catch(() => undefined);
      await cdp.detach().catch(() => undefined);
    }
  }

  private detachSocket(): void {
    const old = this.socket;
    this.socket = null;
    if (old && old.readyState === old.OPEN) {
      old.close(4000, 'replaced');
    }
  }

  private send(message: FrameMessage): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== socket.OPEN) return;
    socket.send(JSON.stringify(message));
  }

  private ackChromium(): void {
    if (this.ackTimer) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }
    const sessionId = this.pendingCdpAck;
    this.pendingCdpAck = null;
    if (sessionId && this.cdp) {
      void this.cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined);
    }
  }

  private async onMessage(raw: string): Promise<void> {
    let message: InboundMessage;
    try {
      message = JSON.parse(raw) as InboundMessage;
    } catch {
      return;
    }

    if (message.type === 'ack') {
      this.ackChromium();
      return;
    }

    // Cada gesto pregunta. No la conexión: el gesto.
    if (!this.mayDrive() || !this.cdp) return;
    this.onGesture();

    const clamp = (v: number, max: number) => Math.max(0, Math.min(Math.round(v || 0), max));

    try {
      if (message.type === 'mouse') {
        await this.cdp.send('Input.dispatchMouseEvent', {
          type: message.kind,
          x: clamp(message.x, this.viewport.width),
          y: clamp(message.y, this.viewport.height),
          button: message.button ?? 'left',
          buttons: message.buttons,
          clickCount: Math.min(message.clickCount ?? 1, 3),
          modifiers: message.modifiers ?? 0,
        });
      } else if (message.type === 'wheel') {
        await this.cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: clamp(message.x, this.viewport.width),
          y: clamp(message.y, this.viewport.height),
          deltaX: message.deltaX || 0,
          deltaY: message.deltaY || 0,
        });
      } else if (message.type === 'key') {
        await this.cdp.send('Input.dispatchKeyEvent', {
          type: message.kind === 'keyDown' && message.text ? 'keyDown' : message.kind,
          key: message.key,
          code: message.code,
          text: message.kind === 'keyDown' ? message.text : undefined,
          windowsVirtualKeyCode: message.windowsVirtualKeyCode,
          nativeVirtualKeyCode: message.windowsVirtualKeyCode,
          modifiers: message.modifiers ?? 0,
        });
      } else if (message.type === 'nav') {
        if (message.action === 'back') {
          await this.page.goBack({ timeout: 10_000, waitUntil: 'domcontentloaded' });
        } else if (message.action === 'refresh') {
          await this.page.reload({ timeout: 15_000, waitUntil: 'domcontentloaded' });
        }
      } else if (message.type === 'text') {
        // Pegar. Un paste de 4000 caracteres tecleado uno a uno tarda y
        // dispara autocompletes; `insertText` es lo que Chromium mismo hace.
        await this.cdp.send('Input.insertText', { text: (message.text ?? '').slice(0, 4_000) });
      }
    } catch (err) {
      // Un gesto que falla (la página navegó justo debajo del click) no es un
      // evento: el siguiente frame ya muestra dónde quedó todo.
      logger.debug?.({ err: (err as Error).message }, 'input gesture failed');
    }
  }
}
