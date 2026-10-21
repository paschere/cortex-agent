import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { upsertAccountingRows } from '../accounting/sync';
import { ensureAccountingTable } from '../accounting/sync';
import { siigoProvider } from '../accounting/providers/siigo';
import { accountingTableSpec } from '../accounting/tables';
import { mergeRowValues } from '../drive-table/plan';
import { applyUpdateOnly } from '../table-sync/enrich';
import { applyTrackerSync, mergeOwnValues } from '../table-sync/sync';
import { createFakeSupabase } from '../tenancy/__tests__/fake-postgrest';
import type { TrackerField } from './schema';
import { getTrackerById } from './store';

/**
 * Cada escritor de sincronización conserva los campos PROPIOS de la empresa al
 * actualizar una fila (merge, no reemplazo de `values`): «responsable» y
 * «notas» sobreviven a cualquier lectura de la hoja, de la carpeta o del programa.
 */

const f = (key: string, type: TrackerField['type'] = 'text'): TrackerField =>
  ({ key, label: key, type, required: false }) as TrackerField;

let seq = 0;
function world(seed: Record<string, Array<Record<string, unknown>>>) {
  const fake = createFakeSupabase({ custom_app_automations: [], ...seed });
  const raw = fake.client;
  const from = raw.from.bind(raw);
  const db = {
    ...raw,
    from: (table: string) => {
      // biome-ignore lint/suspicious/noExplicitAny: envuelve el builder del doble
      const qb = from(table) as any;
      const insert = qb.insert.bind(qb);
      qb.insert = (v: unknown) => {
        const stamp = (r: Record<string, unknown>) => ({
          id: `n-${++seq}`,
          created_at: '2026-10-02T00:00:00Z',
          updated_at: '2026-10-02T00:00:00Z',
          ...r,
        });
        return insert(Array.isArray(v) ? v.map(stamp) : stamp(v as Record<string, unknown>));
      };
      return qb;
    },
  } as unknown as SupabaseClient;
  return { db, tables: fake.tables };
}

const rowOf = (tables: Record<string, unknown[]>, id: string) =>
  (tables.tracker_rows as Array<{ id: string; values: Record<string, unknown> }>).find(
    (r) => r.id === id,
  ) as { id: string; values: Record<string, unknown> };

describe('hoja → tabla (applyTrackerSync)', () => {
  const fields = [f('vuelo'), f('estado'), f('responsable'), f('notas')];
  const tracker = {
    id: 't1',
    slug: 'vuelos',
    name: 'Vuelos',
    description: '',
    fields,
    origins: [],
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
  };

  it('actualiza lo que viene de la hoja y deja intactos los campos propios', async () => {
    const w = world({
      trackers: [tracker],
      tracker_rows: [
        {
          id: 'r1',
          tracker_id: 't1',
          label: 'AV9',
          external_key: 'AV9',
          values: {
            vuelo: 'AV9',
            estado: 'active',
            responsable: 'Ana',
            notas: 'llamar al cliente',
          },
          created_at: '2026-10-01T00:00:00Z',
          updated_at: '2026-10-01T00:00:00Z',
        },
      ],
    });
    const outcome = await applyTrackerSync(
      w.db,
      {
        tracker_id: 't1',
        created_by: 'u1',
        mode: 'upsert',
        mapping: { vuelo: 'flight', estado: 'status' },
        key_fields: ['vuelo'],
      },
      {
        name: 'API',
        rows: [
          ['flight', 'status'],
          ['AV9', 'landed'],
          ['LA40', 'active'],
        ],
      },
    );
    expect(outcome.updated).toBe(1);
    expect(outcome.inserted).toBe(1);
    expect(rowOf(w.tables, 'r1').values).toMatchObject({
      estado: 'landed',
      responsable: 'Ana',
      notas: 'llamar al cliente',
    });
  });

  it('las filas hechas a mano (sin external_key) no se tocan ni se borran', async () => {
    const manual = {
      id: 'm1',
      tracker_id: 't1',
      label: 'Hecha a mano',
      external_key: null,
      values: { vuelo: 'AV9', estado: 'pendiente', responsable: 'Luis' },
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-01T00:00:00Z',
    };
    const w = world({ trackers: [tracker], tracker_rows: [manual] });
    await applyTrackerSync(
      w.db,
      {
        tracker_id: 't1',
        created_by: 'u1',
        mode: 'upsert',
        mapping: { vuelo: 'flight', estado: 'status' },
        key_fields: ['vuelo'],
      },
      {
        name: 'API',
        rows: [
          ['flight', 'status'],
          ['AV9', 'landed'],
        ],
      },
    );
    const rows = w.tables.tracker_rows as Array<{ id: string; values: Record<string, unknown> }>;
    // La de la hoja entra aparte; la manual queda exactamente como estaba.
    expect(rows).toHaveLength(2);
    expect(rowOf(w.tables, 'm1')).toEqual(manual);
  });

  it('mergeOwnValues no revive un campo que la tabla ya no declara', () => {
    expect(
      mergeOwnValues([{ key: 'a' }, { key: 'b' }], { a: 1, b: 2, borrado: 'x' }, { a: 9 }),
    ).toEqual({ a: 9, b: 2 });
  });
});

