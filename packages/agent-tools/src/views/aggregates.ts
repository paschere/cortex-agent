import type { Aggregate } from './spec';
import type { ViewFilterState } from './view-filters';

/**
 * AGREGADOS HECHOS EN LA BASE. Cuando una tabla pasa del tope de filas que una
 * vista lee (VIEW_ROW_CAP), las cifras que sólo necesitan SUMAR, CONTAR,
 * PROMEDIAR o tomar el MÍNIMO/MÁXIMO (cifras, gráficos, avances, conteos por
 * columna del tablero, total de la tabla) se calculan con `view_rows_aggregate`
 * (migración 0242) sobre TODA la tabla, y el servidor web recibe sólo estos
 * resúmenes, no las filas. Este archivo es la parte pura: la forma del
 * resumen y su aritmética. La carga vive en aggregate-load.ts.
 */

/** Lo que se sabe de un grupo de filas: cuántas son, cuántas traen número y sus sumas. */
export interface Stat {
  cnt: number;
  /** Filas con un número en el campo agregado. */
  n: number;
  total: number;
  lo: number | null;
  hi: number | null;
}

export const EMPTY_STAT: Stat = { cnt: 0, n: 0, total: 0, lo: null, hi: null };

/** Un resumen por bloque: el total, o sus grupos (clave null = sin valor). */
export interface BlockAggregates {
  total?: Stat;
  groups?: Array<{ key: string | null; stat: Stat }>;
}

export interface SourceAggregates {
  /** La barra de filtros con que se calcularon; si no es la de la vista, no sirven. */
  filtersKey: string;
  byBlock: Map<string, BlockAggregates>;
}

/** Los bloques que se pueden servir con agregados (los demás leen filas). */
export const AGGREGATE_BLOCK_TYPES: ReadonlySet<string> = new Set([
  'metric',
  'chart',
  'progress',
  'board',
  'zones',
  'table',
]);

export function filtersKeyOf(state: ViewFilterState | undefined): string {
  const entries = Object.entries(state ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}

export function mergeStats(a: Stat, b: Stat): Stat {
  return {
    cnt: a.cnt + b.cnt,
    n: a.n + b.n,
    total: a.total + b.total,
    lo: a.lo === null ? b.lo : b.lo === null ? a.lo : Math.min(a.lo, b.lo),
    hi: a.hi === null ? b.hi : b.hi === null ? a.hi : Math.max(a.hi, b.hi),
  };
}

/** El resumen de un grupo de valores ya leídos (la ruta sin agregados usa lo mismo). */
export function statOfRows(rows: Array<{ values: Record<string, string | number> }>, field?: string): Stat {
  let n = 0;
  let total = 0;
  let lo: number | null = null;
  let hi: number | null = null;
  if (field) {
    for (const r of rows) {
      const v = r.values[field];
      if (v === undefined || v === '') continue;
      const num = Number(v);
      if (!Number.isFinite(num)) continue;
      n += 1;
      total += num;
      lo = lo === null ? num : Math.min(lo, num);
      hi = hi === null ? num : Math.max(hi, num);
    }
  }
  return { cnt: rows.length, n, total, lo, hi };
}

/** Lo mismo que `aggregate(rows, agg, field)` pero desde el resumen. */
export function statValue(stat: Stat, agg: Aggregate, field?: string): number | null {
  if (agg === 'count') return stat.cnt;
  if (!field) return null;
  if (stat.n === 0) return agg === 'sum' ? 0 : null;
  if (agg === 'sum') return stat.total;
  if (agg === 'avg') return stat.total / stat.n;
  if (agg === 'min') return stat.lo;
  return stat.hi;
}
