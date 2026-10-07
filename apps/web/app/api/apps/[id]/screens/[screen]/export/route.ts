import { openScreenForApi } from '@/lib/apps/access';
import { specForExport, takeExportSlot, workbookResponse } from '@/lib/views/export-response';
import { appCanExport, parseViewFilterParam, readScreen, screenView } from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * «Exportar → Excel» de una pantalla de aplicación. Sale del mismo
 * `readScreen` que la pantalla (scope de filas del rol incluido): lo que baja
 * es lo que ese rol ve. Si el rol no exporta, es un 403.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; screen: string }> },
) {
  const { id, screen: screenRef } = await params;
  const sp = req.nextUrl.searchParams;
  const opened = await openScreenForApi(id, screenRef, { as: sp.get('como') });
  if (opened instanceof NextResponse) return opened;
  const { db, user, access, screen, readOnly } = opened;
  if (!appCanExport(access))
    return NextResponse.json({ error: 'Tu rol en esta aplicación no exporta.' }, { status: 403 });
  if (!takeExportSlot(`u:${user.id}`))
    return NextResponse.json(
      { error: 'Exportaste muchas veces en la última hora. Intenta más tarde.' },
      { status: 429 },
    );
  const view = await screenView(db, screen);
  const { computed } = await readScreen(db, access, screen, {
    spec: specForExport(view.spec),
    filters: parseViewFilterParam(view.spec, sp.get('f')),
    readOnly,
  });
  return workbookResponse(computed, `${access.app.name} · ${screen.title}`);
}
