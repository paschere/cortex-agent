import 'server-only';
import {
  type ComputedView,
  type ViewSpec,
  buildViewWorkbook,
  todayIn,
  viewExportFilename,
} from '@cortex/agent-tools';
import { NextResponse } from 'next/server';

/**
 * LA RESPUESTA DE «EXPORTAR» (Excel), común a la ruta de adentro y a la del
 * enlace público. Lo que se exporta es lo YA calculado por la misma lectura
 * que la pantalla (ver packages/agent-tools/src/views/export.ts); aquí sólo se
 * pone el tope de uso y los encabezados.
 *
 * El tope es por ventana de una hora y por llave (la persona o el enlace), en
 * memoria del proceso: frena el abuso de un enlace público sin tabla nueva. En
 * varias instancias cada una cuenta aparte; es un freno, no una cuota exacta.
 */

export const EXPORTS_PER_HOUR = 20;
const WINDOW_MS = 60 * 60 * 1000;
const hits = new Map<string, number[]>();

/** True si esta llave aún puede exportar; cuenta la llamada. */
export function takeExportSlot(key: string, now = Date.now()): boolean {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= EXPORTS_PER_HOUR) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000)
    for (const [k, v] of hits) if (!v.some((t) => now - t < WINDOW_MS)) hits.delete(k);
  return true;
}

/** Los bloques de tabla piden todas sus filas (hasta el tope del contrato). */
export function specForExport(spec: ViewSpec): ViewSpec {
  return {
    ...spec,
    blocks: spec.blocks.map((b) => (b.type === 'table' ? { ...b, limit: 200 } : b)),
  };
}

export async function workbookResponse(
  computed: ComputedView,
  title: string,
  extraHeaders: Record<string, string> = {},
): Promise<NextResponse> {
  const bytes = await buildViewWorkbook(computed, title);
  if (!bytes)
    return NextResponse.json(
      { error: 'Esta vista no tiene tablas ni cifras que exportar.' },
      { status: 422 },
    );
  const name = viewExportFilename(title, todayIn(new Date()), 'xlsx');
  return new NextResponse(bytes as unknown as BodyInit, {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="${name}"`,
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}
