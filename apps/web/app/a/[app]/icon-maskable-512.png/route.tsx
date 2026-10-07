import { openExternalApp } from '@/lib/apps/external-session';
import { appIconResponse } from '@/lib/apps/icon-image';
import { NextResponse } from 'next/server';

/** El ícono icon-maskable-512.png de la app instalable: su emoji sobre el color de la marca. */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ app: string }> }) {
  const { app: appId } = await params;
  const opened = await openExternalApp(decodeURIComponent(appId));
  if (!opened) return NextResponse.json({ error: 'No existe.' }, { status: 404 });
  return appIconResponse(opened.db, opened.app, 512, { maskable: true });
}
