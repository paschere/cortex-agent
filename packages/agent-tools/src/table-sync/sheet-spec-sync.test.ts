import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SheetData } from '../kb/spreadsheets';

vi.mock('../apps/automations/emit', () => ({ emitSyncEvents: vi.fn(async () => 0) }));
vi.mock('../trackers/duplicates', () => ({
  applyDuplicateRule: vi.fn(async () => ({ changed: 0, conflicts: [] })),
}));

import { runGroupedSync } from './sheet-spec-sync';

type Row = {
  id: string;
  tracker_id: string;
  label: string;
  values: Record<string, unknown>;
  external_key: string | null;
  created_by?: string | null;
  updated_at: string;
};

const F = (key: string, type = 'text', extra: Record<string, unknown> = {}) => ({ key, label: key, type, required: false, ...extra });
const trackers = [
  { id: 'T-G', slug: 'guias', name: 'Guías', fields: [F('guia', 'text', { required: true }), F('fva'), F('kilos', 'number'), F('estado', 'select', { options: ['Pendiente', 'OK', 'Enviado a Siigo'], default: 'Pendiente' }), F('origen'), F('cliente', 'relation', { tracker: 'clientes', required: true }), F('manifiesto', 'relation', { tracker: 'manifiestos' }), F('nit', 'text', { lookup: { via: 'cliente', field: 'nit' } })] },
  { id: 'T-M', slug: 'manifiestos', name: 'Manifiestos', fields: [F('nombre', 'text', { required: true }), F('n_manifiesto'), F('fva'), F('cobro', 'number'), F('estado', 'select', { options: ['Pendiente', 'OK'], default: 'Pendiente' })] },
  { id: 'T-C', slug: 'clientes', name: 'Clientes', fields: [F('nombre', 'text', { required: true }), F('nit')] },
].map((t) => ({ ...t, description: '', origins: null, created_by: null, created_at: '', updated_at: '' }));

let rows: Row[] = [];
let writes = 0;

/** Un Supabase de mentira: sólo lo que usa runGroupedSync. */
function fakeDb() {
  const query = (table: string) => {
    const state: { filters: Array<(r: Row) => boolean>; range?: [number, number]; single?: boolean } = { filters: [] };
    const run = () => {
      if (table === 'trackers') {
        const f = state.filters;
        const data = trackers.filter((t) => f.every((fn) => fn(t as unknown as Row)));
        return { data: state.single ? (data[0] ?? null) : data, error: null };
      }
      let data = rows.filter((r) => state.filters.every((fn) => fn(r)));
      data = data.sort((a, b) => a.id.localeCompare(b.id));
      if (state.range) data = data.slice(state.range[0], state.range[1] + 1);
      return { data, error: null };
    };
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (c: string, v: unknown) => {
        state.filters.push((r) => (r as unknown as Record<string, unknown>)[c] === v);
        return q;
      },
      not: (c: string) => {
        state.filters.push((r) => (r as unknown as Record<string, unknown>)[c] !== null);
        return q;
      },
      is: (c: string) => {
        state.filters.push((r) => (r as unknown as Record<string, unknown>)[c] === null);
        return q;
      },
      order: () => q,
      range: (a: number, b: number) => {
        state.range = [a, b];
        return q;
      },
      maybeSingle: () => {
        state.single = true;
        return Promise.resolve(run());
      },
      then: (res: (v: unknown) => unknown) => Promise.resolve(run()).then(res),
      insert: (payload: Row | Row[]) => {
        writes += 1;
        for (const r of Array.isArray(payload) ? payload : [payload]) rows.push({ ...r, updated_at: new Date().toISOString() });
        return Promise.resolve({ error: null });
      },
      update: (patch: Partial<Row>) => {
        const u = { filters: [] as Array<(r: Row) => boolean> };
        const uq: Record<string, unknown> = {
          eq: (c: string, v: unknown) => {
            u.filters.push((r) => (r as unknown as Record<string, unknown>)[c] === v);
            return uq;
          },
          then: (res: (v: unknown) => unknown) => {
            writes += 1;
            for (const r of rows) if (u.filters.every((fn) => fn(r))) Object.assign(r, patch);
            return Promise.resolve({ error: null }).then(res);
          },
        };
        return uq;
      },
    };
    return q;
  };
  return { from: query } as never;
}

