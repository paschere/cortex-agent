import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { applyRowScope } from '../apps/permissions';
import type { RowAccess } from '../apps/permissions';
import { loadSourceAggregates } from './aggregate-load';
import { filtersKeyOf, statOfRows, statValue } from './aggregates';
import {
  type ViewRow,
  type ViewSource,
  computeView,
  matches,
  matchesBar,
  viewBucketOf,
} from './compute';
import { type CatalogTracker, type ViewFilter, viewSpecSchema } from './spec';
import { parseViewFilterParam } from './view-filters';

/**
 * Los agregados hechos en la base (0242): con una tabla de más de 2.000 filas,
 * la cifra es la de TODA la tabla y es la MISMA que saldría con todas las filas
 * en memoria. El SQL se prueba aparte contra Postgres; aquí se prueba que el
 * servidor arma bien las preguntas (filtros del bloque, barra, scope, período)
 * y que `computeView` usa las respuestas — con un `rpc` de mentira que
 * contesta con las reglas de compute.ts sobre las filas completas.
 */

const tracker: CatalogTracker = {
  slug: 'pf',
  name: 'Prefacturación',
  fields: [
    { key: 'cliente', label: 'Cliente', type: 'text', required: false },
    {
      key: 'estado',
      label: 'Estado',
      type: 'select',
      required: false,
      options: ['Pendiente', 'Listo', 'Enviado'],
    },
    { key: 'fecha', label: 'Fecha', type: 'date', required: false },
    { key: 'total_usd', label: 'Total USD', type: 'money', required: false },
  ],
};

const ESTADOS = ['Pendiente', 'Listo', 'Enviado'];
const OWNER = '00000000-0000-0000-0000-000000000001';
const TOTAL_ROWS = 3100;
const CAP = 2000;

/** Más recientes primero, como las lee `loadViewSources`. */
const ALL: Array<ViewRow & { created_by: string | null }> = Array.from(
  { length: TOTAL_ROWS },
  (_, k) => {
    const g = TOTAL_ROWS - k; // 3100 … 1
    const day = new Date(Date.UTC(2026, 0, 1 + (g % 120), 12)).toISOString().slice(0, 10);
    const values: Record<string, string | number> = {
      cliente: `C${g % 7}`,
      estado: ESTADOS[g % 3] as string,
      fecha: day,
      total_usd: g,
    };
    if (g % 10 === 0) delete values.total_usd; // sin total guardado
    return {
      id: `r${g}`,
      label: `Fila ${g}`,
      values,
      created_by: g % 4 === 0 ? OWNER : null,
      created_at: `${day}T12:00:00Z`,
      updated_at: new Date(Date.UTC(2026, 5, 1, 0, 0, TOTAL_ROWS - k)).toISOString(),
    };
  },
);

interface Args {
  p_field: string | null;
  p_group: { kind: string; field: string; bucket?: 'day' | 'week' | 'month'; from?: string } | null;
  p_filters: Array<Record<string, string>>;
  p_scope: { kind: string; userId?: string; external?: boolean; field?: string; value?: string };
  p_today: string;
}

