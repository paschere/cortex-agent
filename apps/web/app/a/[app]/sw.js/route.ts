import { openExternalApp } from '@/lib/apps/external-session';
import { buildAppServiceWorker } from '@/lib/apps/service-worker-source';
import { NextResponse } from 'next/server';

/**
 * El service worker de la app (/a/<app>/sw.js). Su alcance es /a/<app>/: no ve
 * ni toca nada fuera de esa app. Nunca se guarda en la caché del navegador
 * (`no-cache`), para que una versión nueva llegue en la siguiente apertura.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ app: string }> }) {
  const { app: appId } = await params;
  const opened = await openExternalApp(decodeURIComponent(appId));
  if (!opened) return new NextResponse('No existe.', { status: 404 });
  return new NextResponse(buildAppServiceWorker(opened.app.id), {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Service-Worker-Allowed': `/a/${opened.app.id}/`,
    },
  });
}
