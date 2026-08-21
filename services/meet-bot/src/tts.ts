/**
 * HABLAR: texto → voz, por Deepgram (Aura-2 TTS, endpoint /v1/speak).
 *
 * Un solo proveedor para oír y hablar (Deepgram para STT y TTS: más barato que
 * ElevenLabs y una sola llave). Devuelve audio ya codificado; se pide el
 * contenedor por defecto (mp3/wav) porque el navegador lo decodifica con
 * `decodeAudioData` sin que nadie arme un PCM a mano (voice-inject.ts):
 *
 *     POST https://api.deepgram.com/v1/speak?model=aura-2-celeste-es&speed=1
 *
 * La voz se elige por variable (MEET_TTS_VOICE). El default es `aura-2-celeste-es`,
 * una voz de Aura-2 en español — la que elegimos para las reuniones. La
 * velocidad es ajustable (MEET_TTS_SPEED); 1 es natural.
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
    if (!res.ok) {
      console.error(`[cortex-meet] TTS HTTP ${res.status}`);
      return null;
    }
    const mp3 = Buffer.from(await res.arrayBuffer());
    return { mp3 };
  } catch {
    return null;
  }
}
