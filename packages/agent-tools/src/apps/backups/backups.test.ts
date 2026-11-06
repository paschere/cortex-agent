import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { createFakeSupabase } from '../../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../tenancy/scoped-client';
import { getAppCode, saveAppCodeFiles } from '../code/store';
import { backupToWorkbook, sheetName } from './export';
import {
  backupsToDelete,
  bogotaParts,
  diffTable,
  packBackup,
  planTableRestore,
  tableSlugsOf,
  unpackBackup,
} from './shape';
import {
  createBackup,
  diffAgainstToday,
  listBackups,
  previewTableRestore,
  pruneBackups,
  readBackup,
  restoreCode,
  restoreRow,
  restoreTable,
} from './store';

const ORG = 'org-a';
const OTHER = 'org-b';
const ADMIN = 'u-admin';
const MEMBER = 'u-member';
const APP = '11111111-1111-4111-8111-111111111111';
const T_PEDIDOS = '21111111-1111-4111-8111-111111111111';
const T_CLIENTES = '22222222-1111-4111-8111-111111111111';
const T_AJENA = '23333333-1111-4111-8111-111111111111';
const T_OTRA_ORG = '24444444-1111-4111-8111-111111111111';
const ROW = (n: number) => `3000000${n}-1111-4111-8111-111111111111`;

const tracker = (id: string, slug: string, org = ORG) => ({
  id,
  organization_id: org,
  slug,
  name: slug,
  description: '',
  fields: [{ key: 'estado', label: 'Estado', type: 'text' }],
  origins: [],
  created_by: null,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
});
const row = (n: number, trackerId: string, estado: string, org = ORG) => ({
  id: ROW(n),
  organization_id: org,
  tracker_id: trackerId,
  label: `Pedido ${n}`,
  values: { estado },
  created_by: null,
  created_at: `2026-10-0${n}T00:00:00Z`,
  updated_at: `2026-10-0${n}T00:00:00Z`,
});

function world() {
  const fake = createFakeSupabase({
    users: [
      { id: ADMIN, organization_id: ORG, role: 'org_admin', email: 'a@x.co' },
      { id: MEMBER, organization_id: ORG, role: 'member', email: 'm@x.co' },
    ],
    custom_apps: [
      {
        id: APP,
        organization_id: ORG,
        slug: 'planta',
        name: 'Planta',
        description: '',
        icon: '🏭',
        theme: {},
        home_screen: null,
        status: 'draft',
        version: 1,
        created_by: null,
        updated_by: null,
        created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-01T00:00:00Z',
        archived_at: null,
      },
    ],
    custom_app_screens: [
      {
        id: 's1',
        organization_id: ORG,
        app_id: APP,
        view_id: 'v1',
        slug: 'pedidos',
        title: 'Pedidos',
        icon: 'X',
        position: 0,
        roles: [],
        kind: 'view',
        code_entry: null,
        created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-01T00:00:00Z',
      },
    ],
    custom_views: [],
    custom_app_roles: [
      {
        id: 'r1',
        organization_id: ORG,
        app_id: APP,
        key: 'operario',
        name: 'Operario',
        description: '',
        permissions: { tables: { clientes: { read: 'all' } }, export: false },
        position: 0,
      },
    ],
    custom_app_automations: [
      {
        id: 'au1',
        organization_id: ORG,
        app_id: APP,
        name: 'Aviso',
        enabled: true,
        trigger: { type: 'row_created', tracker: 'pedidos' },
        conditions: [],
        actions: [],
      },
    ],
    custom_app_notice_config: [],
    app_versions: [],
    custom_app_code: [],
    custom_app_code_secrets: [],
    custom_app_db: [],
    trackers: [
      tracker(T_PEDIDOS, 'pedidos'),
      tracker(T_CLIENTES, 'clientes'),
      tracker(T_AJENA, 'ajena'),
      tracker(T_OTRA_ORG, 'pedidos', OTHER),
    ],
    tracker_rows: [
      row(1, T_PEDIDOS, 'nuevo'),
      row(2, T_PEDIDOS, 'nuevo'),
      row(3, T_CLIENTES, 'activo'),
      row(4, T_AJENA, 'intacto'),
      row(5, T_OTRA_ORG, 'de otra empresa', OTHER),
    ],
    app_files: [],
    custom_app_backups: [],
  });
  return { fake, db: createOrgScopedClient(fake.client, ORG) };
}