const spec = {
  version: 1,
  tab: { name: 'H', index: 0 },
  conflictsSince: '2026-10-28T23:59:59Z',
  vars: {
    guia: { from: 'A', ops: [{ op: 'text' }] },
    cargo: { from: 'A', ops: [{ op: 'upper' }, { op: 'map', table: { ADUANERO: 'cargo' }, unmapped: 'empty' }] },
    cliente: { from: 'B', ops: [{ op: 'text' }] },
    kilos: { from: 'C', ops: [{ op: 'number' }] },
    n: { from: 'D', ops: [{ op: 'digits' }] },
    fva: { from: 'E', ops: [{ op: 'text' }] },
    monto: { from: 'C', ops: [{ op: 'number' }] },
    estado: { from: 'F', ops: [{ op: 'test', pattern: 'ok', flags: 'i', then: 'OK', else: 'Pendiente' }] },
  },
  chargeWhen: [{ var: 'cargo', equals: 'cargo' }],
  rowWhen: [{ var: 'guia', empty: false }],
  child: {
    tracker: 'guias',
    key: 'imp:{guia}|{n}',
    fields: {
      guia: { var: 'guia' },
      fva: { var: 'fva' },
      kilos: { var: 'kilos' },
      estado: { var: 'estado', keepIf: ['Enviado a Siigo'] },
      origen: { const: 'Importado', on: 'insert' },
    },
    relations: { cliente: { tracker: 'clientes', by: 'label', var: 'cliente' } },
    parentField: 'manifiesto',
  },
  parent: {
    tracker: 'manifiestos',
    groupVar: 'n',
    key: 'imp:m:{n}',
    fields: {
      n_manifiesto: { agg: 'first', var: 'n' },
      fva: { agg: 'distinct', var: 'fva' },
      cobro: { agg: 'sum', var: 'monto', rows: 'charge' },
      nombre: { on: 'insert', derive: [{ when: [{ field: 'fva', empty: true }], value: 'Sin FVA · {key}' }, { value: '{fva}' }] },
    },
  },
};
const HEAD = ['GUIA', 'CLIENTE', 'KILOS', 'MANIFIESTO', 'FVA', 'ESTADO'];
const sheetOf = (...r: Array<Array<string | number | null>>): SheetData => ({ name: 'H', rows: [HEAD, ...r] });
const sync = { tracker_id: 'T-G', created_by: 'u1', spec };

beforeEach(() => {
  writes = 0;
  rows = [
    { id: '11111111-1111-1111-1111-111111111111', tracker_id: 'T-C', label: 'BBIC', values: { nombre: 'BBIC', nit: '901' }, external_key: null, updated_at: '2026-01-01T00:00:00Z' },
  ];
});

