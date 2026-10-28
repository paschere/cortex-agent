import type { SupabaseClient } from '@supabase/supabase-js';
import type { RowAccess } from '../apps/permissions';
import {
  type BlockAggregates,
  type SourceAggregates,
  type Stat,
  filtersKeyOf,
} from './aggregates';
import { SERIES_LENGTH, shiftBucket, viewBucketOf as bucketOf } from './compute';
import { type CatalogTracker, type ViewBlock, type ViewSpec, fieldType } from './spec';
import type { ViewFilterState } from './view-filters';

/**
 * LA CARGA DE LOS AGREGADOS (ver aggregates.ts). Para cada bloque de cifras de
 * una tabla truncada arma las preguntas a `view_rows_aggregate` (filtros del
 * bloque + barra de filtros + alcance del rol + período) y junta las
 * respuestas por bloque. Preguntas idénticas se hacen una sola vez.
 *
 * Si algo no se puede responder en la base (un bloque sin plan, un campo con
 * nombre raro, la función aún sin aplicar, más de 5.000 grupos), ese bloque
 * NO queda en el resultado y `computeView` lo calcula sobre las filas cargadas
 * marcándolo «sobre las 2.000 filas más recientes». Nunca se inventa una cifra.
 */

const NAME_RE = /^[A-Za-z0-9_]{1,32}$/;
/** El tope de grupos que devuelve la función (pide uno más para saber si se pasó). */
const MAX_GROUPS = 5000;

type Group =
  | { kind: 'value' | 'relation'; field: string }
  | { kind: 'date'; field: string; bucket: 'day' | 'week' | 'month'; from?: string };

interface Ask {
  field: string | null;
  group: Group | null;
}
interface BlockPlan {
  total?: Ask;
  groups?: Ask;
}

type FilterPayload = Record<string, string>;

const isDateType = (t: string | null) => t === 'date' || t === 'builtin_date';

function groupFor(
  tracker: CatalogTracker,
  by: string,
  bucket: 'day' | 'week' | 'month',
): Group {
  const type = fieldType(tracker, by);
  if (isDateType(type)) return { kind: 'date', field: by, bucket };
  return { kind: type === 'relation' ? 'relation' : 'value', field: by };
}

/** Qué le pregunta a la base cada bloque. null = ese bloque no se sirve con agregados. */
export function planBlock(
  block: ViewBlock,
  tracker: CatalogTracker,
  today: string,
): BlockPlan | null {
  switch (block.type) {
    case 'metric': {
      const field = block.aggregate === 'count' ? null : (block.field ?? null);
      if (block.compare !== 'previous_period') return { total: { field, group: null } };
      const period = block.period ?? 'month';
      const start = shiftBucket(bucketOf(today, period), period, -(SERIES_LENGTH[period] - 1));
      return {
        groups: {
          field,
          group: {
            kind: 'date',
            field: block.dateField ?? 'created_at',
            bucket: period,
            from: period === 'month' ? `${start}-01` : start,
          },
        },
      };
    }
    case 'chart': {
      if (block.chart === 'heatmap') return null;
      const field = block.aggregate === 'count' ? null : (block.field ?? null);
      return {
        total: { field, group: null },
        groups: {
          field,
          group:
            block.chart === 'funnel'
              ? { kind: 'value', field: block.groupBy }
              : groupFor(tracker, block.groupBy, block.bucket),
        },
      };
    }
    case 'progress': {
      const field = block.aggregate === 'count' ? null : (block.field ?? null);
      if (!block.groupBy) return { total: { field, group: null } };
      return { groups: { field, group: groupFor(tracker, block.groupBy, 'month') } };
    }
    case 'board':
    case 'zones':
      return { groups: { field: null, group: { kind: 'value', field: block.groupBy } } };
    case 'table':
      return { total: { field: null, group: null } };
    default:
      return null;
  }
}

function typeOf(tracker: CatalogTracker, field: string): 't' | 'num' | 'date' {
  const type = fieldType(tracker, field);
  return type === 'number' || type === 'money' ? 'num' : isDateType(type) ? 'date' : 't';
}

/** Los filtros del bloque, en el lenguaje de la función. */
function blockFilters(block: ViewBlock, tracker: CatalogTracker): FilterPayload[] {
  if (!('filters' in block)) return [];
  return block.filters.map((f) => ({
    field: f.field,
    op: f.op,
    ...(f.value !== undefined ? { value: String(f.value) } : {}),
    t: typeOf(tracker, f.field),
  }));
}

