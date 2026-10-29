import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { editAccessFor } from '../apps/permissions';
import { createFakeSupabase } from '../tenancy/__tests__/fake-postgrest';
import type { TrackerOrigin } from '../trackers/origin';
import { type CatalogTracker, checkSpecAgainst, findWriteBlock, viewSpecSchema } from './spec';
import { type CustomViewRow, editViewRow } from './store';
import { computeView, type ViewRow, type ViewSource } from './compute';

/** Editar un campo del PADRE desde la tarjeta del grupo de una hoja (`group.editableParent`). */

const siigo: TrackerOrigin = {
  kind: 'accounting',
  provider: 'siigo',
  label: 'Siigo',
  ref: 'c1',
  fields: ['total'],
  creates: false,
};

const manifiestosFields = [
  { key: 'numero', label: 'N° manifiesto', type: 'text', required: false },
  { key: 'cobro_adicional', label: 'Cobro adicional', type: 'money', required: false },
  { key: 'estado', label: 'Estado', type: 'select', required: false, options: ['Abierto', 'Cerrado'] },
  { key: 'total', label: 'Total', type: 'money', required: false },
  { key: 'doble', label: 'Doble', type: 'money', required: false, formula: '[total] × 2' },
  { key: 'foto', label: 'Foto', type: 'file', required: false },
] as const;
const guiasFields = [
  { key: 'guia', label: 'Guía', type: 'text', required: false },
  { key: 'manifiesto', label: 'Manifiesto', type: 'relation', tracker: 'manifiestos', required: false },
] as const;

const catalog = (): CatalogTracker[] =>
  [
    { slug: 'manifiestos', name: 'Manifiestos', fields: manifiestosFields, origins: [siigo] },
    { slug: 'guias', name: 'Guías', fields: guiasFields },
  ] as unknown as CatalogTracker[];

const mkSpec = (editableParent: string[] | undefined, parentFields = ['numero', 'cobro_adicional', 'estado', 'total', 'doble', 'foto']) =>
  viewSpecSchema.parse({
    version: 1,
    editing: 'team',
    blocks: [
      {
        id: 'hoja',
        title: 'Guías',
        type: 'sheet',
        tracker: 'guias',
        columns: ['guia'],
        editable: ['guia'],
        group: { by: 'manifiesto', parentTracker: 'manifiestos', parentFields, ...(editableParent ? { editableParent } : {}) },
      },
    ],
  });

describe('editableParent: validación del spec', () => {
  it('acepta campos propios y escribibles de parentFields', () => {
    expect(checkSpecAgainst(mkSpec(['cobro_adicional', 'estado', 'numero']), catalog())).toEqual([]);
  });
  it('rechaza uno que no está en parentFields', () => {
    const p = checkSpecAgainst(mkSpec(['cobro_adicional'], ['numero']), catalog()).join(' ');
    expect(p).toContain('parentFields');
  });
  it('rechaza fórmulas, archivos y campos que vienen de una integración', () => {
    expect(checkSpecAgainst(mkSpec(['doble']), catalog()).join(' ')).toContain('se calcula sola');
    expect(checkSpecAgainst(mkSpec(['foto']), catalog()).join(' ')).toContain('tipo file');
    expect(checkSpecAgainst(mkSpec(['total']), catalog()).join(' ')).toContain('Siigo');
  });
  it('rechaza más de 6 y un campo que no existe', () => {
    expect(viewSpecSchema.safeParse({ ...mkSpec(['numero']), blocks: [{ ...mkSpec(['numero']).blocks[0], group: { by: 'manifiesto', parentTracker: 'manifiestos', editableParent: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] } }] }).success).toBe(false);
    expect(checkSpecAgainst(mkSpec(['nada'], ['numero', 'nada']), catalog()).join(' ')).toContain('no es un campo');
  });
});

describe('editableParent: lista blanca y rol', () => {
  it('`<hoja>:parent` es una tabla propia con sólo los editableParent', () => {
    const b = findWriteBlock(mkSpec(['cobro_adicional']), 'hoja:parent');
    expect(b).toMatchObject({ type: 'table', tracker: 'manifiestos', editable: ['cobro_adicional'] });
    expect(findWriteBlock(mkSpec(undefined), 'hoja:parent')).toBeUndefined();
  });
  it('el rol se juzga sobre la tabla padre', () => {
    const role = (edit: 'none' | 'own' | 'all') =>
      ({ admin: false, permissions: { tables: { guias: { edit: 'all' }, manifiestos: { edit } } } }) as never;
    expect(editAccessFor(role('none'), 'manifiestos')).toBe('none');
    expect(editAccessFor(role('all'), 'manifiestos')).toBe('all');
  });
});

