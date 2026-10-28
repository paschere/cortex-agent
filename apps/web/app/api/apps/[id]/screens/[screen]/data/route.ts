import { openScreenForApi, previewAttributesOf } from '@/lib/apps/access';
import { previewModeOf } from '@/lib/apps/preview-query';
import {
  parseViewFilterParam,
  readScreen,
  readScreenSample,
  screenView,
  sheetWindowRequestsOf,
} from '@cortex/agent-tools';
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
  const opened = await openScreenForApi(id, screenRef, {
    as: sp.get('como'),
    attributes: previewAttributesOf(sp.getAll('atr')),
  });
  if (opened instanceof NextResponse) return opened;
  const { db, access, screen, readOnly } = opened;
  const view = await screenView(db, screen);
  // «Ver como…» en modo prueba: el refresco también trae filas de ejemplo, nunca las reales.
  if (readOnly && previewModeOf(sp.get('modo')) === 'prueba') {
    const sample = await readScreenSample(db, access, screen, {
      fila: sp.get('fila'),
      detail: sp.get('d'),
      filters: parseViewFilterParam(view.spec, sp.get('f')),
    });
    return NextResponse.json(
      { version: view.version, view: sample.computed },
      { headers: { 'cache-control': 'no-store' } },
    );
  }
  const { computed } = await readScreen(db, access, screen, {
    spec: view.spec,
    filters: parseViewFilterParam(view.spec, sp.get('f')),
    readOnly,
    fila: sp.get('fila'),
    detail: sp.get('d'),
    sheetWindows: sheetWindowRequestsOf(view.spec, sp.get('sw'), sp.get('sq')),
  });
  return NextResponse.json(
    { version: view.version, view: computed },
    { headers: { 'cache-control': 'no-store' } },
  );
}
