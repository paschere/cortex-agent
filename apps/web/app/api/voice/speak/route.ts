import { requireSession } from '@/lib/session';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * LA VOZ DE CORTEX EN LA APP — texto → audio, por Deepgram Aura-2.
 *
 * ===========================================================================
 * QUÉ ES Y QUÉ NO
 * ===========================================================================
 * El modo voz manos-libres (VoiceMode) le pasa aquí lo que Cortex acaba de
 * responder y recibe el audio para reproducirlo. Es el MISMO proveedor y la
 * MISMA voz que el bot de reuniones (aura-2-celeste-es) — un solo Deepgram
 * para toda la casa — pero servido desde la web, sin nada de Meet: ni bot, ni
 * proxy, ni headless. Aquí la voz sale por el parlante de quien está usando la
 * app, no por un micrófono suplantado en una llamada.
 *
 * Pide mp3 explícito: el navegador lo reproduce con `new Audio(blob)` sin que
 * nadie arme PCM. El audio se devuelve tal cual (audio/mpeg), no se guarda:
 * una respuesta hablada es efímera, como el propio sonido.
 */
const Body = z.object({ text: z.string().min(1).max(2_000) });

const VOICE = process.env.VOICE_TTS_VOICE || 'aura-2-celeste-es';
const SPEED = process.env.VOICE_TTS_SPEED || '1';

export async function POST(req: NextRequest) {
  // La sesión autoriza: es la voz de Cortex hablándole a quien tiene sesión
  // abierta, no un endpoint público de síntesis.
  await requireSession();

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Falta el texto a decir.' }, { status: 400 });
  }

  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    // Sin la llave, el modo voz aún funciona en texto; solo no suena. Se dice
    // claro para que no parezca un fallo silencioso.
    return NextResponse.json(
      { error: 'La voz no está configurada en este entorno.' },
      { status: 503 },
    );
  }

  const params = new URLSearchParams({ model: VOICE, speed: SPEED, encoding: 'mp3' });
  try {
    const res = await fetch(`https://api.deepgram.com/v1/speak?${params}`, {
      method: 'POST',
      headers: { Authorization: `Token ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: parsed.data.text }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      return NextResponse.json({ error: 'No pude generar la voz.' }, { status: 502 });
    }
    const audio = Buffer.from(await res.arrayBuffer());
    return new NextResponse(audio, {
      status: 200,
      headers: {
        'content-type': 'audio/mpeg',
        'content-length': String(audio.length),
        'cache-control': 'no-store',
      },
    });
  } catch {
    return NextResponse.json({ error: 'La síntesis de voz tardó demasiado.' }, { status: 504 });
  }
}
