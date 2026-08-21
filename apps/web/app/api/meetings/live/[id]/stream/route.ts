import { requireSession } from '@/lib/session';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * EL TRANSCRIPT EN VIVO, del bot de reuniones a la sala del chat.
 *
 * Un proxy de Server-Sent Events: el navegador de la persona abre este stream,
 * y este proceso lo empalma con el SSE del bot (que exige el token de servicio
 * que el navegador jamás tiene). Cada línea que el bot transcribe cae aquí y
 * de aquí a la UI de reunión, en tiempo real.
 *
 * Se autentica por sesión de Cortex; el dueño (la organización) no se puede
 * falsificar porque el id de sesión de reunión no lo revela — pero el bot ya
 * ata cada sesión a su organización al unirse, así que un id de otro tenant no
 * trae su transcript. La comprobación fuerte queda para cuando estas salas
 * vivan más que una reunión.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireSession();
  const { id } = await ctx.params;

  const base = process.env.MEET_SERVICE_URL?.replace(/\/+$/, '');
  const token = process.env.MEET_SERVICE_TOKEN;
  if (!base || !token) {
    return NextResponse.json(
      { error: 'El bot de reuniones no está configurado.' },
      { status: 503 },
    );
  }

  const upstream = await fetch(
    `${base}/session/${encodeURIComponent(id)}/stream?owner=${encodeURIComponent(user.organization.id)}`,
    {
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
    },
  ).catch(() => null);

  if (!upstream || !upstream.ok || !upstream.body) {
    return NextResponse.json({ error: 'Esa reunión ya no está en vivo.' }, { status: 410 });
  }

  // Reenviar el cuerpo del stream tal cual. El navegador recibe SSE nativo.
  return new NextResponse(upstream.body, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
