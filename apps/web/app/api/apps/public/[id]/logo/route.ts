import { openExternalApp } from '@/lib/apps/external-session';
import { logoResponse, readLogo } from '@/lib/branding/store';
import type { NextRequest } from 'next/server';

/**
 * El logo de la empresa dueña de una app, para su pantalla de entrada (que se
 * pinta antes de que haya sesión). Sale de la fila de la PROPIA empresa de la
 * app publicada: no hay forma de pedir el de otra con este endpoint.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const opened = await openExternalApp(decodeURIComponent(id));
  if (!opened) return new Response('Not found', { status: 404 });
  return logoResponse(await readLogo(opened.db), req.nextUrl.searchParams.get('v'));
}