const rowsOf = (fake: ReturnType<typeof world>['fake'], trackerId: string) =>
  (fake.tables.tracker_rows ?? []).filter((r) => r.tracker_id === trackerId);

describe('copias: formato y reglas puras', () => {
  it('una app usa las tablas de sus roles, de sus pantallas y de sus reglas', () => {
    const slugs = tableSlugsOf({
      roles: [{ permissions: { tables: { clientes: {} } } }],
      specs: [
        { blocks: [{ type: 'sheet', tracker: 'pedidos', group: { parentTracker: 'bodegas' } }] },
      ],
      automations: [
        { trigger: { tracker: 'pedidos' }, actions: [{ type: 'row', table: 'avisos' }] },
      ],
    });
    expect(slugs).toEqual(['avisos', 'bodegas', 'clientes', 'pedidos']);
  });

  it('el archivo es gzip de JSON y sobrevive ida y vuelta', () => {
    const content = {
      v: 1,
      app: { id: 'a', slug: 's', name: 'n' },
      config: {},
      tables: {},
    } as never;
    const bytes = packBackup(content);
    expect(gunzipSync(bytes).toString('utf8')).toContain('"v":1');
    expect(unpackBackup(bytes).app.id).toBe('a');
    expect(() => unpackBackup(new Uint8Array([1, 2, 3]))).toThrow(/dañado/);
  });

  it('diferencias: borradas, cambiadas y nuevas; la copia truncada no borra', () => {
    const table = {
      tracker: { id: 't', slug: 'p', name: 'p', description: '', fields: [], origins: [] },
      rows: [
        { id: 'a', label: 'A', values: { x: 1 }, created_by: null, created_at: '', updated_at: '' },
        { id: 'b', label: 'B', values: { x: 1 }, created_by: null, created_at: '', updated_at: '' },
        { id: 'c', label: 'C', values: { x: 1 }, created_by: null, created_at: '', updated_at: '' },
      ],
      total: 3,
      truncated: false,
    };
    const live = [
      { id: 'a', label: 'A', values: { x: 1 } },
      { id: 'b', label: 'B', values: { x: 2 } },
      { id: 'd', label: 'D', values: {} },
    ];
    const d = diffTable('p', table, live);
    expect(d.removed.map((r) => r.id)).toEqual(['c']);
    expect(d.changed.map((r) => r.id)).toEqual(['b']);
    expect(d.changed[0]?.changes[0]).toEqual({ field: 'x', was: 1, now: 2 });
    expect(d.added.map((r) => r.id)).toEqual(['d']);
    expect(d.unchanged).toBe(1);
    expect(planTableRestore(d)).toEqual({ create: 1, update: 1, remove: 1 });
    expect(planTableRestore({ ...d, truncated: true }).remove).toBe(0);
  });

  it('retención: 30 diarias, 90 días de las demás, fallidas a los 30', () => {
    const now = new Date('2026-11-06T12:00:00Z');
    const day = (n: number) => new Date(now.getTime() - n * 86400000).toISOString();
    const rows = [
      ...Array.from({ length: 35 }, (_, i) => ({
        id: `d${i}`,
        kind: 'diaria' as const,
        status: 'ok' as const,
        created_at: day(i + 1),
      })),
      { id: 'm-viejo', kind: 'manual' as const, status: 'ok' as const, created_at: day(100) },
      { id: 'm-nuevo', kind: 'manual' as const, status: 'ok' as const, created_at: day(80) },
      {
        id: 'x-viejo',
        kind: 'antes_de_cambio' as const,
        status: 'ok' as const,
        created_at: day(91),
      },
      { id: 'f-viejo', kind: 'diaria' as const, status: 'failed' as const, created_at: day(40) },
      { id: 'f-nuevo', kind: 'diaria' as const, status: 'failed' as const, created_at: day(2) },
    ];
    const doomed = backupsToDelete(rows, now);
    expect(doomed.filter((i) => i.startsWith('d')).sort()).toEqual([
      'd30',
      'd31',
      'd32',
      'd33',
      'd34',
    ]);
    expect(doomed).toContain('m-viejo');
    expect(doomed).toContain('x-viejo');
    expect(doomed).toContain('f-viejo');
    expect(doomed).not.toContain('m-nuevo');
    expect(doomed).not.toContain('f-nuevo');
  });

  it('la hora de Bogotá cuenta el día desde las 5:00 UTC', () => {
    const p = bogotaParts(new Date('2026-11-06T07:05:00Z'));
    expect(p.hour).toBe(2);
    expect(p.dayStartUtc.toISOString()).toBe('2026-11-06T05:00:00.000Z');
    expect(bogotaParts(new Date('2026-11-06T04:00:00Z')).dayStartUtc.toISOString()).toBe(
      '2026-11-05T05:00:00.000Z',
    );
  });
});

