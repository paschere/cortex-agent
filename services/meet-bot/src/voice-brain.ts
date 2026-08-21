import type { Config } from './config';
import type { Transcript } from './deepgram';
import { streamSpeak, streamSpeakClauses, synthesize, TTS_SAMPLE_RATE } from './tts';
import { AsyncQueue, readVoiceAnswerStream } from './voice-stream';

/**
 * CUÁNDO HABLA CORTEX, Y CON QUÉ CABEZA.
 *
 * ===========================================================================
 * LA REGLA SOCIAL ES LA FEATURE
 * ===========================================================================
 * Un bot que interrumpe una reunión una sola vez queda desinstalado para
 * siempre. Así que Cortex habla SOLO cuando lo nombran («Cortex, …») en una
 * frase FINAL del transcript, nunca por iniciativa propia, y una a la vez (no
 * se pisa). El disparador es deliberadamente estrecho: el nombre al principio
 * de la frase, o «oye/hey Cortex». Un «…y Cortex nos ayudó con eso» no lo
 * activa, porque no le están hablando A él.
 *
 * ===========================================================================
 * LA RESPUESTA LA PIENSA CORTEX, NO ESTE PROCESO
 * ===========================================================================
 * Este servicio no tiene el modelo ni el cerebro de la empresa — los tiene
 * Cortex. Así que al detectar el nombre, se le manda a Cortex la pregunta con
 * la cola del transcript, y Cortex devuelve el TEXTO de la respuesta (con su
 * modelo, sus fuentes, su tono). Este proceso solo lo convierte en voz
 * (Deepgram Aura) y lo mete al micrófono. Quien sabe, responde; quien tiene la
 * boca, habla.
 *
 * ===========================================================================
 * DETRÁS DE UN FLAG
 * ===========================================================================
 * `voiceEnabled` lo decide Cortex por reunión (y en el futuro, por plan). Sin
 * él, todo esto duerme: el bot escucha y no habla. La voz es premium; el
 * silencio es el default seguro.
 */

/**
 * El nombre en CUALQUIER parte de la frase, no solo al inicio: en una reunión
 * real se dice «entonces, Cortex, ¿cuánto le cotizamos?» o «¿qué opinas,
 * Cortex?». Lo que va después del nombre es la pregunta; si el nombre cierra
 * la frase, la pregunta es la frase entera.
 */
