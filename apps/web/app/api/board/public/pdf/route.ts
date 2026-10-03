import { boardPdfResponse } from '@/lib/board/pdf';
import { boardUnlockCookieName, isBoardUnlocked, openPublicBoard } from '@/lib/board/public';
import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';

/**
 * El PDF del informe para socios por su enlace (sin sesión; está en
 * PUBLIC_PATHS). Si el informe pide contraseña, sólo con la cookie de
 * desbloqueo que deja /api/board/public/unlock.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token') ?? '';
  const opened = await openPublicBoard(token);
  if (!opened) return new Response('Not found', { status: 404 });
  if (opened.report.visibility === 'contrasena') {
    const jar = await cookies();
    const ok = await isBoardUnlocked(
      opened.db,
      opened.report.id,
      jar.get(boardUnlockCookieName(opened.report.id))?.value,
    );
    if (!ok) return new Response('Not found', { status: 404 });
  }
  return boardPdfResponse(opened.db, opened.report, opened.organizationName);
}