describe('runGroupedSync', () => {
  const base = sheetOf(['G1', 'bbic', 10, 'N° 1', 'FLEX 1', 'OK'], ['G2', 'BBIC', 20, 'N° 1', 'FLEX 1', 'OK'], ['Aduanero', 'BBIC', 600, 'N° 1', null, null]);

  it('el ensayo cuenta y no escribe nada', async () => {
    const run = await runGroupedSync(fakeDb(), sync, base, { dryRun: true });
    expect(run.report.children).toMatchObject({ planned: 2, insert: 2, update: 0 });
    expect(run.report.parents).toMatchObject({ planned: 1, insert: 1 });
    expect(writes).toBe(0);
    expect(rows).toHaveLength(1);
  });

  it('la corrida real inserta padres e hijas con relación y lookups, y la segunda no cambia nada', async () => {
    const first = await runGroupedSync(fakeDb(), sync, base);
    expect(first.inserted).toBe(2);
    const parent = rows.find((r) => r.tracker_id === 'T-M');
    expect(parent?.values).toMatchObject({ nombre: 'FLEX 1', n_manifiesto: '1', cobro: 600, estado: 'Pendiente' });
    const g1 = rows.find((r) => r.external_key === 'imp:G1|1');
    expect(g1?.values).toMatchObject({ guia: 'G1', kilos: 10, origen: 'Importado', nit: '901' });
    expect(JSON.parse(String(g1?.values.manifiesto)).id).toBe(parent?.id);
    const before = JSON.stringify(rows);
    const w = writes;
    const second = await runGroupedSync(fakeDb(), sync, base);
    expect(second.report.children).toMatchObject({ insert: 0, update: 0, unchanged: 2 });
    expect(second.report.parents).toMatchObject({ insert: 0, update: 0, unchanged: 1 });
    expect(writes).toBe(w);
    expect(JSON.stringify(rows)).toBe(before);
  });

  it('la hoja gana en lo cambiado, reporta conflictos y lo que ya no está, y no borra', async () => {
    await runGroupedSync(fakeDb(), sync, base);
    const g1 = rows.find((r) => r.external_key === 'imp:G1|1') as Row;
    g1.values.kilos = 99; // alguien lo editó en la app
    g1.updated_at = '2026-11-03T12:00:00Z';
    const next = sheetOf(['G1', 'BBIC', 10, 'N° 1', 'FLEX 1', 'OK'], ['G3', 'BBIC', 5, 'N° 1', 'FLEX 1', 'OK'], ['Aduanero', 'BBIC', 600, 'N° 1', null, null]);
    const dry = await runGroupedSync(fakeDb(), sync, next, { dryRun: true });
    expect(dry.report.children).toMatchObject({ insert: 1, update: 1 });
    expect(dry.report.conflicts).toHaveLength(1);
    expect(dry.report.conflicts[0]).toMatchObject({ key: 'imp:G1|1', changes: [{ field: 'kilos', before: '99', after: '10' }] });
    expect(dry.report.missing.children).toBe(1);
    expect(dry.report.missing.sample).toContain('imp:G2|1');
    const total = rows.length;
    await runGroupedSync(fakeDb(), sync, next);
    expect(rows.length).toBe(total + 1); // sólo G3; G2 sigue ahí
    expect(rows.find((r) => r.external_key === 'imp:G2|1')).toBeTruthy();
    expect((rows.find((r) => r.external_key === 'imp:G1|1') as Row).values.kilos).toBe(10);
  });

  it('respeta una fila creada en la app y el estado que la app ya avanzó', async () => {
    await runGroupedSync(fakeDb(), sync, base);
    rows.push({ id: 'zz', tracker_id: 'T-G', label: 'G2', values: { guia: 'G2' }, external_key: null, updated_at: '2026-11-05T00:00:00Z' });
    (rows.find((r) => r.external_key === 'imp:G1|1') as Row).values.estado = 'Enviado a Siigo';
    const later = sheetOf(['G1', 'BBIC', 10, 'N° 1', 'FLEX 1', null], ['G2', 'BBIC', 20, 'N° 1', 'FLEX 1', 'OK']);
    const run = await runGroupedSync(fakeDb(), sync, later);
    expect(run.report.appDuplicates).toEqual(['G2']);
    expect(rows.find((r) => r.id === 'zz')?.values).toEqual({ guia: 'G2' });
    expect((rows.find((r) => r.external_key === 'imp:G1|1') as Row).values.estado).toBe('Enviado a Siigo');
  });

  it('un cliente que no existe se reporta y la fila no entra (cliente obligatorio)', async () => {
    const run = await runGroupedSync(fakeDb(), sync, sheetOf(['G9', 'OTRO', 3, 'N° 5', 'FLEX 9', 'OK']), { dryRun: true });
    expect(run.report.unresolved.cliente).toEqual({ OTRO: 1 });
    expect(run.report.children.rejected).toBe(1);
  });

  it('una pestaña vacía no se aplica', async () => {
    await expect(runGroupedSync(fakeDb(), sync, sheetOf())).rejects.toThrow(/ninguna fila/);
  });
});