describe('copias: crear y leer', () => {
  it('guarda las tablas de la app (y sólo esas) y la copia se lee de vuelta', async () => {
    const { fake, db } = world();
    const b = await createBackup(db, APP, { kind: 'manual', reason: 'prueba', userId: ADMIN });
    expect(b.status).toBe('ok');
    expect(b.tables).toEqual({ clientes: 1, pedidos: 2 });
    expect(Object.keys(b.tables)).not.toContain('ajena');
    expect(fake.tables.app_files).toHaveLength(1);
    expect(fake.tables.app_files?.[0]?.bucket).toBe('app-backups');
    expect(fake.tables.app_files?.[0]?.organization_id).toBe(ORG);
    const { content } = await readBackup(db, APP, b.id);
    expect(content.tables.pedidos?.rows.map((r) => r.id).sort()).toEqual([ROW(1), ROW(2)]);
    // La fila de otra empresa con el mismo slug nunca entra.
    expect(JSON.stringify(content)).not.toContain('de otra empresa');
    expect(content.config.automations).toHaveLength(1);
    expect((await listBackups(db, APP)).map((x) => x.id)).toEqual([b.id]);
  });

  it('no ve las copias de otra empresa', async () => {
    const { fake, db } = world();
    const b = await createBackup(db, APP, { kind: 'manual', userId: ADMIN });
    const other = createOrgScopedClient(fake.client, OTHER);
    expect(await listBackups(other, APP)).toEqual([]);
    await expect(readBackup(other, APP, b.id)).rejects.toThrow(/No existe/);
  });
});