function world() {
  const fake = createFakeSupabase({
    trackers: [
      { id: 'tm', slug: 'manifiestos', name: 'Manifiestos', description: '', fields: manifiestosFields, origins: [siigo], created_at: 'x', updated_at: 'x' },
      { id: 'tg', slug: 'guias', name: 'Guías', description: '', fields: guiasFields, created_at: 'x', updated_at: 'x' },
    ],
    tracker_rows: [
      { id: 'm1', tracker_id: 'tm', label: 'M1', values: { numero: '1', cobro_adicional: 10, total: 5 }, created_at: 'x', updated_at: 'x' },
      { id: 'g1', tracker_id: 'tg', label: 'G1', values: { guia: 'A' }, created_at: 'x', updated_at: 'x' },
    ],
    custom_view_events: [],
    custom_app_automations: [],
  });
  return { db: fake.client as unknown as SupabaseClient, tables: fake.tables };
}
const viewOf = (editableParent: string[]) =>
  ({ id: 'v1', slug: 'v', name: 'V', spec: mkSpec(editableParent) }) as unknown as CustomViewRow;

describe('editableParent: el servidor', () => {
  it('deja escribir un campo permitido en la fila del padre', async () => {
    const w = world();
    await editViewRow(w.db, viewOf(['cobro_adicional']), {
      blockId: 'hoja:parent',
      rowId: 'm1',
      patch: { cobro_adicional: 25 },
      actor: 'u1',
    });
    const m = (w.tables.tracker_rows as Array<{ id: string; values: Record<string, unknown> }>).find((r) => r.id === 'm1');
    expect(m?.values.cobro_adicional).toBe(25);
    expect((w.tables.custom_view_events as unknown[]).length).toBe(1);
  });
  it('rechaza un campo que no está en editableParent', async () => {
    const w = world();
    await expect(
      editViewRow(w.db, viewOf(['cobro_adicional']), { blockId: 'hoja:parent', rowId: 'm1', patch: { estado: 'Cerrado' }, actor: 'u1' }),
    ).rejects.toThrow('no deja cambiar');
  });
  it('rechaza un campo del origen aunque un spec viejo lo listara', async () => {
    const w = world();
    await expect(
      editViewRow(w.db, viewOf(['total']), { blockId: 'hoja:parent', rowId: 'm1', patch: { total: 9 }, actor: 'u1' }),
    ).rejects.toThrow('Siigo');
  });
  it('sin editableParent la hoja no escribe en el padre', async () => {
    const w = world();
    const v = { id: 'v1', slug: 'v', name: 'V', spec: mkSpec(undefined) } as unknown as CustomViewRow;
    await expect(
      editViewRow(v ? w.db : w.db, v, { blockId: 'hoja:parent', rowId: 'm1', patch: { cobro_adicional: 1 }, actor: 'u1' }),
    ).rejects.toThrow('no está en esta vista');
  });
  it('no escribe en la hoja misma campos del padre', async () => {
    const w = world();
    await expect(
      editViewRow(w.db, viewOf(['cobro_adicional']), { blockId: 'hoja', rowId: 'g1', patch: { cobro_adicional: 1 }, actor: 'u1' }),
    ).rejects.toThrow('no deja cambiar');
  });
});

describe('editableParent: cálculo', () => {
  const at = '2026-10-27T00:00:00.000Z';
  const M1 = '00000000-0000-4000-8000-000000000001';
  const r = (id: string, values: ViewRow['values']): ViewRow => ({ id, label: id, values, created_by: null, created_at: at, updated_at: at });
  const cat = catalog();
  const sources = new Map<string, ViewSource>([
    ['manifiestos', { tracker: cat[0] as CatalogTracker, truncated: false, rows: [r(M1, { numero: '1', cobro_adicional: 10, estado: 'Abierto' })] }],
    ['guias', { tracker: cat[1] as CatalogTracker, truncated: false, rows: [r('g1', { guia: 'A', manifiesto: JSON.stringify({ id: M1, label: 'M1' }) })] }],
  ]);
  const sheet = (v: ReturnType<typeof computeView>) => v.blocks[0] as unknown as { groups: Array<{ parentEdit?: { rowId: string; fields: Array<{ key: string; raw: string; index: number }> } }> };
  it('trae la fila padre y los campos editables sólo a quien escribe', () => {
    const s = mkSpec(['cobro_adicional', 'estado']);
    const w = sheet(computeView(s, sources, new Date(at), { writable: true }));
    expect(w.groups[0]?.parentEdit?.rowId).toBe(M1);
    expect(w.groups[0]?.parentEdit?.fields.map((f) => [f.key, f.raw])).toEqual([['cobro_adicional', '10'], ['estado', 'Abierto']]);
    const ro = sheet(computeView(s, sources, new Date(at), { writable: false }));
    expect(ro.groups[0]?.parentEdit).toBeUndefined();
  });
});
