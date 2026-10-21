import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it } from 'vitest';
import { createFakeSupabase } from '../tenancy/__tests__/fake-postgrest';
import type { TrackerOrigin } from './origin';
import type { TrackerField } from './schema';
import {
  type TrackerRow,
  defineTracker,
  getTrackerBySlug,
  setTrackerOrigin,
  upsertRow,
} from './store';

/**
 * Los escritores contra una base de mentira: la tabla que viene de una
 * integración rechaza escribir un campo del origen y filas a mano, en el único
 * punto (`upsertRow`) por el que pasan grilla, chat, apps y automatizaciones;
 * `defineTracker` sólo deja agregar o cambiar campos propios; y las
 * sincronizaciones lo evitan con `system`.
 */

const f = (key: string, type: TrackerField['type'] = 'text'): TrackerField =>
  ({ key, label: key, type, required: false }) as TrackerField;

const siigo: TrackerOrigin = {
  kind: 'accounting',
  provider: 'siigo',
  label: 'Siigo',
  ref: 'conn-1',
  fields: ['numero', 'total'],
  creates: true,
};

let seq = 0;
function world(origins: TrackerOrigin[] = [siigo]) {
  const fake = createFakeSupabase({
    trackers: [
      {
        id: 't1',
        slug: 'siigo_facturas',
        name: 'Facturas (Siigo)',
        description: '',
        fields: [f('numero'), f('total', 'money'), f('responsable')],
        origins,
        created_by: null,
        created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-01T00:00:00Z',
      },
    ],
    tracker_rows: [
      {
        id: 'r1',
        tracker_id: 't1',
        label: 'FV-1',
        external_key: 'FV-1',
        values: { numero: 'FV-1', total: 100 },
        created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-01T00:00:00Z',
      },
    ],
    custom_app_automations: [],
  });
  const raw = fake.client;
  const from = raw.from.bind(raw);
  const db = {
    ...raw,
    from: (table: string) => {
      // biome-ignore lint/suspicious/noExplicitAny: envuelve el builder del doble
      const qb = from(table) as any;
      const insert = qb.insert.bind(qb);
      qb.insert = (v: Record<string, unknown>) =>
        insert({
          id: `new-${++seq}`,
          created_at: '2026-10-02T00:00:00Z',
          updated_at: '2026-10-02T00:00:00Z',
          ...v,
        });
      return qb;
    },
  } as unknown as SupabaseClient;
  return { db, tables: fake.tables };
}

async function tracker(db: SupabaseClient): Promise<TrackerRow> {
  const t = await getTrackerBySlug(db, 'siigo_facturas');
  if (!t) throw new Error('falta la tabla de la prueba');
  return t;
}

describe('upsertRow contra una tabla sincronizada', () => {
  let w: ReturnType<typeof world>;
  beforeEach(() => {
    w = world();
  });

  it('rechaza cambiar un campo del origen (celda, chat, botón: todos pasan por aquí)', async () => {
    const t = await tracker(w.db);
    await expect(
      upsertRow(w.db, {
        tracker: t,
        rowId: 'r1',
        values: { numero: 'FV-1', total: 999 },
        userId: 'u1',
      }),
    ).rejects.toThrow('«total» viene de Siigo');
    expect((w.tables.tracker_rows?.[0] as { values: Record<string, unknown> }).values.total).toBe(
      100,
    );
  });

  it('rechaza agregar filas a mano', async () => {
    const t = await tracker(w.db);
    await expect(
      upsertRow(w.db, { tracker: t, values: { responsable: 'Ana' }, userId: 'u1' }),
    ).rejects.toThrow('Esta tabla se llena sola desde Siigo');
    expect(w.tables.tracker_rows).toHaveLength(1);
  });

  it('deja editar un campo propio y conserva los del origen', async () => {
    const t = await tracker(w.db);
    const saved = await upsertRow(w.db, {
      tracker: t,
      rowId: 'r1',
      values: { numero: 'FV-1', total: 100, responsable: 'Ana' },
      userId: 'u1',
    });
    expect(saved.values.responsable).toBe('Ana');
    expect(saved.values.total).toBe(100);
  });

  it('una tabla sin origen se escribe como siempre', async () => {
    const own = world([]);
    const t = await tracker(own.db);
    const saved = await upsertRow(own.db, {
      tracker: t,
      rowId: 'r1',
      values: { total: 5 },
      userId: 'u1',
    });
    expect(saved.values.total).toBe(5);
    const made = await upsertRow(own.db, { tracker: t, values: { numero: 'x' }, userId: 'u1' });
    expect(made.values.numero).toBe('x');
  });
});

