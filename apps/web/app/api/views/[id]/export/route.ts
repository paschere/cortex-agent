import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { specForExport, takeExportSlot, workbookResponse } from '@/lib/views/export-response';
import {
  canWriteView,
  computeView,
  getView,
  loadViewSources,
  parseViewFilterParam,
} from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * «Exportar → Excel» de una vista, dentro de la app. Misma lectura y mismos
 * filtros (`?f=`) que /api/views/<id>/data: lo que baja es lo que se ve.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireSession();
  if (!takeExportSlot(`u:${user.id}`))
    return NextResponse.json(
      { error: 'Exportaste muchas veces en la última hora. Intenta más tarde.' },
      { status: 429 },
    );
  const db = getOrgScopedClient(user.organization.id);
  const view = await getView(db, id);
  if (!view) return NextResponse.json({ error: 'Esa vista ya no existe.' }, { status: 404 });
  const spec = specForExport(view.spec);
  const computed = computeView(
    spec,
    await loadViewSources(db, spec, { viewerId: user.id }),
    new Date(),
    {
      writable: canWriteView(view, 'member'),
      filters: parseViewFilterParam(view.spec, req.nextUrl.searchParams.get('f')),
    },
  );
  return workbookResponse(computed, view.name);
}
