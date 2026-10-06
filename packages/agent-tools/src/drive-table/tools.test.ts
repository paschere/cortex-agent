import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackerField } from '../trackers/schema';

const state = vi.hoisted(() => ({
  existing: null as null | { fields: TrackerField[] },
  upserts: [] as Array<Record<string, unknown>>,
  defined: [] as Array<Record<string, unknown>>,
}));

vi.mock('../trackers/store', async (orig) => {
  const real = await orig<typeof import('../trackers/store')>();
  return {
    ...real,
    getTrackerBySlug: vi.fn(async () => state.existing),
    defineTracker: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
      state.defined.push(input);
      return {
        created: true,
        tracker: {
          id: 't1',
          slug: input.slug,
          name: input.name,
          description: '',
          fields: input.fields,
        },
      };
    }),
  };
});
vi.mock('../trackers/duplicates', async (orig) => ({
  ...(await orig<typeof import('../trackers/duplicates')>()),
  getDuplicateRule: vi.fn(async () => null),
}));
vi.mock('./engine', async (orig) => ({
  ...(await orig<typeof import('./engine')>()),
  driveFolderMeta: vi.fn(async () => ({ id: 'folder-1', name: 'Facturas' })),
  upsertDriveFolderSync: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
    state.upserts.push(input);
    return { id: 's1', interval_minutes: 10, recursive: input.recursive };
  }),
}));

import { trackersSyncFromDriveFolder } from './tools';

const ctx = {
  db: {},
  userId: 'u1',
  organizationId: 'o1',
  integrations: {},
  signal: undefined,
  enqueueJob: async () => true,
} as never;
const base = {
  folder: 'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp',
  table: 'facturas',
};
const call = (extra: Record<string, unknown>) =>
  trackersSyncFromDriveFolder.handler(
    trackersSyncFromDriveFolder.inputSchema.parse({ ...base, ...extra }),
    ctx,
  );

beforeEach(() => {
  state.existing = null;
  state.upserts.length = 0;
  state.defined.length = 0;
});

describe('trackers.sync_from_drive_folder exige la propuesta aprobada', () => {
  it('una tabla nueva sin campos aprobados ni ejemplo de partida se devuelve al modelo', async () => {
    await expect(call({})).rejects.toThrow(/trackers\.propose_from_drive_folder/);
    expect(state.defined).toHaveLength(0);
    expect(state.upserts).toHaveLength(0);
  });

  it('con los campos aprobados (hoja + documento + carpeta) crea la tabla y guarda el mapeo', async () => {
    const out = (await call({
      recursive: true,
      keyFields: ['factura'],
      fields: [
        {
          key: 'factura',
          label: 'Factura',
          type: 'text',
          sourceColumn: 'N° Factura',
          fromDocument: true,
          hint: 'arriba',
        },
        { key: 'total', label: 'Total', type: 'money', sourceColumn: 'Valor' },
        { key: 'carpeta', label: 'Carpeta', type: 'text', fromFolder: true },
        { key: 'estado', label: 'Estado', type: 'select', options: ['Pendiente'] },
      ],
    })) as { status: string; markdown: string };
    expect(out.status).toBe('scheduled');
    const sync = state.upserts[0] as Record<string, unknown>;
    expect(sync.sheetMapping).toEqual({ factura: 'N° Factura', total: 'Valor' });
    expect(sync.extract).toEqual([{ key: 'factura', hint: 'arriba' }]);
    expect(sync.keyFields).toEqual(['factura']);
    expect(sync.recursive).toBe(true);
    // El campo del equipo (estado) y la subcarpeta no se le piden al modelo.
    expect((state.defined[0]?.fields as TrackerField[]).map((f) => f.key)).toContain('revision');
    expect(out.markdown).toContain('NO se borran');
  });

  it('un preset explícito sigue valiendo sin propuesta', async () => {
    await call({ preset: 'facturas_proveedor' });
    expect(state.defined).toHaveLength(1);
    expect(state.upserts[0]?.sheetMapping).toEqual({});
  });

  it('la clave tiene que salir de algún lado: documento, columna de hoja o subcarpeta', async () => {
    await expect(
      call({
        keyFields: ['estado'],
        fields: [
          { key: 'factura', label: 'Factura', type: 'text', sourceColumn: 'Factura' },
          { key: 'estado', label: 'Estado', type: 'text', fromDocument: false },
        ],
      }),
    ).rejects.toThrow(/tiene que leerse/);
  });
});
