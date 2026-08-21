import WebSocket from 'ws';

/**
 * ESCUCHAR: PCM linear16 16 kHz de la sala → texto, en vivo, por Deepgram.
 *
 * PCM en vez de WebM: cada frame es autónomo, Deepgram no espera un cluster,
 * y un socket que se reabre no pierde el resto de la reunión. Los parciales
 * llegan a ritmo de conversación; los finales, al callar ~300 ms.
 *
 * Quién habló lo pinta Meet en el DOM (audio-tap.ts), no la diarización.
 */

export interface Transcript {
  text: string;
  isFinal: boolean;
  speaker: string | null;
  /** Segundos desde que abrió la conexión, para ordenar la cronología. */
  at: number;
}

export class DeepgramStream {
  private ws: WebSocket | null = null;
  private openedAt = 0;
  private lastSpeaker: string | null = null;
  private queue: Buffer[] = [];
  private closing = false;
  private keepAlive: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly language: string,
    private readonly onTranscript: (t: Transcript) => void,
  ) {}

  start(): void {
    const params = new URLSearchParams({
      model: 'nova-2',
      language: this.language,
      punctuate: 'true',
      interim_results: 'true',
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      endpointing: '300',
    });
    const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
      headers: { Authorization: `Token ${this.apiKey}` },
    });
    this.ws = ws;
    this.openedAt = Date.now();

    ws.on('open', () => {
      console.log('[cortex-meet] deepgram socket abierto');
      for (const chunk of this.queue) ws.send(chunk);
      this.queue = [];
      this.keepAlive = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'KeepAlive' }));
        }
      }, 8_000);
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          type?: string;
          message?: string;
          channel?: { alternatives?: Array<{ transcript?: string }> };
          is_final?: boolean;
        };
        if (msg.type === 'error') {
          console.error(`[cortex-meet] deepgram: ${msg.message || msg.type}`);
          return;
        }
        const text = msg.channel?.alternatives?.[0]?.transcript?.trim();
        if (!text) return;
        this.onTranscript({
          text,
          isFinal: Boolean(msg.is_final),
          speaker: this.lastSpeaker,
          at: (Date.now() - this.openedAt) / 1000,
        });
      } catch {
        // Un frame no-JSON (keepalive) no es un evento.
      }
    });

    ws.on('error', (err) => {
      console.error(`[cortex-meet] deepgram error: ${err.message}`);
    });
    ws.on('close', (code, reason) => {
      console.log(`[cortex-meet] deepgram cerrado ${code} ${reason.toString()}`);
      if (this.keepAlive) {
        clearInterval(this.keepAlive);
        this.keepAlive = null;
      }
      this.ws = null;
      if (!this.closing) {
        setTimeout(() => {
          if (!this.closing) this.start();
        }, 500);
      }
    });
  }

  setSpeaker(name: string | null): void {
    if (name) this.lastSpeaker = name;
  }

  push(chunk: Buffer): void {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(chunk);
    else if (this.queue.length < 400) this.queue.push(chunk);
  }

  async stop(): Promise<void> {
    this.closing = true;
    if (this.keepAlive) {
      clearInterval(this.keepAlive);
      this.keepAlive = null;
    }
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'CloseStream' }));
      await new Promise((r) => setTimeout(r, 300));
      ws.close();
    }
  }
}
