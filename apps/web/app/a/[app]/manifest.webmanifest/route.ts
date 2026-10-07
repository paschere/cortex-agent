import { openExternalApp } from '@/lib/apps/external-session';
import { buildAppManifest } from '@/lib/apps/manifest';
import { readBranding } from '@/lib/branding/store';
import { NextResponse } from 'next/server';

/**
 * El manifiesto de la app instalable (/a/<app>/manifest.webmanifest), uno por
 * app. Es público como la pantalla de entrada: no lleva datos, sólo el nombre,
 * el color y las direcciones de la app. Una app que no existe, está en borrador
 * o se archivó es 404 sin distinguir.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ app: string }> }) {
  const { app: appId } = await params;
  const opened = await openExternalApp(decodeURIComponent(appId));
  if (!opened) return NextResponse.json({ error: 'No existe.' }, { status: 404 });
  const brand = await readBranding(opened.db).catch(() => null);
  return new NextResponse(JSON.stringify(buildAppManifest(opened.app, brand?.primary_color)), {
    headers: {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600',
    },
  });
}
