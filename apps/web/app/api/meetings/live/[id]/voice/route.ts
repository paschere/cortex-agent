import { requireSession } from '@/lib/session';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';

/**
 * SILENCIAR (O REACTIVAR) LA VOZ DE CORTEX EN LA REUNIÓN.
 *
 * El botón de la sala en vivo (MeetingLive) manda aquí `{muted}`. No apaga la
 * escucha ni saca al bot — solo calla el micrófono suplantado por el que Cortex
 * habla (voice-inject.ts en el bot): con `muted:true` el nodo de ganancia baja a
 * cero y, aunque lo nombren, no responde de viva voz; el transcript y el chat de
 * la reunión siguen igual. Es el freno de mano para cuando la voz estorba en un
 * momento delicado de la llamada, reversible en un toque.
 *
 * Proxy simple al bot con el token de servicio, como /leave: ambos extremos son
 * nuestros. La sesión de la persona autoriza la acción; el bot confía en el
 * token.
 */
const Body = z.object({ muted: z.boolean() });

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await ctx.params;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Falta indicar si silenciar o no.' }, { status: 400 });
  }

  const base = process.env.MEET_SERVICE_URL?.replace(/\/+$/, '');
  const token = process.env.MEET_SERVICE_TOKEN;
  if (!base || !token) return NextResponse.json({ error: 'no configurado' }, { status: 503 });

  await fetch(`${base}/session/${encodeURIComponent(id)}/voice`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ muted: parsed.data.muted }),
  }).catch(() => undefined);

  return NextResponse.json({ ok: true, muted: parsed.data.muted });
}
