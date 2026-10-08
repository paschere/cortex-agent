import type { SetupItem } from '@/lib/guided-setup-shape';
import { createOrgScopedClient } from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Tables,
  createFakeSupabase,
} from '../../../../packages/agent-tools/src/tenancy/__tests__/fake-postgrest';

/**
 * LO QUE LA ENTREVISTA CONSTRUYE AL APLICAR: BORRADORES, Y NADA SIN PERMISO.
 *
 * Los diseñadores (que llaman al modelo) se reemplazan por dobles: lo que se
 * prueba aquí es el pegamento — qué se guarda, en qué estado, a dónde apunta,
 * quién puede y qué pasa cuando el diseño no cuadra. Las tablas sí se crean de
 * verdad contra el fake de PostgREST.
 */

const designView = vi.fn();
const designAndCreateApp = vi.fn();
const designAndCreateAutomation = vi.fn();
vi.mock('./designers', () => ({
  designView: (...a: unknown[]) => designView(...a),
  designAndCreateApp: (...a: unknown[]) => designAndCreateApp(...a),
  designAndCreateAutomation: (...a: unknown[]) => designAndCreateAutomation(...a),
}));

const createView = vi.fn();
const validateSpec = vi.fn();
vi.mock('@cortex/agent-tools', async (importOriginal) => {
  const real = await importOriginal<typeof import('@cortex/agent-tools')>();
  return {
    ...real,
    createView: (...a: unknown[]) => createView(...a),
    validateSpec: (...a: unknown[]) => validateSpec(...a),
    getApp: vi.fn(async () => null),
    listApps: vi.fn(async () => []),
  };
});

const { createOne } = await import('./apply');
type CreateContext = import('./apply').CreateContext;

const ACME = 'org-acme';
const USER = '11111111-1111-4111-8111-111111111111';

