import { openScreenForApi } from '@/lib/apps/access';
import { parseViewFilterParam, readScreen, screenView } from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Los datos de una pantalla de aplicación, recalculados, para el refresco en
 * vivo. La lectura pasa por `readScreen`: el scope de filas del rol ya está
 * aplicado, así que lo que sale es sólo lo que ese rol puede ver. `?f=` se
 * valida contra el spec GUARDADO, como en /api/views/<id>/data; `?como=` es
 * «Ver como…» y sólo lo honra quien administra la empresa.
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
  const { db, access, screen, readOnly } = opened;
  const view = await screenView(db, screen);
  const { computed } = await readScreen(db, access, screen, {
    spec: view.spec,
    filters: parseViewFilterParam(view.spec, sp.get('f')),
    readOnly,
  });
  return NextResponse.json(
    { version: view.version, view: computed },
    { headers: { 'cache-control': 'no-store' } },
  );
}
