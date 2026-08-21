import type { Config } from './config';
import type { Transcript } from './deepgram';
import { synthesize } from './tts';

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

const NAME_TRIGGER =
  /^\s*(oye,?\s+|hey,?\s+|ok,?\s+|ey,?\s+|eh,?\s+)?(c[oó]rtex|coartex|kortex|korteks)[\s,:.\-!]*/i;

export interface VoiceDeps {
  config: Config;
  /** Reproduce el mp3 en el micro de la reunión (voice-inject en la página). */
  speak: (mp3B64: string) => Promise<void>;
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
    if (!NAME_TRIGGER.test(line.text)) return;
    this.busy = true;
    console.log(`[cortex-meet] voice trigger «${line.text}»`);
    try {
      const question =
        line.text.replace(NAME_TRIGGER, '').trim() ||
        'Te nombraron en la reunión. Pregunta si te necesitan y ofrece ayuda en una frase.';
      const answer = await this.askCortex(question);
      if (!answer) return;
      await this.deps.unmute();
      const speech = await synthesize(this.deps.config.deepgramKey, answer);
      if (!speech) {
        console.error('[cortex-meet] TTS no devolvió audio');
        return;
      }
      await this.deps.speak(speech.mp3.toString('base64'));
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
      const speech = await synthesize(this.deps.config.deepgramKey, line);
      if (!speech) {
        console.error('[cortex-meet] TTS no devolvió audio');
        return false;
      }
      await this.deps.speak(speech.mp3.toString('base64'));
      return true;
    } catch (err) {
      console.error(`[cortex-meet] speakText failed: ${(err as Error).message}`);
      return false;
    } finally {
      this.busy = false;
    }
  }

  /**
   * Le pide a Cortex la respuesta hablada. Cortex tiene el modelo y el cerebro;
   * este endpoint devuelve texto corto pensado para decirse en voz alta.
   * Autenticado con el token de servicio — es una llamada de infraestructura,
   * no de un usuario.
   */
  private async askCortex(question: string): Promise<string | null> {
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
          },
          body: JSON.stringify({
            owner: this.owner,
            sessionId: this.sessionId,
            question,
            transcript: tail,
          }),
          // Margen para un turno REAL: voice-answer corre el cerebro con
          // herramientas (maxDuration 45s del lado de Cortex). Un turno con una
          // consulta al CRM o un envío pasa de 20s; cortarlo ahí dejaba a Cortex
          // mudo justo cuando de verdad fue a hacer algo. 40s deja terminar sin
          // colgar la reunión para siempre.
          signal: AbortSignal.timeout(40_000),
        },
      );
      if (!res.ok) {
        console.error(`[cortex-meet] voice-answer HTTP ${res.status} ${res.url}`);
        return null;
      }
      const data = (await res.json()) as { answer?: string };
      return data.answer?.trim() || null;
    } catch (err) {
      console.error(`[cortex-meet] voice-answer failed: ${(err as Error).message}`);
      return null;
    }
  }
}