function withIds(client: SupabaseClient): SupabaseClient {
  let seq = 0;
  const inner = client as unknown as { from: (t: string) => Record<string, unknown> };
  return {
    from(table: string) {
      const builder = inner.from(table);
      const original = builder.insert as (rows: unknown) => unknown;
      builder.insert = (rows: unknown) => {
        const list = Array.isArray(rows) ? rows : [rows];
        for (const row of list as Record<string, unknown>[]) {
          seq += 1;
          row.id ??= `${table}-${seq}`;
          row.created_at ??= new Date().toISOString();
          row.updated_at ??= row.created_at;
        }
        return original.call(builder, list);
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

function world(tables: Tables = {}) {
  const fake = createFakeSupabase(tables);
  return { tables, db: createOrgScopedClient(withIds(fake.client), ACME) };
}

function ctx(db: SupabaseClient, over: Partial<CreateContext> = {}): CreateContext {
  return {
    db,
    userId: USER,
    agentId: 'agent-1',
    canCreateGlobalSpace: true,
    canManageApps: true,
    organizationName: 'Acme',
    apps: new Map(),
    today: '2026-03-10',
    ...over,
  };
}

function item(kind: SetupItem['kind'], title: string, payload: unknown): SetupItem {
  return {
    id: `i-${title}`,
    kind,
    title,
    rationale: 'lo dijeron',
    payload: payload as SetupItem['payload'],
    status: 'proposed',
    targetTable: null,
    targetId: null,
    error: null,
  };
}

const TABLE = item('table', 'Remates', {
  name: 'Remates',
  description: 'Lo que subastamos',
  fields: [
    { label: 'Fecha del remate', type: 'date', required: true },
    { label: 'Estado', type: 'select', options: ['Abierto', 'Cerrado'] },
  ],
});
const VIEW = item('view', 'Tablero de remates', {
  name: 'Tablero de remates',
  request: 'Remates por estado, para el jefe de turno.',
});
const APP = item('app', 'Control de planta', {
  name: 'Control de planta',
  request: 'Operarios registran guías desde el celular; el supervisor aprueba.',
});
const AUTOMATION = item('automation', 'Avisar duplicadas', {
  name: 'Avisar duplicadas',
  app: 'Control de planta',
  rule: 'Cuando una guía salga duplicada, avisa al supervisor.',
});

beforeEach(() => {
  designView.mockReset();
  designAndCreateApp.mockReset();
  designAndCreateAutomation.mockReset();
  createView.mockReset();
  validateSpec.mockReset();
});

describe('tabla', () => {
  it('crea la tabla con las columnas que dijeron y apunta a su identificador', async () => {
    const w = world();
    const out = await createOne(ctx(w.db), TABLE);

    expect(out.status).toBe('created');
    expect(out.targetTable).toBe('trackers');
    expect(out.targetId).toBe('remates');
    const row = (w.tables.trackers ?? [])[0] as { fields: { key: string; type: string }[] };
    expect(row.fields.map((f) => f.key)).toEqual(['fecha_del_remate', 'estado']);
    expect(row.fields[1]?.type).toBe('select');
  });

  it('nunca pisa una tabla que ya existe: usa otro identificador', async () => {
    const w = world({
      trackers: [
        {
          id: 't0',
          organization_id: ACME,
          slug: 'remates',
          name: 'Mía',
          fields: [{ key: 'x', label: 'X', type: 'text' }],
        },
      ],
    });
    const out = await createOne(ctx(w.db), TABLE);

    expect(out.status).toBe('created');
    expect(out.targetId).toBe('remates_2');
    const mine = (w.tables.trackers ?? []).find(
      (t) => (t as { slug: string }).slug === 'remates',
    ) as {
      name: string;
    };
    expect(mine.name).toBe('Mía');
  });

  it('con hoja de Google no crea nada: queda para seguir en el chat', async () => {
    const w = world();
    const sheet = item('table', 'Guías', {
      name: 'Guías',
      source: { kind: 'sheet', url: 'https://docs.google.com/spreadsheets/d/abc' },
    });
    const out = await createOne(ctx(w.db), sheet);

    expect(out.status).toBe('handoff');
    expect(out.ok).toBe(true);
    expect(w.tables.trackers ?? []).toHaveLength(0);
  });

  it('con carpeta de Drive tampoco crea nada', async () => {
    const w = world();
    const drive = item('table', 'Facturas', {
      name: 'Facturas',
      source: { kind: 'drive', url: 'https://drive.google.com/drive/folders/xyz' },
    });
    const out = await createOne(ctx(w.db), drive);
    expect(out.status).toBe('handoff');
    expect(w.tables.trackers ?? []).toHaveLength(0);
  });
});

describe('vista', () => {
  it('crea la vista como borrador interno con el diseñador de siempre', async () => {
    const w = world();
    const spec = { version: 1, blocks: [] };
    designView.mockResolvedValue({
      ok: true,
      value: { name: 'Tablero de remates', description: 'Por estado', spec, newTrackers: [] },
    });
    validateSpec.mockResolvedValue(spec);
    createView.mockResolvedValue({ id: 'v1', slug: 'tablero-de-remates' });

    const out = await createOne(ctx(w.db), VIEW);

    expect(out.status).toBe('created');
    expect(out.targetTable).toBe('custom_views');
    expect(out.targetId).toBe('tablero-de-remates');
    const args = createView.mock.calls[0]?.[1] as Record<string, unknown>;
    // Ni fijada ni compartida: createView no recibe nada de eso.
    expect(args).not.toHaveProperty('pinned');
    expect(args).not.toHaveProperty('visibility');
    expect(args.spec).toBe(spec);
  });

  it('crea las tablas nuevas que el diseñador propuso, sólo si no existían', async () => {
    const w = world();
    const spec = { version: 1, blocks: [] };
    designView.mockResolvedValue({
      ok: true,
      value: {
        name: 'Tablero',
        description: '',
        spec,
        newTrackers: [
          {
            slug: 'pedidos',
            name: 'Pedidos',
            description: '',
            fields: [{ key: 'cliente', label: 'Cliente', type: 'text', required: false }],
          },
        ],
      },
    });
    validateSpec.mockResolvedValue(spec);
    createView.mockResolvedValue({ id: 'v1', slug: 'tablero' });

    await createOne(ctx(w.db), VIEW);
    expect((w.tables.trackers ?? []).map((t) => (t as { slug: string }).slug)).toEqual(['pedidos']);
  });

  it('si el diseño no cuadra, entrega al chat y no guarda nada', async () => {
    const w = world();
    designView.mockResolvedValue({ ok: false, reason: '¿Qué tabla quieres ver?' });

    const out = await createOne(ctx(w.db), VIEW);

    expect(out.status).toBe('handoff');
    expect(out.error).toBe('¿Qué tabla quieres ver?');
    expect(createView).not.toHaveBeenCalled();
  });
});

describe('aplicación y automatización', () => {
  it('crea la aplicación como borrador y la automatización en la app del mismo lote', async () => {
    const w = world();
    const c = ctx(w.db);
    designAndCreateApp.mockResolvedValue({
      ok: true,
      value: { appId: 'app-1', slug: 'control_de_planta', name: 'Control de planta', screens: 3 },
    });
    designAndCreateAutomation.mockResolvedValue({
      ok: true,
      value: { automationId: 'auto-9', name: 'Avisar duplicadas' },
    });

    const app = await createOne(c, APP);
    const auto = await createOne(c, AUTOMATION);

    expect(app.status).toBe('created');
    expect(app.targetTable).toBe('custom_apps');
    expect(app.targetId).toBe('app-1');
    expect(auto.status).toBe('created');
    expect(auto.targetTable).toBe('custom_app_automations');
    expect(auto.targetId).toBe('app-1:auto-9');
    expect(designAndCreateAutomation.mock.calls[0]?.[2]).toEqual({
      id: 'app-1',
      name: 'Control de planta',
    });
  });

  it('una automatización cuya aplicación no existe queda para el chat', async () => {
    const w = world();
    const out = await createOne(ctx(w.db), AUTOMATION);

    expect(out.status).toBe('handoff');
    expect(designAndCreateAutomation).not.toHaveBeenCalled();
  });

  it('si el diseñador de la aplicación falla, la aplicación va al chat', async () => {
    const w = world();
    designAndCreateApp.mockResolvedValue({ ok: false, reason: 'La tabla «guias» no existe.' });

    const out = await createOne(ctx(w.db), APP);

    expect(out.status).toBe('handoff');
    expect(out.error).toContain('guias');
  });
});

describe('permisos', () => {
  it('quien no administra no crea aplicaciones ni automatizaciones, y ni se llama al modelo', async () => {
    const w = world();
    const member = ctx(w.db, { canManageApps: false, canCreateGlobalSpace: false });

    const app = await createOne(member, APP);
    const auto = await createOne(member, AUTOMATION);

    expect(app.status).toBe('failed');
    expect(auto.status).toBe('failed');
    expect(app.error).toContain('administra');
    expect(designAndCreateApp).not.toHaveBeenCalled();
    expect(designAndCreateAutomation).not.toHaveBeenCalled();
  });

  it('quien no administra sí crea tablas y pantallas', async () => {
    const w = world();
    const member = ctx(w.db, { canManageApps: false, canCreateGlobalSpace: false });
    const out = await createOne(member, TABLE);
    expect(out.status).toBe('created');
  });
});

describe('deshacer lo construido', () => {
  it('una tabla con filas adentro no se borra; vacía sí', async () => {
    const { undoOne } = await import('./apply');
    const w = world({
      trackers: [
        { id: 't1', organization_id: ACME, slug: 'remates' },
        { id: 't2', organization_id: ACME, slug: 'vacia' },
      ],
      tracker_rows: [{ id: 'r1', organization_id: ACME, tracker_id: 't1' }],
    });
    const used = {
      ...TABLE,
      status: 'created' as const,
      targetTable: 'trackers',
      targetId: 'remates',
    };
    const empty = {
      ...TABLE,
      status: 'created' as const,
      targetTable: 'trackers',
      targetId: 'vacia',
    };

    expect((await undoOne(w.db, used)).ok).toBe(false);
    expect((await undoOne(w.db, empty)).ok).toBe(true);
    expect((w.tables.trackers ?? []).map((t) => (t as { slug: string }).slug)).toEqual(['remates']);
  });

  it('una aplicación publicada no se borra; un borrador sí', async () => {
    const { undoOne } = await import('./apply');
    const w = world({
      custom_apps: [
        { id: 'a1', organization_id: ACME, status: 'published' },
        { id: 'a2', organization_id: ACME, status: 'draft' },
      ],
    });
    const base = { ...APP, status: 'created' as const, targetTable: 'custom_apps' };

    expect((await undoOne(w.db, { ...base, targetId: 'a1' })).ok).toBe(false);
    expect((await undoOne(w.db, { ...base, targetId: 'a2' })).ok).toBe(true);
    expect((w.tables.custom_apps ?? []).map((a) => (a as { id: string }).id)).toEqual(['a1']);
  });
});