describe('defineTracker sobre una tabla sincronizada', () => {
  it('agrega un campo propio y lo conserva en la tabla', async () => {
    const w = world();
    const t = await tracker(w.db);
    const out = await defineTracker(w.db, {
      slug: t.slug,
      name: t.name,
      description: '',
      fields: [...t.fields, f('estado_cobro')],
      userId: 'u1',
    });
    expect(out.tracker.fields.map((x) => x.key)).toContain('estado_cobro');
    expect(out.tracker.origins?.[0]?.fields).toEqual(['numero', 'total']);
  });

  it('rechaza quitar o cambiar un campo del origen', async () => {
    const w = world();
    const t = await tracker(w.db);
    await expect(
      defineTracker(w.db, {
        slug: t.slug,
        name: t.name,
        description: '',
        fields: t.fields.filter((x) => x.key !== 'total'),
        userId: 'u1',
      }),
    ).rejects.toThrow('no se puede quitar');
    await expect(
      defineTracker(w.db, {
        slug: t.slug,
        name: t.name,
        description: '',
        fields: t.fields.map((x) => (x.key === 'total' ? f('total', 'text') : x)),
        userId: 'u1',
      }),
    ).rejects.toThrow('viene de Siigo');
  });

  it('la propia sincronización (system) sí puede cambiar el campo del origen', async () => {
    const w = world();
    const t = await tracker(w.db);
    const out = await defineTracker(w.db, {
      slug: t.slug,
      name: t.name,
      description: '',
      fields: t.fields.map((x) => (x.key === 'total' ? f('total', 'number') : x)),
      userId: 'u1',
      system: true,
    });
    expect(out.tracker.fields.find((x) => x.key === 'total')?.type).toBe('number');
  });
});

describe('setTrackerOrigin', () => {
  it('marca la tabla, no duplica y conserva writeBack', async () => {
    const w = world([]);
    const sheet: TrackerOrigin = {
      kind: 'sheet',
      label: 'la hoja «V»',
      ref: 's1',
      fields: ['numero'],
      creates: true,
    };
    await setTrackerOrigin(w.db, 't1', sheet);
    await setTrackerOrigin(w.db, 't1', { ...sheet, writeBack: true });
    await setTrackerOrigin(w.db, 't1', { ...sheet, fields: ['numero', 'total'] });
    const t = await tracker(w.db);
    expect(t.origins).toHaveLength(1);
    expect(t.origins?.[0]?.fields).toEqual(['numero', 'total']);
    expect(t.origins?.[0]?.writeBack).toBe(true);
  });
});

describe('upsertRow contra una tabla de hoja o carpeta (filas a mano libres)', () => {
  const sheet: TrackerOrigin = {
    kind: 'sheet',
    label: 'la hoja «Prealertas»',
    ref: 's1',
    fields: ['numero', 'total'],
    creates: true,
  };

  it('crea filas a mano, edita las suyas y rechaza los campos de las que trajo la hoja', async () => {
    const w = world([sheet]);
    (w.tables.tracker_rows as Array<Record<string, unknown>>).push({
      id: 'manual',
      tracker_id: 't1',
      label: 'M-1',
      external_key: null,
      values: { numero: 'M-1', total: 5 },
      created_at: 'x',
      updated_at: 'x',
    });
    const t = await tracker(w.db);
    // Una fila nueva, hecha a mano (formulario, grilla, chat, apps).
    const made = await upsertRow(w.db, {
      tracker: t,
      values: { numero: 'M-2', total: 7 },
      userId: 'u1',
    });
    expect(made.values.numero).toBe('M-2');
    // Editar un campo de la hoja en una fila a mano: libre.
    const edited = await upsertRow(w.db, {
      tracker: t,
      rowId: 'manual',
      values: { numero: 'M-1', total: 9 },
      userId: 'u1',
    });
    expect(edited.values.total).toBe(9);
    // La fila que trajo la hoja (r1 tiene external_key): cerrada en sus campos.
    await expect(
      upsertRow(w.db, {
        tracker: t,
        rowId: 'r1',
        values: { numero: 'FV-1', total: 999 },
        userId: 'u1',
      }),
    ).rejects.toThrow('viene de la hoja');
    // Y sus campos propios, libres.
    const own = await upsertRow(w.db, {
      tracker: t,
      rowId: 'r1',
      values: { numero: 'FV-1', total: 100, responsable: 'Ana' },
      userId: 'u1',
    });
    expect(own.values.responsable).toBe('Ana');
  });
});
