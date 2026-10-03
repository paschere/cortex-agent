import { isSameOrigin } from '@/lib/activations/request';
import { mintBoardUnlockCookie, openPublicBoard } from '@/lib/board/public';
import { unlockBoardReport } from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

/**
 * Abrir un informe para socios con contraseña (sin sesión; en PUBLIC_PATHS).
 * El intento se gasta en la base antes de comparar; a la décima fallida el
 * informe se cierra quince minutos (board_report_reserve_unlock, 0191).
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
  const opened = await openPublicBoard(parsed.data.token);
  if (!opened || opened.report.visibility !== 'contrasena')
    return NextResponse.json({ error: 'Este enlace ya no está disponible.' }, { status: 404 });
  const outcome = await unlockBoardReport(opened.db, opened.report, parsed.data.password);
  if (!outcome.ok)
    return outcome.reason === 'locked'
      ? NextResponse.json(
          { error: 'Demasiados intentos. Espera unos minutos y vuelve a probar.' },
          { status: 429 },
        )
      : NextResponse.json({ error: 'Contraseña incorrecta.' }, { status: 401 });
  const cookie = await mintBoardUnlockCookie(opened.db, opened.report.id);
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