/** `view_rows_aggregate` de mentira: las reglas del cliente sobre las filas completas. */
function fakeRpc(args: Args) {
  let rows: ViewRow[] = ALL;
  if (args.p_scope.kind === 'own')
    rows = ALL.filter((r) => r.created_by === args.p_scope.userId);
  for (const f of args.p_filters) {
    rows = rows.filter((r) => {
      if (f.op === 'fold_eq') return matchesBar(tracker, r, f.field as string, { kind: 'select', value: f.value as string });
      if (f.op === 'search') return matchesBar(tracker, r, f.field as string, { kind: 'search', value: f.value as string });
      if (f.op === 'range')
        return matchesBar(tracker, r, f.field as string, {
          kind: 'date_range',
          from: f.from || null,
          to: f.to || null,
        });
      return matches(tracker, r, { field: f.field, op: f.op, value: f.value } as ViewFilter, args.p_today);
    });
  }
  const g = args.p_group;
  const buckets = new Map<string | null, ViewRow[]>();
  for (const r of rows) {
    let key: string | null = null;
    if (g?.kind === 'value') key = (r.values[g.field] as string | undefined) ?? null;
    if (g?.kind === 'date') {
      const raw = g.field === 'created_at' ? r.created_at.slice(0, 10) : (r.values[g.field] as string | undefined);
      if (!raw) continue;
      if (g.from && raw < g.from) continue;
      key = viewBucketOf(raw, g.bucket ?? 'month');
    }
    buckets.set(key, [...(buckets.get(key) ?? []), r]);
  }
  return [...buckets].map(([grp, list]) => {
    const s = statOfRows(list, args.p_field ?? undefined);
    return { grp, cnt: s.cnt, n: s.n, total: s.n ? s.total : null, lo: s.lo, hi: s.hi };
  });
}

function fakeDb(calls: Args[] = [], fail = false) {
  return {
    rpc: vi.fn(async (name: string, args: Args & { p_tracker_id: string }) => {
      expect(name).toBe('view_rows_aggregate');
      calls.push(args);
      return fail
        ? { data: null, error: { message: 'function does not exist' } }
        : { data: fakeRpc(args), error: null };
    }),
  } as unknown as SupabaseClient;
}

const NOW = new Date('2026-03-10T17:00:00Z');
const spec = (blocks: unknown[], extra: Record<string, unknown> = {}) =>
  viewSpecSchema.parse({ version: 1, blocks, ...extra });

const BLOCKS = [
  { id: 'm_sum', type: 'metric', tracker: 'pf', title: 'Total USD', aggregate: 'sum', field: 'total_usd', format: 'money' },
  {
    id: 'm_filt',
    type: 'metric',
    tracker: 'pf',
    title: 'Listos grandes',
    aggregate: 'avg',
    field: 'total_usd',
    filters: [
      { field: 'estado', op: 'eq', value: 'Listo' },
      { field: 'total_usd', op: 'gt', value: 1000 },
    ],
  },
  { id: 'm_count', type: 'metric', tracker: 'pf', title: 'Filas', aggregate: 'count' },
  {
    id: 'm_cmp',
    type: 'metric',
    tracker: 'pf',
    title: 'Mes',
    aggregate: 'sum',
    field: 'total_usd',
    compare: 'previous_period',
    period: 'month',
    dateField: 'fecha',
  },
  { id: 'c_estado', type: 'chart', tracker: 'pf', title: 'Por estado', chart: 'bar', groupBy: 'estado', aggregate: 'sum', field: 'total_usd' },
  { id: 'c_mes', type: 'chart', tracker: 'pf', title: 'Por mes', chart: 'line', groupBy: 'fecha', bucket: 'month', aggregate: 'count' },
  { id: 'c_cli', type: 'chart', tracker: 'pf', title: 'Por cliente', chart: 'bar', groupBy: 'cliente', aggregate: 'count', limit: 3 },
  { id: 'p_estado', type: 'progress', tracker: 'pf', title: 'Avance', groupBy: 'estado', aggregate: 'sum', field: 'total_usd' },
  { id: 'b_estado', type: 'board', tracker: 'pf', title: 'Tablero', groupBy: 'estado', limit: 5 },
  { id: 't_all', type: 'table', tracker: 'pf', title: 'Todas', columns: ['cliente', 'estado'], limit: 10 },
];

async function truncatedSource(
  s: ReturnType<typeof spec>,
  access: RowAccess = { kind: 'all' },
  filters = {},
  db: SupabaseClient = fakeDb(),
): Promise<ViewSource> {
  const visible = applyRowScope(ALL, access);
  return {
    tracker,
    rows: visible.slice(0, CAP),
    truncated: visible.length > CAP,
    aggregates: await loadSourceAggregates(db, {
      trackerId: 't1',
      slug: 'pf',
      tracker,
      spec: s,
      access,
      filters,
      today: '2026-03-10',
    }),
  };
}

