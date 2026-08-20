/**
 * HABLAR: texto → voz, por Deepgram (API v2 /speak, modelos Flux).
 *
 * Un solo proveedor para oír y hablar (Aura/Flux STT+TTS, más barato que
 * ElevenLabs y una sola llave). La v2 devuelve audio ya codificado; se pide
 * mp3 porque el navegador lo decodifica con `decodeAudioData` sin que nadie
 * arme un PCM a mano (voice-inject.ts), y porque es lo que el ejemplo del
 * dueño usa:
 *
 *     POST https://api.deepgram.com/v2/speak?model=flux-hannah-en&speed=1
 *
 * La voz se elige por variable (MEET_TTS_VOICE). El default es un modelo Flux;
 * para reuniones en español, ponle un modelo Flux en español. La velocidad es
 * ajustable (MEET_TTS_SPEED) — 1 es natural.
 */

const DEFAULT_VOICE = process.env.MEET_TTS_VOICE || 'aura-2-celeste-es';
const DEFAULT_SPEED = process.env.MEET_TTS_SPEED || '1';

export async function synthesize(
  apiKey: string,
  text: string,
  voice = DEFAULT_VOICE,
): Promise<{ mp3: Buffer } | null> {
  const params = new URLSearchParams({ model: voice, speed: DEFAULT_SPEED });
  try {
    const res = await fetch(`https://api.deepgram.com/v1/speak?${params}`, {
      method: 'POST',
      headers: { Authorization: `Token ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const mp3 = Buffer.from(await res.arrayBuffer());
    return { mp3 };
  } catch {
    return null;
  }
}