const NAME_TRIGGER =
  /(?:^|[\s,;:¿¡"(])(?:oye,?\s+|hey,?\s+|ok,?\s+|ey,?\s+|eh,?\s+)?(c[oó]rtex|coartex|kortex|korteks|córtex)\b[\s,:.\-!?¿¡]*/i;

export function extractQuestion(text: string): string | null {
  const m = NAME_TRIGGER.exec(text);
  if (!m) return null;
  const after = text.slice(m.index + m[0].length).trim();
  const before = text.slice(0, m.index).trim();
  if (after.length >= 3) return after;
  return before.length >= 3 ? before : '';
}

/**
 * Saludos y «¿me oyes?» no necesitan el catálogo de tools: con tools, Sonnet
 * se queda mirando 80 funciones antes de decir «hola». Una pregunta de negocio
 * («cuánto le cotizamos») no entra aquí.
 */
export function looksLikeVoiceChitchat(question: string): boolean {
  const q = question
    .trim()
    .toLowerCase()
    .replace(/[¿?¡!.,…]/g, ' ')
    .replace(/\bpor favor\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (q.length < 12) return true;
  return /^(hola|buenas(?: noches| tardes| d[ií]as)?|buen[oa]s?\s*(d[ií]as|tardes|noches)?|qu[eé] tal|c[oó]mo est[aá]s(?: t[uú]| vos)?|c[oó]mo le va|puedes hablar|me escuchas|est[aá]s ah[ií]|hey|hi|hello|gracias)$/.test(
    q,
  );
}

/** Frases cortas mientras Cortex piensa un turno que sí pide tools. */
export const HOLD_LINES = [
  'Dame un minuto.',
  'Un segundo, lo miro.',
  'Ya voy, un momentico.',
  'Déjame revisar.',
  'Ahora lo busco.',
  'Permíteme un segundo.',
  'Dale, lo checo.',
] as const;

let lastHold = -1;

export function pickHoldLine(random: () => number = Math.random): string {
  let i = Math.floor(random() * HOLD_LINES.length);
  if (i === lastHold) i = (i + 1) % HOLD_LINES.length;
  lastHold = i;
  return HOLD_LINES[i] ?? 'Dame un minuto.';
}

export interface VoiceDeps {
  config: Config;
  /** Reproduce el wav completo (fallback si el WS de TTS no abre). */
  speak: (mp3B64: string) => Promise<void>;
  beginSpeak?: () => Promise<void>;
  pushPcm?: (b64: string, sampleRate: number) => Promise<void>;
  endSpeak?: () => Promise<void>;
  mute: () => Promise<void>;
  unmute: () => Promise<void>;
  /** La cola reciente del transcript, para dársela a Cortex como contexto. */
  recentTranscript: () => Transcript[];
}

export class VoiceBrain {
  private busy = false;
  private muted = false;

  constructor(
    private readonly owner: string,
    private readonly sessionId: string,
    private readonly deps: VoiceDeps,
  ) {}

  setMuted(muted: boolean): void {
    this.muted = muted;
    void (muted ? this.deps.mute() : this.deps.unmute());
  }

  /** Se llama con cada frase FINAL. Decide si le hablaron a Cortex. */
  async onFinalLine(line: Transcript): Promise<void> {
    if (this.muted || this.busy) return;
    const extracted = extractQuestion(line.text);
    if (extracted === null) return;
    this.busy = true;
    const t0 = Date.now();
    console.log(`[cortex-meet] voice trigger «${line.text}»`);
    try {
      const question =
        extracted ||
        'Te nombraron en la reunión. Pregunta si te necesitan y ofrece ayuda en una frase.';
      const quick = looksLikeVoiceChitchat(extracted);
      // El cerebro empieza YA: mientras suena el hold, van llegando cláusulas.
      const clauses = this.startCortexStream(question, quick);
      const unmuteP = this.deps.unmute();
      const thinkAt = Date.now();
      if (!quick) {
        await unmuteP;
        const hold = pickHoldLine();
        console.log(`[cortex-meet] voice hold «${hold}»`);
        await this.speakAnswer(hold);
      } else {
        await unmuteP;
      }
      const spoken = await this.speakClauses(clauses);
      const thinkMs = Date.now() - thinkAt;
      if (spoken.bytes === 0 && spoken.clauses === 0) {
        console.error('[cortex-meet] voice-answer sin texto: Cortex no dijo nada');
        await this.speakAnswer('Aquí estoy. ¿En qué te ayudo?');
        return;
      }
      console.log(
        `[cortex-meet] voice timing ${JSON.stringify({
          thinkMs,
          ttsFirstMs: spoken.firstMs,
          ttsBytes: spoken.bytes,
          clauses: spoken.clauses,
          totalMs: Date.now() - t0,
          stream: spoken.stream,
        })}`,
      );
    } catch (err) {
      console.error(`[cortex-meet] voice turn failed: ${(err as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  /** Una frase pedida desde el chat, no desde el nombre en la sala. */
  async speakText(text: string): Promise<boolean> {
    const line = text.trim();
    if (!line || this.busy) return false;
    this.busy = true;
    this.muted = false;
    try {
      await this.deps.unmute();
      const spoken = await this.speakAnswer(line);
      return spoken.bytes > 0;
    } catch (err) {
      console.error(`[cortex-meet] speakText failed: ${(err as Error).message}`);
      return false;
    } finally {
      this.busy = false;
    }
  }

  private async speakAnswer(
    text: string,
  ): Promise<{ bytes: number; firstMs: number | null; stream: boolean }> {
    const t0 = Date.now();
    let firstMs: number | null = null;
    if (this.deps.pushPcm && this.deps.beginSpeak && this.deps.endSpeak) {
      await this.deps.beginSpeak();
      const streamed = await streamSpeak(this.deps.config.deepgramKey, text, async (pcm) => {
        if (firstMs === null) firstMs = Date.now() - t0;
        await this.deps.pushPcm!(pcm.toString('base64'), TTS_SAMPLE_RATE);
      });
      await this.deps.endSpeak();
      if (streamed && streamed.bytes > 0) {
        return { bytes: streamed.bytes, firstMs, stream: true };
      }
    }
    const speech = await synthesize(this.deps.config.deepgramKey, text);
    if (!speech) {
      console.error('[cortex-meet] TTS no devolvió audio');
      return { bytes: 0, firstMs: null, stream: false };
    }
    firstMs = Date.now() - t0;
    await this.deps.speak(speech.mp3.toString('base64'));
    return { bytes: speech.mp3.length, firstMs, stream: false };
  }

  private async speakClauses(
    clauses: AsyncIterable<string>,
  ): Promise<{ bytes: number; firstMs: number | null; stream: boolean; clauses: number }> {
    const t0 = Date.now();
    let firstMs: number | null = null;
    let n = 0;
    const counted: AsyncIterable<string> = (async function* () {
      for await (const c of clauses) {
        const line = c.trim();
        if (!line) continue;
        n += 1;
        console.log(`[cortex-meet] voice clause «${line.slice(0, 80)}»`);
        yield line;
      }
    })();
    if (this.deps.pushPcm && this.deps.beginSpeak && this.deps.endSpeak) {
      await this.deps.beginSpeak();
      const streamed = await streamSpeakClauses(
        this.deps.config.deepgramKey,
        counted,
        async (pcm) => {
          if (firstMs === null) firstMs = Date.now() - t0;
          await this.deps.pushPcm!(pcm.toString('base64'), TTS_SAMPLE_RATE);
        },
      );
      await this.deps.endSpeak();
      if (streamed && streamed.bytes > 0) {
        return { bytes: streamed.bytes, firstMs, stream: true, clauses: n };
      }
    }
    const parts: string[] = [];
    for await (const c of counted) parts.push(c);
    if (!parts.length) return { bytes: 0, firstMs: null, stream: false, clauses: 0 };
    const rest = await this.speakAnswer(parts.join(' '));
    return { ...rest, clauses: n || parts.length };
  }

  /**
   * Arranca el POST al cerebro de inmediato y va soltando cláusulas. Si Vercel
   * todavía responde JSON (sin SSE), llega una sola cláusula con la frase entera.
   */
  private startCortexStream(question: string, quick: boolean): AsyncIterable<string> {
    const q = new AsyncQueue<string>();
    void this.fillCortexStream(q, question, quick);
    return q;
  }

  private async fillCortexStream(
    q: AsyncQueue<string>,
    question: string,
    quick: boolean,
  ): Promise<void> {
    const tail = this.deps
      .recentTranscript()
      .slice(-40)
      .map((l) => `${l.speaker ? `${l.speaker}: ` : ''}${l.text}`)
      .join('\n');
    try {
      const res = await fetch(
        `${this.deps.config.cortexBaseUrl.replace(/\/+$/, '')}/api/meetings/live/voice-answer`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.deps.config.serviceToken}`,
            'content-type': 'application/json',
            accept: 'text/event-stream',
          },
          body: JSON.stringify({
            owner: this.owner,
            sessionId: this.sessionId,
            question,
            transcript: tail,
            quick,
          }),
          signal: AbortSignal.timeout(40_000),
        },
      );
      if (!res.ok) {
        console.error(`[cortex-meet] voice-answer HTTP ${res.status} ${res.url}`);
        return;
      }
      for await (const part of readVoiceAnswerStream(res)) q.push(part);
    } catch (err) {
      console.error(`[cortex-meet] voice-answer failed: ${(err as Error).message}`);
    } finally {
      q.close();
    }
  }
}
