/**
 * HABLAR: texto → voz, por Deepgram Aura-2 sobre WebSocket.
 *
 * Aura no tiene SSML. Las cifras se expanden a español (voice-figures.ts)
 * justo antes de Speak; el transcript se queda con dígitos.
 *
 * El REST `/v1/speak` espera el WAV entero. El WS (`Speak` / `Flush`) emite PCM
 * conforme sintetiza: la primera muestra sale en ~200 ms. Se puede mandar
 * cláusula a cláusula mientras el modelo todavía está generando — no hay que
 * esperar la respuesta completa.
 */

import WebSocket from 'ws';
import { figuresForTts } from './voice-figures';

const DEFAULT_VOICE = process.env.MEET_TTS_VOICE || 'aura-2-celeste-es';
const DEFAULT_SPEED = process.env.MEET_TTS_SPEED || '1';
export const TTS_SAMPLE_RATE = 24_000;

export async function synthesize(
  apiKey: string,
  text: string,
  voice = DEFAULT_VOICE,
): Promise<{ mp3: Buffer } | null> {
  const params = new URLSearchParams({
    model: voice,
    speed: DEFAULT_SPEED,
    encoding: 'linear16',
    sample_rate: String(TTS_SAMPLE_RATE),
    container: 'wav',
  });
  try {
    const res = await fetch(`https://api.deepgram.com/v1/speak?${params}`, {
      method: 'POST',
      headers: { Authorization: `Token ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: figuresForTts(text) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.error(`[cortex-meet] TTS HTTP ${res.status}`);
      return null;
    }
    const mp3 = Buffer.from(await res.arrayBuffer());
    console.log(`[cortex-meet] TTS ok ${mp3.length} bytes`);
    return { mp3 };
  } catch {
    return null;
  }
}

type PcmHandler = (chunk: Buffer) => Promise<void> | void;

/**
 * Un socket Aura vivo: `speak()` mete texto; el PCM llega a `onPcm` en orden.
 * `finish()` hace Flush y espera el último byte.
 */
export class AuraSocket {
  private bytes = 0;
  private pending = Buffer.alloc(0);
  private chain = Promise.resolve();
  private resolveFlush: () => void = () => undefined;
  private flushed = new Promise<void>((r) => {
    this.resolveFlush = r;
  });
  private finishing = false;
  private openFlushes = 0;

  private constructor(
    private readonly ws: WebSocket,
    private readonly onPcm: PcmHandler,
  ) {}

  static async connect(apiKey: string, onPcm: PcmHandler, voice = DEFAULT_VOICE): Promise<AuraSocket | null> {
    const params = new URLSearchParams({
      model: voice,
      encoding: 'linear16',
      sample_rate: String(TTS_SAMPLE_RATE),
      speed: DEFAULT_SPEED,
    });
    const ws = new WebSocket(`wss://api.deepgram.com/v1/speak?${params}`, {
      headers: { Authorization: `Token ${apiKey}` },
    });
    const opened = await new Promise<boolean>((resolve) => {
      ws.on('open', () => resolve(true));
      ws.on('error', () => resolve(false));
      setTimeout(() => resolve(false), 5_000);
    });
    if (!opened) {
      try {
        ws.close();
      } catch {
        /* */
      }
      return null;
    }
    const sock = new AuraSocket(ws, onPcm);
    sock.bind();
    return sock;
  }

  speak(text: string): void {
    const line = figuresForTts(text.trim());
    if (!line || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'Speak', text: line }));
    // Flush por cláusula: si no, Aura a veces no suelta PCM hasta el Flush
    // final — y eso espera a que el modelo termine toda la respuesta.
    this.ws.send(JSON.stringify({ type: 'Flush' }));
    this.openFlushes += 1;
  }

  async finish(): Promise<{ bytes: number }> {
    this.finishing = true;
    if (this.openFlushes === 0 && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'Flush' }));
      this.openFlushes += 1;
    }
    if (this.openFlushes === 0) this.resolveFlush();
    await Promise.race([this.flushed, new Promise<void>((r) => setTimeout(r, 12_000))]);
    try {
      this.ws.send(JSON.stringify({ type: 'Close' }));
    } catch {
      /* */
    }
    try {
      this.ws.close();
    } catch {
      /* */
    }
    await this.chain.catch(() => undefined);
    return { bytes: this.bytes };
  }

  private bind(): void {
    this.ws.on('message', (data, isBinary) => {
      if (isBinary) {
        this.pending = Buffer.concat([this.pending, data as Buffer]);
        const min = this.bytes === 0 ? 2 : 3840;
        if (this.pending.length >= min) {
          const take = this.pending.length - (this.pending.length % 2);
          this.emit(this.pending.subarray(0, take));
          this.pending = this.pending.subarray(take);
        }
        return;
      }
      try {
        const msg = JSON.parse(data.toString()) as { type?: string };
        if (msg.type === 'Flushed') {
          const take = this.pending.length - (this.pending.length % 2);
          if (take > 0) this.emit(this.pending.subarray(0, take));
          this.pending = Buffer.alloc(0);
          this.openFlushes = Math.max(0, this.openFlushes - 1);
          if (this.finishing && this.openFlushes === 0) this.resolveFlush();
        }
      } catch {
        /* */
      }
    });
    this.ws.on('error', () => this.resolveFlush());
    this.ws.on('close', () => this.resolveFlush());
  }

  private emit(buf: Buffer): void {
    if (!buf.length) return;
    this.bytes += buf.length;
    this.chain = this.chain.then(() => this.onPcm(buf));
  }
}

/** Una frase suelta: abre, Speak, Flush, cierra. */
export async function streamSpeak(
  apiKey: string,
  text: string,
  onPcm: PcmHandler,
  voice = DEFAULT_VOICE,
): Promise<{ bytes: number } | null> {
  const line = text.trim();
  if (!line) return null;
  const sock = await AuraSocket.connect(apiKey, onPcm, voice);
  if (!sock) return null;
  sock.speak(line);
  const { bytes } = await sock.finish();
  if (!bytes) return null;
  console.log(`[cortex-meet] TTS stream ${bytes} bytes`);
  return { bytes };
}

/** Cláusulas en vivo: un solo WS, Speak por trozo, Flush al final. */
export async function streamSpeakClauses(
  apiKey: string,
  clauses: AsyncIterable<string>,
  onPcm: PcmHandler,
  voice = DEFAULT_VOICE,
): Promise<{ bytes: number; clauses: number } | null> {
  const sock = await AuraSocket.connect(apiKey, onPcm, voice);
  if (!sock) return null;
  let n = 0;
  for await (const clause of clauses) {
    const line = clause.trim();
    if (!line) continue;
    sock.speak(line);
    n += 1;
  }
  const { bytes } = await sock.finish();
  if (!bytes) return null;
  console.log(`[cortex-meet] TTS stream ${bytes} bytes in ${n} clauses`);
  return { bytes, clauses: n };
}
