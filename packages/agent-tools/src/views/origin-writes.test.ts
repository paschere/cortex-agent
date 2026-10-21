import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { createFakeSupabase } from '../tenancy/__tests__/fake-postgrest';
import type { TrackerOrigin } from '../trackers/origin';
import { viewSpecSchema } from './spec';
import { type CustomViewRow, editViewRow, submitViewForm } from './store';

/**
 * Las escrituras de una vista (celda, ficha, botón, formulario) contra una tabla
 * que viene de una integración: el servidor rechaza el campo del origen y la
 * fila a mano, aunque alguien mande la petición sin pasar por la pantalla.
 */

const siigo: TrackerOrigin = {
  kind: 'accounting',
  provider: 'siigo',
  label: 'Siigo',
  ref: 'conn-1',
  fields: ['numero', 'total'],
  creates: true,
};

function world(origins: TrackerOrigin[] = [siigo]) {
  const fake = createFakeSupabase({
    trackers: [
      {
        id: 't1',
        slug: 'siigo_facturas',
        name: 'Facturas (Siigo)',
        description: '',
        fields: [
          { key: 'numero', label: 'Número', type: 'text', required: false },
          { key: 'total', label: 'Total', type: 'money', required: false },
          { key: 'responsable', label: 'Responsable', type: 'text', required: false },
        ],
        origins,
        created_at: 'x',
        updated_at: 'x',
      },
    ],
    tracker_rows: [
      {
        id: 'r1',
        tracker_id: 't1',
        label: 'FV-1',
        external_key: 'FV-1',
        values: { numero: 'FV-1', total: 100 },
        created_at: 'x',
        updated_at: 'x',
      },
    ],
    custom_view_events: [],
    custom_view_submissions: [],
    custom_app_automations: [],
  });
  return { db: fake.client as unknown as SupabaseClient, tables: fake.tables };
}

const view = {
  id: 'v1',
  slug: 'v',
  name: 'V',
  description: '',
  version: 1,
  visibility: 'private',
  share_token: null,
  share_expires_at: null,
  share_views: 0,
  pinned: false,
  created_by: null,
  updated_by: null,
  created_at: 'x',
  updated_at: 'x',
  archived_at: null,
  spec: viewSpecSchema.parse({
    version: 1,
    editing: 'team',
    blocks: [
      {
        id: 't',
        type: 'table',
        title: 'Facturas',
        tracker: 'siigo_facturas',
        columns: ['numero', 'total', 'responsable'],
        // Un spec viejo que ya traía una columna del origen como editable.
        editable: ['total', 'responsable'],
      },
      { id: 'f', type: 'form', title: 'Nueva', tracker: 'siigo_facturas', fields: ['responsable'] },
    ],
  }),
} as unknown as CustomViewRow;

describe('vistas: escrituras contra una tabla sincronizada', () => {
  it('rechaza editar un campo del origen aunque el spec viejo lo listara', async () => {
    const w = world();
    await expect(
      editViewRow(w.db, view, { blockId: 't', rowId: 'r1', patch: { total: 5 }, actor: 'u1' }),
    ).rejects.toThrow('«Total» viene de Siigo');
    expect((w.tables.tracker_rows?.[0] as { values: { total: number } }).values.total).toBe(100);
  });

  it('deja editar un campo propio', async () => {
    const w = world();
    const out = await editViewRow(w.db, view, {
      blockId: 't',
      rowId: 'r1',
      patch: { responsable: 'Ana' },
      actor: 'u1',
    });
    expect(out.label).toBeTruthy();
    expect(
      (w.tables.tracker_rows?.[0] as { values: Record<string, unknown> }).values,
    ).toMatchObject({
      total: 100,
      responsable: 'Ana',
    });
  });

  it('el formulario no crea filas en una tabla que se llena sola', async () => {
    const w = world();
    await expect(
      submitViewForm(w.db, view, {
        blockId: 'f',
        values: { responsable: 'Ana' },
        submittedBy: 'u1',
      }),
    ).rejects.toThrow('Esta tabla se llena sola desde Siigo');
    expect(w.tables.tracker_rows).toHaveLength(1);
  });
});

describe('vistas: tabla de una hoja (filas a mano libres)', () => {
  const sheet: TrackerOrigin = {
    kind: 'sheet',
    label: 'la hoja «Prealertas»',
    ref: 's1',
    fields: ['numero', 'total'],
    creates: true,
  };

  it('el formulario crea filas y la celda de una fila a mano se edita', async () => {
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
    await submitViewForm(w.db, view, {
      blockId: 'f',
      values: { responsable: 'Ana' },
      submittedBy: 'u1',
    });
    expect(w.tables.tracker_rows).toHaveLength(3);
    await editViewRow(w.db, view, {
      blockId: 't',
      rowId: 'manual',
      patch: { total: 8 },
      actor: 'u1',
    });
    expect(
      (w.tables.tracker_rows as Array<{ id: string; values: { total: number } }>).find(
        (r) => r.id === 'manual',
      )?.values.total,
    ).toBe(8);
  });

  it('pero una fila que trajo la hoja sigue cerrada en sus campos', async () => {
    const w = world([sheet]);
    await expect(
      editViewRow(w.db, view, { blockId: 't', rowId: 'r1', patch: { total: 5 }, actor: 'u1' }),
    ).rejects.toThrow('viene de la hoja');
  });
});
