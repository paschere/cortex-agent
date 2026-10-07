import { figuresForTts } from '@/lib/voice-figures';

/**
 * LA VOZ DE CORTEX, COMO FUNCIÓN. Lo que antes sólo vivía dentro del modo voz
 * del chat (/api/voice/turn: planes con voz y voz de Deepgram Aura) se
 * comparte aquí para que lo use también /api/voice/speak, que lee una frase
 * suelta (el asistente de voz de los formularios).
 */

export const VOICE_PLANS = new Set(
  (process.env.VOICE_PLANS || process.env.MEET_VOICE_PLANS || 'business,enterprise').split(','),
);

export const TTS_VOICE = process.env.VOICE_TTS_VOICE || 'aura-2-celeste-es';

/** Una frase hablada: más que esto ya no es una pregunta de formulario. */
export const SPEAK_MAX_CHARS = 400;

/** La frase en mp3 con Deepgram Aura (REST). Null si no hay llave o falló. */
export async function synthesizeSpeech(
  text: string,
  opts: { signal?: AbortSignal } = {},
): Promise<ArrayBuffer | null> {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) return null;
  const res = await fetch(
    `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(TTS_VOICE)}&encoding=mp3`,
    {
      method: 'POST',
      headers: { Authorization: `Token ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: figuresForTts(text.slice(0, SPEAK_MAX_CHARS)) }),
      signal: AbortSignal.any([...(opts.signal ? [opts.signal] : []), AbortSignal.timeout(10_000)]),
    },
  ).catch(() => null);
  if (!res?.ok) return null;
  return res.arrayBuffer();
}
