import { sheetWindowRequestsOf } from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';
import { hojaSpec, hojaView } from '../fixture';

/**
 * El refresco del escaparate de la hoja: lo mismo que la ruta de datos de una
 * vista (`?sw=`/`?sq=` validados contra el spec), sobre las filas de ejemplo.
 * SÓLO EN DESARROLLO.
 */
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (process.env.NODE_ENV === 'production') return new NextResponse(null, { status: 404 });
  const sp = req.nextUrl.searchParams;
  const requests = sheetWindowRequestsOf(hojaSpec(), sp.get('sw'), sp.get('sq'));
  await new Promise((r) => setTimeout(r, 250));
  return NextResponse.json({ version: 1, view: hojaView(requests, Math.min(20_000, Number(sp.get('filas')) || 0)) }, { headers: { 'cache-control': 'no-store' } });
}
