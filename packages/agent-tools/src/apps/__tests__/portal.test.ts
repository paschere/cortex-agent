import { describe, expect, it } from 'vitest';
import { createFakeSupabase } from '../../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../tenancy/scoped-client';
import type { ComputedBlock } from '../../views/compute';
import { type ExternalUserRow, externalAppAccess, inviteAppUser, updateAppUser } from '../external';
import { requiredAttributes } from '../permissions';
import { attributeValueSuggestions } from '../portal';
import {
  type AppAccess,
  appCanExport,
  editAppRow,
  getApp,
  readScreen,
  screenFor,
  submitAppForm,
  visibleScreens,
} from '../store';
import { APP_TEMPLATES, PORTAL_CLIENTES } from '../templates';

/**
 * EL PORTAL DE CLIENTES: UN CLIENTE NUNCA VE LO DE OTRO (fase 4).
 *
 * El riesgo principal de las apps. El fixture es adverso: dos clientes (Andina
 * y Boreal) en la misma empresa con filas, cifras y documentos gemelos, y una
 * segunda empresa que TAMBIÉN tiene un cliente «Andina». Cada afirmación es
 * sobre qué volvió al navegador (tablas, tarjetas, cifras, archivos y lo que
 * sale al exportar) o qué se rechazó antes de escribir. Se usa la plantilla
 * REAL: si alguien le cambia un permiso, esta prueba se entera.
 */

const POSTAL = 'org-postal';
const OTRA = 'org-otra';
const APP = '55555555-5555-4555-8555-555555555555';
const APP_OTRA = '66666666-6666-4666-8666-666666666666';
const ANDINA = 'f0000000-0000-4000-8000-00000000a001';
const BOREAL = 'f0000000-0000-4000-8000-00000000b002';
const ATENCION = 'f0000000-0000-4000-8000-00000000c003';
const ANDINA_OTRA = 'f0000000-0000-4000-8000-00000000d004';

const pedidosFields = PORTAL_CLIENTES.trackers[0]?.fields ?? [];
const documentosFields = PORTAL_CLIENTES.trackers[1]?.fields ?? [];

