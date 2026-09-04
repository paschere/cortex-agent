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
 * siempre. Cortex habla SOLO cuando lo nombran, nunca por iniciativa propia,
 * y una a la vez. El primer «Cortex» no es la pregunta completa: Deepgram
 * corta al callar ~800 ms («Cortex, podrías averiguar» / silencio / «cuánto
 * le cotizamos»). Se junta lo que sigue del mismo hablante y se espera a
 * que deje de hablar ANTES de abrir la boca.
 *
 * Dos clases de turno, no una:
 *   - Chitchat («hola», «me oyes»): responde ya, sin mano.
 *   - Sala en silencio (aunque haya diez personas): habla. Nadie tiene el
 *     turno; alzar la mano y esperar «adelante» es quedarse mudo frente a
 *     una sala que ya le está dando la palabra.
 *   - Alguien más sigue hablando: levanta la mano EN SILENCIO y espera
 *     «adelante» o a que se haga silencio. No dice «ahora lo busco» encima.
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
 * Saludos y «¿me oyes?» no necesitan tools ni mano. Una pregunta a medias
 * («podrías averiguar») NO es chitchat: el largo corto ya no cuenta.
 */
export function looksLikeVoiceChitchat(question: string): boolean {
  const q = foldSpoken(question)
    .replace(/\bpor favor\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!q) return true;
  return /^(hola|buenas(?: noches| tardes| dias)?|buenos dias|que tal|como estas(?: tu| vos)?|como le va|puedes hablar|me escuchas|me oyes|estas ahi|hey|hi|hello|gracias(?: mil)?|thank you|thanks|perfecto|listo|vale)$/.test(
    q,
  );
}

const HANGING_TAIL =
  /\b(podrias|podria|puedes|puede|quisiera|quiero|necesito|averiguar|buscar|revisar|mirar|checar|decirme|contarme|explicar|si|de|para|por|con|a|y|o|que|como|cuanto|cual|quien|cuando|donde|el|la|los|las|un|una|me|le|nos|te)$/;

/** La frase se cortó a mitad: «Cortex, podrías averiguar» todavía no es la pregunta. */
export function looksLikeIncompleteQuestion(question: string): boolean {
  const q = foldSpoken(question);
  if (!q) return true;
  if (looksLikeVoiceChitchat(question)) return false;
  if (HANGING_TAIL.test(q)) return true;
  const trimmed = question.trim();
  if (/[,;:]$/.test(trimmed)) return true;
  if (!/[.!?…]$/.test(trimmed) && q.split(/\s+/).length <= 4) return true;
  return false;
}

export function joinUtterances(parts: string[]): string {
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ');
}

function sameSpeaker(a: string | null, b: string | null): boolean {
  if (!a || !b) return true;
  return a === b;
}

/** Chitchat: corto. Pregunta incompleta: más aire. Pregunta cerrada: un respiro. */
export const CHITCHAT_GATHER_MS = 700;
export const INCOMPLETE_GATHER_MS = 2_500;
export const COMPLETE_GATHER_MS = 1_400;
export const EMPTY_GATHER_MS = 4_000;
export const QUESTION_MAX_GATHER_MS = 10_000;

export function questionGatherMs(question: string): number {
  if (!foldSpoken(question)) return EMPTY_GATHER_MS;
  if (looksLikeIncompleteQuestion(question)) return INCOMPLETE_GATHER_MS;
  if (looksLikeVoiceChitchat(question)) return CHITCHAT_GATHER_MS;
  return COMPLETE_GATHER_MS;
}

export type FloorState = {
  /** Alguien que no es el que preguntó ni Cortex tiene el turno ahora. */
  someoneElseSpeaking: boolean;
};

/**
 * Mano alzada solo si el turno pide trabajo Y alguien más tiene la palabra.
 * El tamaño de la sala no cuenta: un grupo callado ya le dio el turno.
 */
export function shouldRaiseHand(question: string, floor: FloorState | number = { someoneElseSpeaking: false }): boolean {
  if (looksLikeVoiceChitchat(question)) return false;
  if (typeof floor === 'number') return false;
  return floor.someoneElseSpeaking === true;
}