describe('copias: diferencias y restaurar', () => {
  it('cuenta lo borrado, lo cambiado y lo nuevo contra hoy', async () => {
    const { fake, db } = world();
    const b = await createBackup(db, APP, { kind: 'manual', userId: ADMIN });
    fake.tables.tracker_rows = (fake.tables.tracker_rows ?? [])
      .filter((r) => r.id !== ROW(1))
      .map((r) => (r.id === ROW(2) ? { ...r, values: { estado: 'cerrado' } } : r));
    fake.tables.tracker_rows?.push(row(6, T_PEDIDOS, 'recién creada'));
    const d = await diffAgainstToday(db, APP, b.id);
    const t = d.tables.find((x) => x.slug === 'pedidos');
    expect(t?.removed.map((r) => r.id)).toEqual([ROW(1)]);
    expect(t?.changed.map((r) => r.id)).toEqual([ROW(2)]);
    expect(t?.added.map((r) => r.id)).toEqual([ROW(6)]);
    const p = await previewTableRestore(db, APP, b.id, 'pedidos');
    expect(p.plan).toEqual({ create: 1, update: 1, remove: 1 });
    expect(p.text).toMatch(/1 fila se vuelve a crear/);
  });

  it('restaura una fila borrada con el mismo id, y deja copia «antes de restaurar»', async () => {
    const { fake, db } = world();
    const b = await createBackup(db, APP, { kind: 'manual', userId: ADMIN });
    fake.tables.tracker_rows = (fake.tables.tracker_rows ?? []).filter((r) => r.id !== ROW(1));
    const out = await restoreRow(db, APP, b.id, 'pedidos', ROW(1), { userId: ADMIN });
    expect(out.action).toBe('recreated');
    const back = rowsOf(fake, T_PEDIDOS).find((r) => r.id === ROW(1));
    expect(back?.values).toEqual({ estado: 'nuevo' });
    expect(back?.created_at).toBe('2026-10-01T00:00:00Z');
    const list = await listBackups(db, APP);
    const safety = list.find((x) => x.id === out.safetyBackupId);
    expect(safety?.kind).toBe('antes_de_cambio');
    expect(safety?.reason).toMatch(/Antes de restaurar/);
    // La copia previa guardó el estado SIN esa fila: se puede deshacer restaurando de ella.
    const { content } = await readBackup(db, APP, out.safetyBackupId);
    expect(content.tables.pedidos?.rows.map((r) => r.id)).toEqual([ROW(2)]);
  });

  it('restaurar una fila cambiada devuelve sus valores; sin cambios no hace nada', async () => {
    const { fake, db } = world();
    const b = await createBackup(db, APP, { kind: 'manual', userId: ADMIN });
    expect((await restoreRow(db, APP, b.id, 'pedidos', ROW(2), { userId: ADMIN })).action).toBe(
      'unchanged',
    );
    fake.tables.tracker_rows = (fake.tables.tracker_rows ?? []).map((r) =>
      r.id === ROW(2) ? { ...r, values: { estado: 'cerrado' } } : r,
    );
    expect((await restoreRow(db, APP, b.id, 'pedidos', ROW(2), { userId: ADMIN })).action).toBe(
      'updated',
    );
    expect(rowsOf(fake, T_PEDIDOS).find((r) => r.id === ROW(2))?.values).toEqual({
      estado: 'nuevo',
    });
  });

  it('restaura una tabla: recrea, devuelve y borra las nuevas, sin tocar las demás tablas', async () => {
    const { fake, db } = world();
    const b = await createBackup(db, APP, { kind: 'manual', userId: ADMIN });
    fake.tables.tracker_rows = (fake.tables.tracker_rows ?? [])
      .filter((r) => r.id !== ROW(1))
      .map((r) => (r.id === ROW(2) ? { ...r, values: { estado: 'cerrado' } } : r))
      .map((r) => (r.id === ROW(3) ? { ...r, values: { estado: 'cambiado a propósito' } } : r))
      .concat([row(6, T_PEDIDOS, 'nueva')]);
    const out = await restoreTable(db, APP, b.id, 'pedidos', { userId: ADMIN });
    expect(out.plan).toEqual({ create: 1, update: 1, remove: 1 });
    const pedidos = rowsOf(fake, T_PEDIDOS);
    expect(pedidos.map((r) => r.id).sort()).toEqual([ROW(1), ROW(2)]);
    expect(pedidos.every((r) => (r.values as { estado: string }).estado === 'nuevo')).toBe(true);
    // Otra tabla de la app, una tabla ajena y la de otra empresa quedan como estaban.
    expect(rowsOf(fake, T_CLIENTES)[0]?.values).toEqual({ estado: 'cambiado a propósito' });
    expect(rowsOf(fake, T_AJENA)[0]?.values).toEqual({ estado: 'intacto' });
    expect(rowsOf(fake, T_OTRA_ORG)[0]?.values).toEqual({ estado: 'de otra empresa' });
  });

  it('no restaura tablas que la copia no incluye', async () => {
    const { db } = world();
    const b = await createBackup(db, APP, { kind: 'manual', userId: ADMIN });
    await expect(restoreTable(db, APP, b.id, 'ajena', { userId: ADMIN })).rejects.toThrow(
      /no incluye/,
    );
    await expect(restoreTable(db, APP, b.id, 'constructor', { userId: ADMIN })).rejects.toThrow(
      /no incluye/,
    );
  });

  it('sólo administra quien administra la empresa', async () => {
    const { fake, db } = world();
    const b = await createBackup(db, APP, { kind: 'manual', userId: ADMIN });
    fake.tables.tracker_rows = (fake.tables.tracker_rows ?? []).filter((r) => r.id !== ROW(1));
    await expect(restoreRow(db, APP, b.id, 'pedidos', ROW(1), { userId: MEMBER })).rejects.toThrow(
      /administra/,
    );
    await expect(restoreTable(db, APP, b.id, 'pedidos', { userId: MEMBER })).rejects.toThrow(
      /administra/,
    );
    expect(rowsOf(fake, T_PEDIDOS).some((r) => r.id === ROW(1))).toBe(false);
  });

  it('si no se puede hacer la copia previa, no se restaura nada', async () => {
    const { fake, db } = world();
    const b = await createBackup(db, APP, { kind: 'manual', userId: ADMIN });
    fake.tables.tracker_rows = (fake.tables.tracker_rows ?? []).filter((r) => r.id !== ROW(1));
    // Sin la tabla de archivos la copia previa falla.
    (fake.tables as Record<string, unknown>).app_files = undefined;
    await expect(restoreRow(db, APP, b.id, 'pedidos', ROW(1), { userId: ADMIN })).rejects.toThrow();
    expect(rowsOf(fake, T_PEDIDOS).some((r) => r.id === ROW(1))).toBe(false);
  });
});

