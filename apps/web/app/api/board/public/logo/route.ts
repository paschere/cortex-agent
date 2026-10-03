import { openPublicBoard } from '@/lib/board/public';
import { logoResponse, readLogo } from '@/lib/branding/store';
import type { NextRequest } from 'next/server';

/**
 * El logo de la empresa dueña de un informe para socios compartido (0191 +
 * 0170). Con el token del informe se lee el logo de ESA empresa: no hay forma
 * de pedir otro archivo.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token') ?? '';
  const opened = token ? await openPublicBoard(token) : null;
  if (!opened)
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  return logoResponse(await readLogo(opened.db), req.nextUrl.searchParams.get('v'));
}
