import { readAppImage } from '@/lib/apps/app-assets';
import { openExternalApp } from '@/lib/apps/external-session';
import { logoResponse } from '@/lib/branding/store';
import { IMAGE_KINDS } from '@cortex/agent-tools';
import type { NextRequest } from 'next/server';

/**
 * Una imagen propia de una app publicada (logo, ícono, bienvenida), para su
 * entrada, que se pinta antes de que haya sesión. Sale de la fila de ESA app:
 * no hay forma de pedir la de otra con este endpoint.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; kind: string }> },
) {
  const { id, kind } = await params;
  const wanted = IMAGE_KINDS.find((k) => k === kind);
  if (!wanted) return new Response('Not found', { status: 404 });
  const opened = await openExternalApp(decodeURIComponent(id));
  if (!opened) return new Response('Not found', { status: 404 });
  return logoResponse(
    await readAppImage(opened.db, opened.app, wanted),
    req.nextUrl.searchParams.get('v'),
  );
}