function seed() {
  const base = { created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' };
  const tracker = (org: string, id: string, slug: string, fields: unknown) => ({
    id,
    organization_id: org,
    slug,
    name: slug,
    description: '',
    fields,
    duplicates: null,
    created_by: null,
    ...base,
  });
  const pedido = (
    org: string,
    trk: string,
    id: string,
    cliente: string,
    referencia: string,
    estado = 'En proceso',
    by: string | null = null,
  ) => ({
    id,
    organization_id: org,
    tracker_id: trk,
    label: referencia,
    values: { cliente, referencia, fecha: '2026-10-05', estado },
    created_by: null,
    created_by_app_user: by,
    ...base,
  });
  const documento = (
    org: string,
    trk: string,
    id: string,
    cliente: string,
    nombre: string,
    archivo: string,
  ) => ({
    id,
    organization_id: org,
    tracker_id: trk,
    label: nombre,
    values: { cliente, nombre, tipo: 'Factura', fecha: '2026-10-05', archivo },
    created_by: null,
    created_by_app_user: null,
    ...base,
  });
  const app = (org: string, id: string) => ({
    id,
    organization_id: org,
    slug: 'portal',
    name: 'Portal',
    description: '',
    icon: '🤝',
    theme: {},
    home_screen: 'mis_pedidos',
    status: 'published',
    version: 1,
    created_by: null,
    updated_by: null,
    ...base,
    archived_at: null,
  });
  const screens = (org: string, appId: string, p: string) =>
    PORTAL_CLIENTES.screens.map((s, i) => ({
      id: `${p}-scr-${s.slug}`,
      organization_id: org,
      app_id: appId,
      view_id: `${p}-view-${s.slug}`,
      slug: s.slug,
      title: s.title,
      icon: s.icon,
      position: i,
      roles: s.roles,
    }));
  const views = (org: string, appId: string, p: string) =>
    PORTAL_CLIENTES.screens.map((s) => ({
      id: `${p}-view-${s.slug}`,
      organization_id: org,
      slug: `${p}_${s.slug}`,
      name: s.title,
      description: '',
      spec: s.spec,
      version: 1,
      visibility: 'workspace',
      share_token: null,
      share_expires_at: null,
      share_views: 0,
      pinned: false,
      app_id: appId,
      created_by: null,
      updated_by: null,
      ...base,
      archived_at: null,
    }));
  const roles = (org: string, appId: string) =>
    PORTAL_CLIENTES.roles.map((r, i) => ({
      id: `${appId}-role-${r.key}`,
      organization_id: org,
      app_id: appId,
      key: r.key,
      name: r.name,
      description: r.description,
      permissions: r.permissions,
      position: i,
    }));
  return {
    trackers: [
      tracker(POSTAL, 'trk-ped', 'pedidos_cliente', pedidosFields),
      tracker(POSTAL, 'trk-doc', 'documentos_cliente', documentosFields),
      tracker(OTRA, 'trk-ped-o', 'pedidos_cliente', pedidosFields),
      tracker(OTRA, 'trk-doc-o', 'documentos_cliente', documentosFields),
    ],
    tracker_rows: [
      pedido(POSTAL, 'trk-ped', 'a1', 'Andina', 'PED-001'),
      pedido(POSTAL, 'trk-ped', 'a2', 'Andina', 'PED-002', 'Entregada'),
      pedido(POSTAL, 'trk-ped', 'b1', 'Boreal', 'PED-001'),
      pedido(POSTAL, 'trk-ped', 'b2', 'Boreal', 'PED-003', 'Solicitada'),
      pedido(POSTAL, 'trk-ped', 'b3', 'Boreal', 'PED-004'),
      // Otra empresa, también con un «Andina» y el mismo número.
      pedido(OTRA, 'trk-ped-o', 'o1', 'Andina', 'PED-001'),
      documento(POSTAL, 'trk-doc', 'da', 'Andina', 'Factura Andina 10', 'file://andina-10.pdf'),
      documento(POSTAL, 'trk-doc', 'db', 'Boreal', 'Factura Boreal 77', 'file://boreal-77.pdf'),
      documento(OTRA, 'trk-doc-o', 'do', 'Andina', 'Factura otra empresa', 'file://otra.pdf'),
    ] as Array<Record<string, unknown>>,
    custom_apps: [app(POSTAL, APP), app(OTRA, APP_OTRA)],
    custom_app_screens: [...screens(POSTAL, APP, 'p'), ...screens(OTRA, APP_OTRA, 'o')],
    custom_views: [...views(POSTAL, APP, 'p'), ...views(OTRA, APP_OTRA, 'o')],
    custom_view_versions: [],
    custom_view_submissions: [] as Array<Record<string, unknown>>,
    custom_view_events: [] as Array<Record<string, unknown>>,
    custom_app_roles: [...roles(POSTAL, APP), ...roles(OTRA, APP_OTRA)],
    custom_app_users: [] as Array<Record<string, unknown>>,
    custom_app_sessions: [] as Array<Record<string, unknown>>,
  };
}

function world() {
  const fake = createFakeSupabase(seed());
  return {
    fake,
    postal: createOrgScopedClient(fake.client, POSTAL),
    otra: createOrgScopedClient(fake.client, OTRA),
  };
}

const user = (
  id: string,
  roleKey: string,
  attributes: Record<string, string> = {},
): ExternalUserRow => ({
  id,
  app_id: '',
  name: id,
  email: `${id}@x.co`,
  role_key: roleKey,
  attributes,
  status: 'active',
  invited_at: null,
  last_seen_at: '2026-10-05T00:00:00Z',
  created_by: null,
  created_at: '2026-10-01T00:00:00Z',
});

async function enter(
  db: ReturnType<typeof world>['postal'],
  u: ExternalUserRow,
  ref = 'portal',
): Promise<AppAccess> {
  const app = await getApp(db, ref);
  if (!app) throw new Error('sin app');
  const access = await externalAppAccess(db, app, u);
  if (!access) throw new Error(`${u.id} no entra`);
  return access;
}

const andina = (db: ReturnType<typeof world>['postal']) =>
  enter(db, user(ANDINA, 'cliente', { cliente: 'Andina' }));
const boreal = (db: ReturnType<typeof world>['postal']) =>
  enter(db, user(BOREAL, 'cliente', { cliente: 'Boreal' }));

async function read(db: ReturnType<typeof world>['postal'], access: AppAccess, slug: string) {
  const screen = access.screens.find((s) => s.slug === slug);
  if (!screen) throw new Error(`sin pantalla ${slug}`);
  return readScreen(db, access, screen);
}

/** Todo texto que un bloque entregó (celdas, títulos de tarjeta, metas): lo que el navegador recibiría. */
function visibleText(blocks: ComputedBlock[]): string {
  return JSON.stringify(blocks);
}

describe('portal de clientes: la plantilla', () => {
  it('está en el catálogo, con el rol Cliente filtrado por $user.cliente y sin exportar', () => {
    expect(APP_TEMPLATES.map((t) => t.id)).toContain('portal_clientes');
    const cliente = PORTAL_CLIENTES.roles.find((r) => r.key === 'cliente');
    expect(cliente?.permissions.tables.pedidos_cliente?.read).toEqual({
      field: 'cliente',
      equals: '$user.cliente',
    });
    expect(cliente?.permissions.export).toBe(false);
    expect(requiredAttributes(cliente?.permissions ?? { tables: {}, export: false })).toEqual([
      'cliente',
    ]);
    expect(PORTAL_CLIENTES.screens.map((s) => s.title)).toEqual([
      'Mis pedidos',
      'Nueva solicitud',
      'Mis documentos',
      'Atención',
    ]);
  });
});

describe('portal de clientes: el cliente A nunca ve lo del cliente B', () => {
  it('filas: Andina ve sólo las suyas, Boreal las suyas, aunque la referencia coincida', async () => {
    const { postal } = world();
    const a = await read(postal, await andina(postal), 'mis_pedidos');
    const b = await read(postal, await boreal(postal), 'mis_pedidos');
    expect(
      a.sources
        .get('pedidos_cliente')
        ?.rows.map((r) => r.id)
        .sort(),
    ).toEqual(['a1', 'a2']);
    expect(
      b.sources
        .get('pedidos_cliente')
        ?.rows.map((r) => r.id)
        .sort(),
    ).toEqual(['b1', 'b2', 'b3']);
    // Lo que llega al navegador tampoco menciona al otro.
    expect(visibleText(a.computed.blocks)).not.toContain('Boreal');
    expect(visibleText(a.computed.blocks)).not.toContain('PED-003');
    expect(visibleText(b.computed.blocks)).not.toContain('PED-002');
  });

  it('cifras: cada cliente cuenta sólo sus pedidos', async () => {
    const { postal } = world();
    const value = (r: Awaited<ReturnType<typeof read>>, id: string) => {
      const m = r.computed.blocks.find((b) => b.id === id);
      return m && m.type === 'metric' ? m.value : null;
    };
    const a = await read(postal, await andina(postal), 'mis_pedidos');
    const b = await read(postal, await boreal(postal), 'mis_pedidos');
    expect(value(a, 'en_curso')).toBe(1);
    expect(value(a, 'entregados')).toBe(1);
    expect(value(b, 'en_curso')).toBe(3);
    expect(value(b, 'entregados')).toBe(0);
  });

  it('archivos: «Mis documentos» sólo trae los del cliente', async () => {
    const { postal } = world();
    const a = await read(postal, await andina(postal), 'mis_documentos');
    const b = await read(postal, await boreal(postal), 'mis_documentos');
    expect(a.sources.get('documentos_cliente')?.rows.map((r) => r.id)).toEqual(['da']);
    expect(b.sources.get('documentos_cliente')?.rows.map((r) => r.id)).toEqual(['db']);
    expect(visibleText(a.computed.blocks)).toContain('andina-10.pdf');
    expect(visibleText(a.computed.blocks)).not.toContain('boreal-77.pdf');
    expect(visibleText(b.computed.blocks)).not.toContain('andina-10.pdf');
    expect(visibleText(a.computed.blocks)).not.toContain('otra.pdf');
  });

  it('exportar: el cliente no exporta; y aunque un rol de cliente exportara, saldría sólo lo suyo', async () => {
    const { postal, fake } = world();
    expect(appCanExport(await andina(postal))).toBe(false);
    // Un administrador le da «exporta» al rol: el Excel sale del MISMO scope.
    for (const r of fake.tables.custom_app_roles ?? [])
      if (r.key === 'cliente') (r.permissions as { export: boolean }).export = true;
    const a = await andina(postal);
    expect(appCanExport(a)).toBe(true);
    const exported = await read(postal, a, 'mis_pedidos');
    expect(
      exported.sources.get('pedidos_cliente')?.rows.every((r) => r.values.cliente === 'Andina'),
    ).toBe(true);
    expect(visibleText(exported.computed.blocks)).not.toContain('Boreal');
  });

  it('sin el atributo no ve NADA (no «todo»), y un atributo con otra capitalización no abre filas ajenas', async () => {
    const { postal } = world();
    const sin = await enter(postal, user(ANDINA, 'cliente', {}));
    const r = await read(postal, sin, 'mis_pedidos');
    expect(r.sources.get('pedidos_cliente')?.rows).toEqual([]);
    const otro = await enter(postal, user(ANDINA, 'cliente', { cliente: 'andina' }));
    expect((await read(postal, otro, 'mis_pedidos')).sources.get('pedidos_cliente')?.rows).toEqual(
      [],
    );
  });

  it('otra empresa con un cliente «Andina»: no se mezclan', async () => {
    const { postal, otra } = world();
    const aOtra = await enter(otra, user(ANDINA_OTRA, 'cliente', { cliente: 'Andina' }), 'portal');
    const rows = (await read(otra, aOtra, 'mis_pedidos')).sources.get('pedidos_cliente')?.rows;
    expect(rows?.map((r) => r.id)).toEqual(['o1']);
    const aPostal = await andina(postal);
    expect(
      (await read(postal, aPostal, 'mis_pedidos')).sources
        .get('pedidos_cliente')
        ?.rows.map((r) => r.id),
    ).not.toContain('o1');
    expect(await getApp(postal, APP_OTRA)).toBeNull();
  });

  it('el cliente no entra a «Atención» (404) y atención sí ve a todos', async () => {
    const { postal } = world();
    const a = await andina(postal);
    expect(visibleScreens(a).map((s) => s.slug)).toEqual([
      'mis_pedidos',
      'nueva_solicitud',
      'mis_documentos',
    ]);
    expect(screenFor(a, 'atencion')).toBeNull();
    const equipo = await enter(postal, user(ATENCION, 'atencion'));
    const todo = await read(postal, equipo, 'atencion');
    expect(todo.sources.get('pedidos_cliente')?.rows.length).toBe(5);
  });
});

describe('portal de clientes: escrituras', () => {
  async function formOf(db: ReturnType<typeof world>['postal'], access: AppAccess) {
    const screen = screenFor(access, 'nueva_solicitud');
    if (!screen) throw new Error('sin pantalla');
    const { view } = await readScreen(db, access, screen);
    return { view, blockId: view.spec.blocks.find((b) => b.type === 'form')?.id ?? 'x' };
  }

  it('la solicitud queda a nombre de SU cliente (lo escribe el servidor) y el otro cliente no la ve', async () => {
    const { postal, fake } = world();
    const a = await andina(postal);
    const { view, blockId } = await formOf(postal, a);
    await submitAppForm(postal, a, view, {
      blockId,
      values: { referencia: 'SOL-900', fecha: '2026-10-06', descripcion: 'Necesito más cajas' },
    });
    const row = fake.tables.tracker_rows?.find((r) => r.label === 'SOL-900');
    expect((row?.values as Record<string, string>).cliente).toBe('Andina');
    expect((row?.values as Record<string, string>).estado).toBe('Solicitada');
    expect(row?.created_by_app_user).toBe(ANDINA);
    const propias = await read(postal, a, 'mis_pedidos');
    expect(propias.sources.get('pedidos_cliente')?.rows.map((r) => r.label)).toContain('SOL-900');
    const b = await read(postal, await boreal(postal), 'mis_pedidos');
    expect(b.sources.get('pedidos_cliente')?.rows.map((r) => r.label)).not.toContain('SOL-900');
  });

  it('no puede crear a nombre de otro cliente ni fijar el estado', async () => {
    const { postal } = world();
    const a = await andina(postal);
    const { view, blockId } = await formOf(postal, a);
    await expect(
      submitAppForm(postal, a, view, {
        blockId,
        values: { referencia: 'SOL-901', fecha: '2026-10-06', cliente: 'Boreal' },
      }),
    ).rejects.toThrow(/no puede escribir/);
    await expect(
      submitAppForm(postal, a, view, {
        blockId,
        values: { referencia: 'SOL-902', fecha: '2026-10-06', estado: 'Entregada' },
      }),
    ).rejects.toThrow(/no puede escribir/);
  });

  it('no edita filas del otro cliente ni las propias (edit: none)', async () => {
    const { postal } = world();
    const a = await andina(postal);
    const screen = screenFor(a, 'mis_pedidos');
    if (!screen) throw new Error('sin pantalla');
    const { view } = await readScreen(postal, a, screen);
    const block = view.spec.blocks.find((b) => 'tracker' in b);
    for (const rowId of ['b1', 'o1', 'a1'])
      await expect(
        editAppRow(postal, a, view, {
          blockId: block?.id ?? 'x',
          rowId,
          patch: { estado: 'Entregada' },
        }),
      ).rejects.toThrow();
  });
});

describe('portal de clientes: invitar pide el valor del atributo', () => {
  it('un rol con filtro por atributo no se invita sin él, y con él queda guardado', async () => {
    const { postal } = world();
    await expect(
      inviteAppUser(postal, APP, { name: 'Ana', email: 'ana@andina.co', roleKey: 'cliente' }, 'u'),
    ).rejects.toThrow(/«cliente»/);
    const { user: u } = await inviteAppUser(
      postal,
      APP,
      {
        name: 'Ana',
        email: 'ana@andina.co',
        roleKey: 'cliente',
        attributes: { cliente: 'Andina' },
      },
      'u',
    );
    expect(u.attributes).toEqual({ cliente: 'Andina' });
    // Cambiarla de rol a uno sin filtro no exige nada; volver a cliente sin su cliente, sí.
    await updateAppUser(postal, APP, u.id, { roleKey: 'atencion' });
    await expect(
      updateAppUser(postal, APP, u.id, { roleKey: 'cliente', attributes: {} }),
    ).rejects.toThrow(/«cliente»/);
  });

  it('autocompleta con los valores reales de la columna, sólo de esta empresa', async () => {
    const { postal, otra } = world();
    const roles = PORTAL_CLIENTES.roles;
    expect(await attributeValueSuggestions(postal, roles)).toEqual({
      cliente: ['Andina', 'Boreal'],
    });
    expect(await attributeValueSuggestions(otra, roles)).toEqual({ cliente: ['Andina'] });
    // Un rol sin filtros por atributo no pide nada.
    expect(await attributeValueSuggestions(postal, [roles[1] as (typeof roles)[number]])).toEqual(
      {},
    );
  });
});

describe('portal de clientes: «Ver como cliente X»', () => {
  it('el administrador mira con los atributos del cliente elegido y el resultado es sólo de ese cliente', async () => {
    const { postal } = world();
    const access = await (await import('../store')).resolveAppAccess(
      postal,
      'portal',
      { id: 'u-admin', name: 'Admin', companyAdmin: true },
      { preview: { roleKey: 'cliente', attributes: { cliente: 'Boreal' } } },
    );
    if (!access) throw new Error('sin acceso');
    expect(access.role.admin).toBe(false);
    const r = await read(postal, access, 'mis_pedidos');
    expect(r.sources.get('pedidos_cliente')?.rows.every((x) => x.values.cliente === 'Boreal')).toBe(
      true,
    );
    expect(visibleText(r.computed.blocks)).not.toContain('Andina');
  });
});
