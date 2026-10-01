import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  canWriteView,
  computeView,
  getView,
  loadViewSources,
  parseViewFilterParam,
} from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Los datos de una vista, recalculados, para el refresco en vivo dentro de la
 * app. Misma lectura que la página (`loadViewSources` + `computeView`), con el
 * handle del espacio de la sesión: una vista de otra empresa es un 404.
 *
 * `?f=` es lo elegido en la barra de filtros. Se valida contra el spec
 * GUARDADO (`parseViewFilterParam`): sólo los filtros que la vista declara,
 * con valores cortos; lo demás se descarta.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const view = await getView(db, id);
  if (!view) return NextResponse.json({ error: 'Esa vista ya no existe.' }, { status: 404 });
  const sources = await loadViewSources(db, view.spec, { viewerId: user.id });
  const computed = computeView(view.spec, sources, new Date(), {
    writable: canWriteView(view, 'member'),
    filters: parseViewFilterParam(view.spec, req.nextUrl.searchParams.get('f')),
  });
  return NextResponse.json(
    { version: view.version, view: computed },
    { headers: { 'cache-control': 'no-store' } },
  );
}