describe('copias: retención en la base', () => {
  it('borra las copias vencidas y su archivo', async () => {
    const { fake, db } = world();
    const old = await createBackup(db, APP, { kind: 'manual', userId: ADMIN });
    const keep = await createBackup(db, APP, { kind: 'manual', userId: ADMIN });
    const idx = fake.tables.custom_app_backups?.find((r) => r.id === old.id);
    if (idx) idx.created_at = '2026-01-01T00:00:00Z';
    const n = await pruneBackups(db, APP, new Date('2026-11-06T00:00:00Z'));
    expect(n).toBe(1);
    expect((await listBackups(db, APP)).map((b) => b.id)).toEqual([keep.id]);
    expect(fake.tables.app_files).toHaveLength(1);
  });
});

describe('copias: código', () => {
  it('la copia guarda el código (sin secretos) y restaurarlo devuelve el borrador', async () => {
    const { fake, db } = world();
    (fake.tables.custom_app_code_secrets as unknown[]).push({
      id: 'k1',
      organization_id: ORG,
      app_id: APP,
      name: 'API_KEY',
      value_encrypted: 'SECRETO',
    });
    await saveAppCodeFiles(db, APP, { write: { 'screens/a.tsx': 'v1', 'lib/x.ts': 'x' } }, ADMIN);
    const b = await createBackup(db, APP, { kind: 'manual', userId: ADMIN });
    const { content } = await readBackup(db, APP, b.id);
    expect(content.code?.secretNames).toEqual(['API_KEY']);
    expect(JSON.stringify(content)).not.toContain('SECRETO');
    await saveAppCodeFiles(
      db,
      APP,
      { write: { 'screens/a.tsx': 'v2', 'lib/nuevo.ts': 'n' }, remove: ['lib/x.ts'] },
      ADMIN,
    );
    const out = await restoreCode(db, APP, b.id, { userId: ADMIN });
    expect(out.skipped.join(' ')).toMatch(/publica/);
    expect((await getAppCode(db, APP))?.files).toEqual({ 'screens/a.tsx': 'v1', 'lib/x.ts': 'x' });
    await expect(restoreCode(db, APP, b.id, { userId: MEMBER })).rejects.toThrow(/administra/);
  });
});

describe('copias: Excel', () => {
  it('una hoja por tabla con sus campos, y nombres de hoja válidos y únicos', async () => {
    const { db } = world();
    const b = await createBackup(db, APP, { kind: 'manual', userId: ADMIN });
    const { content } = await readBackup(db, APP, b.id);
    const bytes = await backupToWorkbook(content);
    const { default: ExcelJS } = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Resumen', 'clientes', 'pedidos']);
    expect(wb.getWorksheet('pedidos')?.rowCount).toBe(3);
    expect(wb.getWorksheet('pedidos')?.getRow(1).getCell(5).value).toBe('Estado');
    const used = new Set<string>();
    expect(sheetName('a/b:c', used)).toBe('a_b_c');
    expect(sheetName('A/B:C', used)).toBe('A_B_C_2');
  });
});