/** Lo elegido en la barra de filtros para ESTA tabla (lo mismo que `applyFilterBar`). */
export function barFilters(
  spec: Pick<ViewSpec, 'filtersBar'>,
  slug: string,
  tracker: CatalogTracker,
  state: ViewFilterState,
): FilterPayload[] {
  const out: FilterPayload[] = [];
  for (const item of spec.filtersBar ?? []) {
    const value = state[item.id];
    if (!value || item.source !== slug || !fieldType(tracker, item.field)) continue;
    const t = typeOf(tracker, item.field);
    if (value.kind === 'search') out.push({ field: item.field, op: 'search', value: value.value, t });
    else if (value.kind === 'date_range')
      out.push({ field: item.field, op: 'range', from: value.from ?? '', to: value.to ?? '', t });
    else out.push({ field: item.field, op: 'fold_eq', value: value.value, t });
  }
  return out;
}

function scopeOf(access: RowAccess): Record<string, unknown> | null {
  switch (access.kind) {
    case 'all':
      return { kind: 'all' };
    case 'own':
      return { kind: 'own', userId: access.userId, external: Boolean(access.external) };
    case 'equals':
      return { kind: 'equals', field: access.field, value: access.value };
    default:
      return null;
  }
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

interface Raw {
  grp: string | null;
  cnt: unknown;
  n: unknown;
  total: unknown;
  lo: unknown;
  hi: unknown;
}

function statOf(r: Raw): Stat {
  return { cnt: num(r.cnt), n: num(r.n), total: num(r.total), lo: numOrNull(r.lo), hi: numOrNull(r.hi) };
}

export interface LoadAggregatesArgs {
  trackerId: string;
  slug: string;
  tracker: CatalogTracker;
  spec: ViewSpec;
  access: RowAccess;
  filters: ViewFilterState;
  today: string;
}

/**
 * Los agregados de una tabla truncada, por bloque. Devuelve sólo los bloques
 * que la base pudo responder entero; undefined si no hay ninguno.
 */
export async function loadSourceAggregates(
  db: SupabaseClient,
  a: LoadAggregatesArgs,
): Promise<SourceAggregates | undefined> {
  const scope = scopeOf(a.access);
  if (!scope) return undefined;
  const bar = barFilters(a.spec, a.slug, a.tracker, a.filters);
  const asks = new Map<string, Promise<Raw[] | null>>();
  const ask = (req: Ask, filters: FilterPayload[]): Promise<Raw[] | null> => {
    const key = JSON.stringify([req, filters]);
    const hit = asks.get(key);
    if (hit) return hit;
    const run = (async () => {
      const { data, error } = await db.rpc('view_rows_aggregate', {
        p_tracker_id: a.trackerId,
        p_field: req.field,
        p_group: req.group,
        p_filters: filters,
        p_scope: scope,
        p_today: a.today,
      });
      if (error || !Array.isArray(data)) return null;
      const rows = data as Raw[];
      return rows.length > MAX_GROUPS ? null : rows;
    })().catch(() => null);
    asks.set(key, run);
    return run;
  };

  const byBlock = new Map<string, BlockAggregates>();
  await Promise.all(
    a.spec.blocks.map(async (block) => {
      if (!('tracker' in block) || block.tracker !== a.slug) return;
      const plan = planBlock(block, a.tracker, a.today);
      if (!plan) return;
      const filters = [...bar, ...blockFilters(block, a.tracker)];
      if (filters.some((f) => !NAME_RE.test(f.field ?? ''))) return;
      const refs = [plan.total, plan.groups];
      for (const r of refs) {
        if (!r) continue;
        if (r.field && !NAME_RE.test(r.field)) return;
        if (r.group && !NAME_RE.test(r.group.field)) return;
      }
      const [total, groups] = await Promise.all(
        refs.map((r) => (r ? ask(r, filters) : Promise.resolve(undefined))),
      );
      if (total === null || groups === null) return;
      const out: BlockAggregates = {};
      if (total !== undefined) out.total = total[0] ? statOf(total[0]) : { cnt: 0, n: 0, total: 0, lo: null, hi: null };
      if (groups !== undefined) out.groups = groups.map((g) => ({ key: g.grp, stat: statOf(g) }));
      byBlock.set(block.id, out);
    }),
  );
  return byBlock.size ? { filtersKey: filtersKeyOf(a.filters), byBlock } : undefined;
}
