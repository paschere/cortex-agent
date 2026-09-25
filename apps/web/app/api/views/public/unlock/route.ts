import { isSameOrigin } from '@/lib/activations/request';
import { mintUnlockCookie, openPublicView } from '@/lib/views/public';
import { unlockView } from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

/**
 * Abrir una vista con contraseña. Sin sesión (está en PUBLIC_PATHS): el token
 * dice qué vista, la contraseña dice que puedes verla. El intento se gasta en
 * la base antes de comparar; a la décima fallida la vista se cierra quince
 * minutos. Un token que no abre y una contraseña mala no se distinguen del
 * lado de afuera más de lo necesario.
 */

export const runtime = 'nodejs';

const input = z.object({
  token: z.string().min(32).max(64),
  password: z.string().min(1).max(200),
});

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'Origen inválido.' }, { status: 403 });
  const parsed = input.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({ error: 'Escribe la contraseña.' }, { status: 400 });
  const opened = await openPublicView(parsed.data.token);
  if (!opened || opened.view.visibility !== 'password')
    return NextResponse.json({ error: 'Este enlace ya no está disponible.' }, { status: 404 });

  const outcome = await unlockView(opened.db, opened.view, parsed.data.password);
  if (!outcome.ok)
    return outcome.reason === 'locked'
      ? NextResponse.json(
          { error: 'Demasiados intentos. Espera unos minutos y vuelve a probar.' },
          { status: 429 },
        )
      : NextResponse.json({ error: 'Contraseña incorrecta.' }, { status: 401 });

  const cookie = await mintUnlockCookie(opened.db, opened.view.id);
  const res = NextResponse.json({ ok: true });
  if (cookie)
    res.cookies.set(cookie.name, cookie.value, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: cookie.maxAge,
    });
  return res;
}