export function samePerson(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = foldSpoken(a);
  const y = foldSpoken(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length >= 4 && y.includes(x)) return true;
  if (y.length >= 4 && x.includes(y)) return true;
  return false;
}

export function someoneElseSpeakingOnRoster(
  roster: Array<{ name: string; speaking?: boolean; self?: boolean }>,
  asker?: string | null,
  botName = 'Cortex',
): boolean {
  return roster.some((p) => {
    if (p.self || !p.speaking) return false;
    if (isBotSpeaker(p.name, botName)) return false;
    if (samePerson(p.name, asker)) return false;
    return true;
  });
}

/** Mientras la mano está alzada: ¿sigue habiendo voz humana en la sala? */
export function roomHasHumanSpeech(
  roster: Array<{ name: string; speaking?: boolean; self?: boolean }>,
  botName = 'Cortex',
): boolean {
  return roster.some((p) => p.speaking && !p.self && !isBotSpeaker(p.name, botName));
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

/** Cuánto espera Cortex con la mano alzada a que le den el turno. */
export const FLOOR_WAIT_MS = 90_000;
/** Silencio seguido, con la mano alzada, se toma como el turno. */
export const FLOOR_SILENCE_MS = 1_600;

/**
 * «Sí, adelante Cortex», «te escuchamos», «go ahead». Solo se usa cuando
 * Cortex YA pidió la palabra: un «sí» suelto no abre un turno nuevo.
 *
 * Las fronteras `\b` de JS no tratan `í` como letra: «Sí, Cortex» (lo que
 * Deepgram oyó el 21-08 cuando se dijo «adelante Cortex») NO hacía match.
 * Se pliegan acentos y se corta por espacios.
 */
export function looksLikeFloorGrant(text: string, botName = 'Cortex'): boolean {
  const q = foldSpoken(text);
  if (!q) return false;
  const name = foldSpoken(botName);
  const named =
    (name.length >= 2 && q.includes(name)) ||
    /\b(cortex|coartex|kortex|korteks)\b/.test(q);
  const tokens = ` ${q} `;
  if (
    / (adelante|go ahead|te escuchamos|tiene la palabra|tienes la palabra|the floor|when youre ready|puedes hablar|puedes decir|puedes contar|cuentanos|cuenta pues|you can speak|you can talk|you can go|youre up|youre on) /.test(
      tokens,
    )
  ) {
    return true;
  }
  if (named && / (si|ok|okay|listo|claro|dale|dime|yes|go|speak|talk|escuchamos|adelante) /.test(tokens)) {
    return true;
  }
  return false;
}

export function normalizeSpoken(text: string): string {
  return text
    .toLowerCase()
    .replace(/[¿?¡!.,…;:"“”«»]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Minúsculas, sin tildes: para que «sí» y «si» cuenten igual. */
export function foldSpoken(text: string): string {
  return normalizeSpoken(text)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[''`´]/g, '');
}

export function isBotSpeaker(speaker: string | null, botName: string): boolean {
  if (!speaker) return false;
  const a = speaker.trim().toLowerCase();
  const b = botName.trim().toLowerCase();
  if (b.length < 2) return false;
  return a === b || a.includes(b);
}

export function isEchoOfBot(heard: string, said: string): boolean {
  const a = normalizeSpoken(heard);
  const b = normalizeSpoken(said);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 8 && b.includes(a)) return true;
  if (b.length >= 8 && a.includes(b)) return true;
  return false;
}

export interface VoiceDeps {
  config: Config;
  botName?: string;
  /** Reproduce el wav completo (fallback si el WS de TTS no abre). */
  speak: (mp3B64: string) => Promise<void>;
  beginSpeak?: () => Promise<void>;
  pushPcm?: (b64: string, sampleRate: number) => Promise<void>;
  endSpeak?: () => Promise<void>;
  mute: () => Promise<void>;
  unmute: () => Promise<void>;
  raiseHand?: () => Promise<void>;
  lowerHand?: () => Promise<void>;
  /** Humanos en la sala, sin contar a Cortex. */
  othersInCall?: () => number;
  /**
   * ¿Hay alguien hablando que no sea `except` ni Cortex? El mosaico de Meet
   * (`speaking`) es la señal; except es quien acaba de preguntar.
   */
  someoneElseSpeaking?: (except?: string | null) => boolean;
  /** Cualquier humano con el tile en «hablando», para soltar la mano en silencio. */
  roomSpeaking?: () => boolean;
  /** Una línea que Cortex acaba de decir, para el transcript (no pasa por STT). */
  onSpoken?: (text: string) => void;
  /** La cola reciente del transcript, para dársela a Cortex como contexto. */
  recentTranscript: () => Transcript[];
}

export class VoiceBrain {
  private busy = false;
  private muted = false;
  private waitingFloor = false;
  private floorWaiter: ((granted: boolean) => void) | null = null;
  private collecting: {
    speaker: string | null;
    parts: string[];
    timer: ReturnType<typeof setTimeout> | null;
    startedAt: number;
    floorBusy: boolean;
  } | null = null;

  constructor(
    private readonly owner: string,
    private readonly sessionId: string,
    private readonly deps: VoiceDeps,
  ) {}

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) this.cancelCollect();
    void (muted ? this.deps.mute() : this.deps.unmute());
  }

  /** Parciales: el hablante sigue, no dispares todavía. */
  onInterim(line: Transcript): void {
    if (this.muted || this.busy || this.waitingFloor) return;
    if (!this.collecting) return;
    if (!sameSpeaker(this.collecting.speaker, line.speaker)) {
      this.collecting.floorBusy = true;
      return;
    }
    this.armFlush();
  }

  /** Se llama con cada frase FINAL. Junta la pregunta; no habla a mitad. */
  onFinalLine(line: Transcript): void {
    if (this.muted) return;
    if (this.waitingFloor) {
      if (looksLikeFloorGrant(line.text, this.deps.botName || 'Cortex')) {
        console.log(`[cortex-meet] floor grant «${line.text}»`);
        this.grantFloor(true);
      } else {
        console.log(`[cortex-meet] floor wait heard «${line.text}»`);
      }
      return;
    }
    if (this.busy) return;
    if (this.collecting) {
      if (!sameSpeaker(this.collecting.speaker, line.speaker)) {
        this.collecting.floorBusy = true;
        return;
      }
      this.collecting.parts.push(line.text);
      console.log(`[cortex-meet] voice gather +«${line.text.slice(0, 80)}»`);
      this.armFlush();
      return;
    }
    if (extractQuestion(line.text) === null) return;
    this.collecting = {
      speaker: line.speaker,
      parts: [line.text],
      timer: null,
      startedAt: Date.now(),
      floorBusy: false,
    };
    console.log(`[cortex-meet] voice gather «${line.text.slice(0, 80)}»`);
    this.armFlush();
  }

  private cancelCollect(): void {
    if (!this.collecting) return;
    if (this.collecting.timer) clearTimeout(this.collecting.timer);
    this.collecting = null;
  }

  private armFlush(): void {
    const bag = this.collecting;
    if (!bag) return;
    if (bag.timer) clearTimeout(bag.timer);
    const joined = joinUtterances(bag.parts);
    const extracted = extractQuestion(joined) ?? '';
    const idle = questionGatherMs(extracted);
    const elapsed = Date.now() - bag.startedAt;
    const remaining = Math.max(0, QUESTION_MAX_GATHER_MS - elapsed);
    const wait = Math.min(idle, remaining || idle);
    bag.timer = setTimeout(() => void this.flushQuestion(), wait);
  }

  private async flushQuestion(): Promise<void> {
    const bag = this.collecting;
    if (!bag || this.busy) return;
    if (bag.timer) clearTimeout(bag.timer);
    this.collecting = null;
    const joined = joinUtterances(bag.parts);
    const extracted = extractQuestion(joined);
    if (extracted === null) return;
    await this.runTurn(joined, extracted, bag.speaker, bag.floorBusy);
  }

  private floorBusyNow(asker: string | null, heardOther: boolean): boolean {
    if (heardOther) return true;
    if (this.deps.someoneElseSpeaking) return this.deps.someoneElseSpeaking(asker);
    return false;
  }

  private async runTurn(
    joined: string,
    extracted: string,
    asker: string | null,
    heardOther: boolean,
  ): Promise<void> {
    this.busy = true;
    const t0 = Date.now();
    console.log(`[cortex-meet] voice trigger «${joined}»`);
    let handUp = false;
    try {
      const question =
        extracted ||
        'Te nombraron en la reunión. Pregunta si te necesitan y ofrece ayuda en una frase.';
      const quick = looksLikeVoiceChitchat(extracted);
      const others = this.deps.othersInCall?.() ?? 0;
      let raiseHand = shouldRaiseHand(extracted, {
        someoneElseSpeaking: this.floorBusyNow(asker, heardOther),
      });
      const clauses = this.startCortexStream(question, quick);
      const thinkAt = Date.now();
      console.log(
        `[cortex-meet] voice turn ${JSON.stringify({ quick, raiseHand, others, asker, heardOther })}`,
      );
      if (raiseHand) {
        await this.deps.raiseHand?.();
        handUp = true;
        const granted = await this.waitForFloor(FLOOR_WAIT_MS);
        console.log(`[cortex-meet] floor ${granted ? 'granted' : 'timeout-or-quiet'}`);
        await this.deps.unmute();
        if (granted) await new Promise((r) => setTimeout(r, 400));
      } else {
        if (!quick && this.floorBusyNow(asker, false)) {
          raiseHand = true;
          await this.deps.raiseHand?.();
          handUp = true;
          const granted = await this.waitForFloor(FLOOR_WAIT_MS);
          console.log(`[cortex-meet] floor late ${granted ? 'granted' : 'timeout-or-quiet'}`);
          await this.deps.unmute();
        } else {
          await this.deps.unmute();
          if (!quick) {
            const hold = pickHoldLine();
            console.log(`[cortex-meet] voice hold «${hold}»`);
            await this.speakAnswer(hold);
          }
        }
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
          raiseHand,
        })}`,
      );
    } catch (err) {
      console.error(`[cortex-meet] voice turn failed: ${(err as Error).message}`);
    } finally {
      if (handUp) await this.deps.lowerHand?.().catch(() => undefined);
      this.grantFloor(false);
      this.busy = false;
    }
  }

  private grantFloor(granted: boolean): void {
    this.waitingFloor = false;
    const w = this.floorWaiter;
    this.floorWaiter = null;
    w?.(granted);
  }

  private waitForFloor(ms: number): Promise<boolean> {
    this.waitingFloor = true;
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.grantFloor(false), ms);
      let quietSince: number | null = null;
      const poll = setInterval(() => {
        const busy = this.deps.roomSpeaking?.() ?? this.deps.someoneElseSpeaking?.() ?? false;
        if (busy) {
          quietSince = null;
          return;
        }
        quietSince ??= Date.now();
        if (Date.now() - quietSince >= FLOOR_SILENCE_MS) {
          this.grantFloor(true);
        }
      }, 250);
      this.floorWaiter = (granted) => {
        clearTimeout(timer);
        clearInterval(poll);
        resolve(granted);
      };
    });
  }

  /** Una frase pedida desde el chat, no desde el nombre en la sala. */
  async speakText(text: string): Promise<boolean> {
    const line = text.trim();
    if (!line || this.busy) return false;
    this.cancelCollect();
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
    record = true,
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
        if (record) this.deps.onSpoken?.(text.trim());
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
    if (record) this.deps.onSpoken?.(text.trim());
    return { bytes: speech.mp3.length, firstMs, stream: false };
  }

  private async speakClauses(
    clauses: AsyncIterable<string>,
  ): Promise<{ bytes: number; firstMs: number | null; stream: boolean; clauses: number }> {
    const t0 = Date.now();
    let firstMs: number | null = null;
    let n = 0;
    const note = (line: string) => this.deps.onSpoken?.(line);
    const counted: AsyncIterable<string> = (async function* () {
      for await (const c of clauses) {
        const line = c.trim();
        if (!line) continue;
        n += 1;
        console.log(`[cortex-meet] voice clause «${line.slice(0, 80)}»`);
        note(line);
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
    if (!parts.length) return { bytes: 0, firstMs: null, stream: false, clauses: n };
    const rest = await this.speakAnswer(parts.join(' '), false);
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
          signal: AbortSignal.timeout(quick ? 40_000 : 90_000),
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
