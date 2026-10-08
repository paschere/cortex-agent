import { readAppImage } from '@/lib/apps/app-assets';
import { logoResponse } from '@/lib/branding/store';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { IMAGE_KINDS, getApp } from '@cortex/agent-tools';
import type { NextRequest } from 'next/server';

/**
 * Una imagen propia de una app, para quien está dentro con sesión de Cortex
 * (también las apps en borrador, que la ruta pública no sirve). El handle es
 * el del espacio de quien pide: una app de otra empresa no existe.
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
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const app = await getApp(db, decodeURIComponent(id));
  if (!app) return new Response('Not found', { status: 404 });
  return logoResponse(
    await readAppImage(db, { ...app, organization_id: user.organization.id }, wanted),
    req.nextUrl.searchParams.get('v'),
  );
}
