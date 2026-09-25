import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { canWriteView, computeView, getView, loadViewSources } from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Los datos de una vista, recalculados, para el refresco en vivo dentro de la
 * app. Misma lectura que la página (`loadViewSources` + `computeView`), con el
 * handle del espacio de la sesión: una vista de otra empresa es un 404.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const view = await getView(db, id);
  if (!view) return NextResponse.json({ error: 'Esa vista ya no existe.' }, { status: 404 });
  const sources = await loadViewSources(db, view.spec, { viewerId: user.id });
  const computed = computeView(view.spec, sources, new Date(), {
    writable: canWriteView(view, 'member'),
  });
  return NextResponse.json(
    { version: view.version, view: computed },
    { headers: { 'cache-control': 'no-store' } },
  );
}
