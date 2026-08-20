import WebSocket from 'ws';

/**
 * ESCUCHAR: los chunks de audio de la sala → texto, en vivo, por Deepgram.
 *
 * ===========================================================================
 * POR QUÉ UN WEBSOCKET Y NO PETICIONES
 * ===========================================================================
 * Transcribir una reunión mandando el audio en pedazos por HTTP y esperando
 * cada respuesta es escuchar con retraso: cada pedazo paga una ida y vuelta, y
 * las palabras llegan cuando la frase ya pasó. La API de streaming de Deepgram
 * es un WebSocket al que se le empujan los bytes de audio según llegan y que
 * devuelve resultados PARCIALES (mientras la persona habla) y FINALES (cuando
 * cerró la frase). El transcript vivo del chat se pinta con los parciales y se
 * fija con los finales — la misma distinción que un dictado bueno.
 *
 * ===========================================================================
 * EL FORMATO, Y POR QUÉ NO SE TRANSCODIFICA
 * ===========================================================================
 * El tap del navegador ya entrega Opus en contenedor WebM (audio-tap.ts). Se
 * le dice a Deepgram exactamente eso (`encoding` no se fuerza; se manda el
 * contenedor tal cual con `container=webm`), así que nada aquí abre ffmpeg ni
 * re-empaqueta: los bytes que salieron de Chromium entran a Deepgram como
 * están. Un transcodificador de más es latencia y una pieza que se rompe.
 *
 * ===========================================================================
 * QUIÉN HABLÓ
 * ===========================================================================
 * La atribución no viene de Deepgram: viene del DOM de Meet (audio-tap.ts la
 * lee del mosaico del hablante activo) y se adjunta al resultado aquí, con el
 * último hablante conocido cuando el texto se cerró. Es más barato y más fiel
 * que la diarización de audio, porque Meet ya sabe quién tiene el micro.
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

  constructor(
    private readonly apiKey: string,
    private readonly language: string,
    private readonly onTranscript: (t: Transcript) => void,
  ) {}

  start(): void {
    const params = new URLSearchParams({
      model: 'nova-2',
      language: this.language,
      // Puntuación e interim: lo que hace legible un transcript vivo.
      punctuate: 'true',
      interim_results: 'true',
      // El contenedor que el tap ya produce. Sin transcodificar.
      container: 'webm',
      // Cierra una frase tras un silencio corto: así los «finales» caen a
      // ritmo de conversación y los compromisos se extraen en caliente.
      endpointing: '300',
    });
    const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
      headers: { Authorization: `Token ${this.apiKey}` },
    });
    this.ws = ws;
    this.openedAt = Date.now();

    ws.on('open', () => {
      // Lo que se acumuló mientras el socket abría no se pierde.
      for (const chunk of this.queue) ws.send(chunk);
      this.queue = [];
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          channel?: { alternatives?: Array<{ transcript?: string }> };
          is_final?: boolean;
        };
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

    ws.on('error', () => undefined);
    ws.on('close', () => {
      this.ws = null;
      if (!this.closing) {
        // Deepgram cierra sockets ociosos; si la reunión sigue, se reabre.
        setTimeout(() => {
          if (!this.closing) this.start();
        }, 500);
      }
    });
  }

  /** El hablante que el DOM de Meet reporta, para adjuntar al siguiente texto. */
  setSpeaker(name: string | null): void {
    if (name) this.lastSpeaker = name;
  }

  /** Un chunk de audio del tap. Se encola si el socket aún no abrió. */
  push(chunk: Buffer): void {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(chunk);
    else if (this.queue.length < 200) this.queue.push(chunk);
  }

  async stop(): Promise<void> {
    this.closing = true;
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      // El «CloseStream» le dice a Deepgram que emita el último final antes de
      // colgar, en vez de perder la frase a medio decir.
      ws.send(JSON.stringify({ type: 'CloseStream' }));
      await new Promise((r) => setTimeout(r, 300));
      ws.close();
    }
  }
}