describe('hoja que actualiza filas existentes (applyUpdateOnly)', () => {
  it('escribe sólo lo pedido: la clave y los campos propios quedan como estaban', async () => {
    const fields = [f('guia'), f('vuelo'), f('estado_vuelo'), f('dolly')];
    const w = world({
      trackers: [
        {
          id: 't2',
          slug: 'guias',
          name: 'Guías',
          description: '',
          fields,
          origins: [],
          created_at: 'x',
          updated_at: 'x',
        },
      ],
      tracker_rows: [
        {
          id: 'g1',
          tracker_id: 't2',
          label: '045-1',
          external_key: '045-1',
          values: { guia: '045-1', vuelo: 'AV9', dolly: 'D-7' },
          created_at: 'x',
          updated_at: 'x',
        },
      ],
    });
    await applyUpdateOnly(
      w.db,
      {
        tracker_id: 't2',
        created_by: 'u',
        key_fields: ['vuelo'],
        mapping: { vuelo: 'flight', estado_vuelo: 'status' },
      },
      {
        name: 'API',
        rows: [
          ['flight', 'status'],
          ['AV9', 'landed'],
        ],
      },
    );
    expect(rowOf(w.tables, 'g1').values).toMatchObject({
      guia: '045-1',
      dolly: 'D-7',
      estado_vuelo: 'landed',
    });
  });
});

describe('carpeta de Drive (mergeRowValues)', () => {
  it('al releer un archivo, el estado y el dolly del equipo se quedan', () => {
    const merged = mergeRowValues({
      existing: { guia: '045-1', peso: 10, dolly: 'D-7', estado: 'Asignada' },
      planned: { key: '045-1', values: { guia: '045-1', peso: 12 }, review: [] } as never,
      defaults: { estado: 'Pendiente' },
      reviewField: null,
    });
    expect(merged).toEqual({ guia: '045-1', peso: 12, dolly: 'D-7', estado: 'Asignada' });
  });
});

describe('programa contable (upsertAccountingRows / ensureAccountingTable)', () => {
  const spec = accountingTableSpec(siigoProvider, 'invoices');

  it('una factura que cambia en Siigo conserva «responsable» y «notas» de la empresa', async () => {
    const own = [f('responsable'), f('notas', 'longtext')];
    const w = world({
      trackers: [
        {
          id: 't3',
          slug: spec.slug,
          name: spec.name,
          description: '',
          fields: [...spec.fields, ...own],
          origins: [],
          created_at: 'x',
          updated_at: 'x',
        },
      ],
      tracker_rows: [
        {
          id: 'i1',
          tracker_id: 't3',
          label: 'FV-1',
          external_key: 'FV-1',
          values: { numero: 'FV-1', total: 100, responsable: 'Ana', notas: 'cobrar el lunes' },
          created_at: 'x',
          updated_at: 'x',
        },
      ],
    });
    const table = await getTrackerById(w.db, 't3');
    if (!table) throw new Error('sin tabla');
    const counts = { fetched: 1, inserted: 0, updated: 0, unchanged: 0, skipped: 0 };
    await upsertAccountingRows(
      w.db,
      table,
      [{ key: 'FV-1', values: { numero: 'FV-1', total: 250 } }],
      'u1',
      counts,
      [],
    );
    expect(counts.updated).toBe(1);
    expect(rowOf(w.tables, 'i1').values).toMatchObject({
      total: 250,
      responsable: 'Ana',
      notas: 'cobrar el lunes',
    });
  });

  it('la tabla queda marcada con su origen y los campos propios no entran a la lista', async () => {
    const w = world({
      trackers: [
        {
          id: 't3',
          slug: spec.slug,
          name: spec.name,
          description: '',
          fields: [...spec.fields, f('responsable')],
          origins: [],
          created_at: 'x',
          updated_at: 'x',
        },
      ],
    });
    await ensureAccountingTable(w.db, spec, 't3', 'u1', {
      connectionId: 'conn-9',
      provider: 'siigo',
    });
    const t = await getTrackerById(w.db, 't3');
    const origin = t?.origins?.[0];
    expect(origin).toMatchObject({
      kind: 'accounting',
      provider: 'siigo',
      ref: 'conn-9',
      creates: true,
    });
    expect(origin?.fields).toEqual(spec.fields.map((x) => x.key));
    expect(origin?.fields).not.toContain('responsable');
  });
});