const full = (access: RowAccess = { kind: 'all' }): ViewSource => ({
  tracker,
  rows: applyRowScope(ALL, access),
  truncated: false,
});

describe('agregados en la base: la cifra de la tabla entera', () => {
  it('los bloques de cifras con la tabla truncada salen IGUAL que con todas las filas', async () => {
    const s = spec(BLOCKS);
    const exact = computeView(s, new Map([['pf', full()]]), NOW);
    const viaDb = computeView(s, new Map([['pf', await truncatedSource(s)]]), NOW);
    // Sin agregados serían las 2.000 más recientes: la suma sería otra.
    const naive = computeView(
      s,
      new Map([['pf', { ...(await truncatedSource(s)), aggregates: undefined }]]),
      NOW,
    );
    const sumOf = (v: ReturnType<typeof computeView>) =>
      v.blocks.find((b) => b.id === 'm_sum' && b.type === 'metric');
    expect(sumOf(naive)).not.toEqual(sumOf(exact));
    expect(viaDb.blocks).toEqual(exact.blocks);
    // Todo servido por la base: la vista no se marca parcial.
    expect(viaDb.partial).toEqual([]);
    // Y la cifra es la suma de las filas, no un número cualquiera.
    const total = ALL.reduce((a, r) => a + Number(r.values.total_usd ?? 0), 0);
    expect((sumOf(viaDb) as { value: number }).value).toBe(total);
  });

  it('el total de la tabla y los conteos del tablero cuentan las 3.100 filas', async () => {
    const s = spec(BLOCKS);
    const v = computeView(s, new Map([['pf', await truncatedSource(s)]]), NOW);
    const table = v.blocks.find((b) => b.id === 't_all');
    expect(table?.type === 'table' && table.total).toBe(TOTAL_ROWS);
    const board = v.blocks.find((b) => b.id === 'b_estado');
    const counts = board?.type === 'board' ? board.columns.map((c) => c.count) : [];
    expect(counts.reduce((a, b) => a + b, 0)).toBe(TOTAL_ROWS);
  });

  it('los filtros del bloque y de la barra viajan a la base (y salen igual)', async () => {
    const s = spec(BLOCKS, {
      filtersBar: [
        { id: 'estado', label: 'Estado', source: 'pf', field: 'estado', kind: 'select' },
        { id: 'cli', label: 'Cliente', source: 'pf', field: 'cliente', kind: 'search' },
        { id: 'fec', label: 'Fecha', source: 'pf', field: 'fecha', kind: 'date_range' },
      ],
    });
    const state = parseViewFilterParam(s, 'estado=listo&cli=c3&fec=2026-01-10~2026-03-01');
    const calls: Args[] = [];
    const src = await truncatedSource(s, { kind: 'all' }, state, fakeDb(calls));
    const filtersSeen = JSON.stringify(calls.map((c) => c.p_filters));
    expect(filtersSeen).toContain('fold_eq');
    expect(filtersSeen).toContain('search');
    expect(filtersSeen).toContain('range');
    expect(filtersSeen).toContain('"op":"gt"');
    const exact = computeView(s, new Map([['pf', full()]]), NOW, { filters: state });
    const viaDb = computeView(s, new Map([['pf', src]]), NOW, { filters: state });
    expect(viaDb.blocks).toEqual(exact.blocks);
    expect(viaDb.partial).toEqual([]);
  });

  it('el scope «own» del rol llega a la base y la cifra es sólo de sus filas', async () => {
    const access: RowAccess = { kind: 'own', userId: OWNER };
    const s = spec(BLOCKS);
    const calls: Args[] = [];
    const src = await truncatedSource(s, access, {}, fakeDb(calls));
    expect(calls.every((c) => c.p_scope.kind === 'own' && c.p_scope.userId === OWNER)).toBe(true);
    const mine = applyRowScope(ALL, access);
    // 775 filas propias: no pasa del tope, así que se prueba con el scope en la base
    // forzando la fuente a truncada para ver que los agregados NO miran filas ajenas.
    expect(mine.length).toBeLessThan(CAP);
    const forced: ViewSource = { ...src, rows: mine.slice(0, 100), truncated: true };
    const v = computeView(s, new Map([['pf', forced]]), NOW);
    const m = v.blocks.find((b) => b.id === 'm_count');
    expect(m?.type === 'metric' && m.value).toBe(mine.length);
    const sum = v.blocks.find((b) => b.id === 'm_sum');
    expect(sum?.type === 'metric' && sum.value).toBe(
      mine.reduce((a, r) => a + Number(r.values.total_usd ?? 0), 0),
    );
  });

  it('las preguntas iguales se hacen una sola vez', async () => {
    const s = spec(BLOCKS);
    const calls: Args[] = [];
    await truncatedSource(s, { kind: 'all' }, {}, fakeDb(calls));
    const keys = calls.map((c) => JSON.stringify(c));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('cuando la base no puede, la cifra lo dice', () => {
  it('sin la función (migración sin aplicar) cae a las filas cargadas y marca la tabla', async () => {
    const s = spec(BLOCKS);
    const src = await truncatedSource(s, { kind: 'all' }, {}, fakeDb([], true));
    expect(src.aggregates).toBeUndefined();
    const v = computeView(s, new Map([['pf', src]]), NOW);
    expect(v.partial).toEqual(['Prefacturación']);
  });

  it('una barra de filtros distinta a la de los agregados no se usa (nunca una cifra de otra barra)', async () => {
    const s = spec(BLOCKS, {
      filtersBar: [{ id: 'estado', label: 'Estado', source: 'pf', field: 'estado', kind: 'select' }],
    });
    const src = await truncatedSource(s); // calculados SIN barra
    const state = parseViewFilterParam(s, 'estado=listo');
    expect(filtersKeyOf(state)).not.toBe(src.aggregates?.filtersKey);
    const v = computeView(s, new Map([['pf', src]]), NOW, { filters: state });
    expect(v.partial).toEqual(['Prefacturación']);
  });

  it('el mapa de calor y las tablas ordenadas siguen sobre las filas cargadas y se marcan', async () => {
    const heat = spec([
      { id: 'h', type: 'chart', tracker: 'pf', title: 'Calor', chart: 'heatmap', groupBy: 'created_at', aggregate: 'count' },
    ]);
    const v = computeView(heat, new Map([['pf', await truncatedSource(heat)]]), NOW);
    expect(v.partial).toEqual(['Prefacturación']);
    const sorted = spec([
      { id: 't', type: 'table', tracker: 'pf', title: 'T', columns: ['cliente'], sort: { field: 'total_usd', dir: 'desc' }, limit: 5 },
    ]);
    const v2 = computeView(sorted, new Map([['pf', await truncatedSource(sorted)]]), NOW);
    expect(v2.partial).toEqual(['Prefacturación']);
  });
});

describe('aritmética de resúmenes', () => {
  it('statValue = aggregate() de las filas', () => {
    const rows = ALL.slice(0, 500);
    const st = statOfRows(rows, 'total_usd');
    expect(statValue(st, 'count')).toBe(500);
    const nums = rows.map((r) => Number(r.values.total_usd)).filter((n) => Number.isFinite(n));
    expect(statValue(st, 'sum', 'total_usd')).toBe(nums.reduce((a, b) => a + b, 0));
    expect(statValue(st, 'avg', 'total_usd')).toBeCloseTo(nums.reduce((a, b) => a + b, 0) / nums.length);
    expect(statValue(st, 'min', 'total_usd')).toBe(Math.min(...nums));
    expect(statValue(st, 'max', 'total_usd')).toBe(Math.max(...nums));
    expect(statValue(statOfRows([], 'x'), 'sum', 'x')).toBe(0);
    expect(statValue(statOfRows([], 'x'), 'avg', 'x')).toBeNull();
  });
});
