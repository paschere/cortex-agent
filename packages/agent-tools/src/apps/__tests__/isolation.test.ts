import { describe, expect, it } from 'vitest';
import { createFakeSupabase } from '../../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../tenancy/scoped-client';
import type { ComputedBlock } from '../../views/compute';
import { APPROVE_ACTION_ID } from '../../views/spec';
import {
  SubmissionLimitError,
  archiveView,
  findViewByToken,
  getView,
  listViews,
  setViewAccess,
} from '../../views/store';
import { type ExternalUserRow, externalAppAccess } from '../external';
import {
  type AppAccess,
  type AppViewer,
  appCanExport,
  editAppRow,
  listApps,
  readScreen,
  resolveAppAccess,
  runAppAction,
  screenFor,
  submitAppForm,
  visibleScreens,
} from '../store';
import { EXTERNAL_SUBMISSIONS_PER_USER_HOUR, getApp } from '../store';
import { CONTROL_EN_PLANTA } from '../templates';

/**
 * DOS EMPRESAS, UNA BASE: LA MITAD DE LAS APLICACIONES.
 *
 * Misma postura que commitments/__tests__/isolation.test.ts y el fixture es
 * adverso igual: las dos empresas tienen una app «planta», una tabla «guias»
 * y una guía con el MISMO número; así, una consulta que perdiera el filtro de
 * empresa devolvería algo PLAUSIBLE y no algo vacío. Dentro de la empresa
 * Postal hay además dos operarios con filas propias y un supervisor.
 *
 * Se prueba el producto de verdad (`store.ts` de apps y el `loadViewSources`
 * de las vistas) con el cliente acotado que usa producción; cada afirmación es
 * sobre qué filas volvieron o qué se rechazó ANTES de escribir.
 */

const POSTAL = 'org-postal';
const ADUANAS = 'org-aduanas';

const ADMIN = 'u-admin'; // owner de Postal
const ANA = 'u-ana'; // operaria de Postal
const BETO = 'u-beto'; // operario de Postal
const SOFIA = 'u-sofia'; // supervisora de Postal
const GERENTE = 'u-gerente'; // gerencia de Postal
const CARLA = 'u-carla'; // operaria de Aduanas

const guiaFields = CONTROL_EN_PLANTA.trackers[0]?.fields ?? [];

function seed() {
  const tracker = (org: string, id: string) => ({
    id,
    organization_id: org,
    slug: 'guias',
    name: 'Guías',
    description: '',
    fields: guiaFields,
    duplicates: null,
    created_by: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
  });
  const row = (
    org: string,
    trackerId: string,
    id: string,
    by: string,
    numero: string,
    estado = 'Por aprobar',
  ) => ({
    id,
    organization_id: org,
    tracker_id: trackerId,
    label: numero,
    values: { numero_guia: numero, fecha: '2026-10-05', estado },
    created_by: by,
    created_at: '2026-10-05T10:00:00Z',
    updated_at: '2026-10-05T10:00:00Z',
  });
  const app = (org: string, id: string) => ({
    id,
    organization_id: org,
    slug: 'planta',
    name: 'Control en planta',
    description: '',
    icon: '🏭',
    theme: {},
    home_screen: 'registrar',
    status: 'published',
    version: 1,
    created_by: null,
    updated_by: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    archived_at: null,
  });
  const screens = (org: string, appId: string, prefix: string) =>
    CONTROL_EN_PLANTA.screens.map((s, i) => ({
      id: `${prefix}-scr-${s.slug}`,
      organization_id: org,
      app_id: appId,
      view_id: `${prefix}-view-${s.slug}`,
      slug: s.slug,
      title: s.title,
      icon: s.icon,
      position: i,
      roles: s.roles,
    }));
  const views = (org: string, appId: string, prefix: string) =>
    CONTROL_EN_PLANTA.screens.map((s) => ({
      id: `${prefix}-view-${s.slug}`,
      organization_id: org,
      slug: `${prefix}_${s.slug}`,
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
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-01T00:00:00Z',
      archived_at: null,
    }));
  const roles = (org: string, appId: string) =>
    CONTROL_EN_PLANTA.roles.map((r, i) => ({
      id: `${appId}-role-${r.key}`,
      organization_id: org,
      app_id: appId,
      key: r.key,
      name: r.name,
      description: r.description,
      permissions: r.permissions,
      position: i,
    }));
  const member = (org: string, appId: string, user: string, roleKey: string) => ({
    id: `${appId}-m-${user}`,
    organization_id: org,
    app_id: appId,
    user_id: user,
    role_key: roleKey,
    attributes: {},
    created_by: null,
    created_at: '2026-10-01T00:00:00Z',
  });

  return {
    trackers: [tracker(POSTAL, 'trk-postal'), tracker(ADUANAS, 'trk-aduanas')],
    tracker_rows: [
      row(POSTAL, 'trk-postal', 'p1', ANA, '123-001'),
      row(POSTAL, 'trk-postal', 'p2', ANA, '123-002'),
      row(POSTAL, 'trk-postal', 'p3', BETO, '123-003'),
      // El mismo número que la primera de Postal, en la otra empresa.
      row(ADUANAS, 'trk-aduanas', 'a1', CARLA, '123-001'),
    ],
    custom_apps: [app(POSTAL, 'app-postal'), app(ADUANAS, 'app-aduanas')],
    custom_app_screens: [
      ...screens(POSTAL, 'app-postal', 'p'),
      ...screens(ADUANAS, 'app-aduanas', 'a'),
    ],
    custom_views: [...views(POSTAL, 'app-postal', 'p'), ...views(ADUANAS, 'app-aduanas', 'a')],
    custom_app_roles: [...roles(POSTAL, 'app-postal'), ...roles(ADUANAS, 'app-aduanas')],
    custom_app_members: [
      member(POSTAL, 'app-postal', ANA, 'operario'),
      member(POSTAL, 'app-postal', BETO, 'operario'),
      member(POSTAL, 'app-postal', SOFIA, 'supervisor'),
      member(POSTAL, 'app-postal', GERENTE, 'gerencia'),
      member(ADUANAS, 'app-aduanas', CARLA, 'operario'),
    ],
  };
}

function world() {
  const fake = createFakeSupabase(seed());
  return {
    postal: createOrgScopedClient(fake.client, POSTAL),
    aduanas: createOrgScopedClient(fake.client, ADUANAS),
  };
}

const viewer = (id: string, companyAdmin = false): AppViewer => ({ id, name: id, companyAdmin });

async function enter(db: ReturnType<typeof world>['postal'], who: AppViewer) {
  const access = await resolveAppAccess(db, 'planta', who);
  if (!access) throw new Error(`${who.id} no entra`);
  return access;
}

/** Las filas que un bloque entregó al navegador, en cualquiera de sus formas. */
function numbers(block: ComputedBlock | undefined): string[] {
  if (!block || block.type !== 'table') return [];
  return block.rows.flatMap((r) => r.cells.map(String)).filter((c) => /^\d{3}-\d{3}$/.test(c));
}

describe('aplicaciones: dos empresas, una base', () => {
  it('una app de otra empresa no existe: ni se lista ni se abre', async () => {
    const { postal, aduanas } = world();
    expect((await listApps(postal)).map((a) => a.id)).toEqual(['app-postal']);
    expect((await listApps(aduanas)).map((a) => a.id)).toEqual(['app-aduanas']);
    // Carla, de Aduanas, no entra a la app de Postal por su slug ni por su id.
    expect(await resolveAppAccess(postal, 'planta', viewer(CARLA))).toBeNull();
    expect(await resolveAppAccess(postal, 'app-aduanas', viewer(ADMIN, true))).toBeNull();
    // Y el administrador de Postal tampoco abre la de Aduanas.
    expect(await resolveAppAccess(aduanas, 'app-postal', viewer(ADMIN, true))).toBeNull();
  });

  it('una operaria de Aduanas sólo ve filas de Aduanas aunque el número coincida', async () => {
    const { aduanas } = world();
    const access = await enter(aduanas, viewer(CARLA));
    const screen = screenFor(access, 'mis_registros');
    expect(screen).not.toBeNull();
    if (!screen) return;
    const { sources } = await readScreen(aduanas, access, screen);
    expect(sources.get('guias')?.rows.map((r) => r.id)).toEqual(['a1']);
  });

  it('quien no es miembro de la app, o no es de la empresa, no entra', async () => {
    const { postal } = world();
    expect(await resolveAppAccess(postal, 'planta', viewer('u-nadie'))).toBeNull();
  });
});

describe('aplicaciones: el operario sólo ve lo suyo (tablas, métricas, gráficos y exportar)', () => {
  it('lee sólo sus filas, y a Beto no le llegan las de Ana', async () => {
    const { postal } = world();
    const ana = await enter(postal, viewer(ANA));
    const beto = await enter(postal, viewer(BETO));
    const read = async (a: AppAccess) => {
      const screen = screenFor(a, 'mis_registros');
      if (!screen) throw new Error('sin pantalla');
      return readScreen(postal, a, screen);
    };
    expect(
      (await read(ana)).sources
        .get('guias')
        ?.rows.map((r) => r.id)
        .sort(),
    ).toEqual(['p1', 'p2']);
    expect((await read(beto)).sources.get('guias')?.rows.map((r) => r.id)).toEqual(['p3']);
    const tabla = (await read(ana)).computed.blocks.find((b) => b.type === 'table');
    expect(numbers(tabla).sort()).toEqual(['123-001', '123-002']);
  });

  it('las cifras de un operario cuentan sus filas y no las del supervisor', async () => {
    const { postal } = world();
    const ana = await enter(postal, viewer(ANA));
    const sofia = await enter(postal, viewer(SOFIA));
    const screenOf = (a: AppAccess) => {
      const screen = a.screens.find((s) => s.slug === 'tablero');
      if (!screen) throw new Error('sin tablero');
      return screen;
    };
    // La pantalla «Tablero» no es de la operaria (404 por la ruta), pero aun
    // forzando la lectura con SU rol, el cómputo parte de sus filas.
    const total = async (a: AppAccess) => {
      const { computed } = await readScreen(postal, a, screenOf(a));
      const counts = computed.blocks.flatMap((b) =>
        b.type === 'metric' && typeof b.value === 'number' ? [b.value] : [],
      );
      return Math.max(0, ...counts);
    };
    const own = await total(ana);
    const all = await total(sofia);
    expect(own).toBeLessThanOrEqual(2);
    expect(all).toBeGreaterThanOrEqual(3);
  });

  it('no exporta: el rol Operario no tiene permiso, el supervisor sí', async () => {
    const { postal } = world();
    expect(appCanExport(await enter(postal, viewer(ANA)))).toBe(false);
    expect(appCanExport(await enter(postal, viewer(SOFIA)))).toBe(true);
    expect(appCanExport(await enter(postal, viewer(ADMIN, true)))).toBe(true);
  });
});

describe('aplicaciones: pantallas', () => {
  it('un rol sin la pantalla no la tiene: es como si no existiera (404)', async () => {
    const { postal } = world();
    const ana = await enter(postal, viewer(ANA));
    expect(visibleScreens(ana).map((s) => s.slug)).toEqual(['registrar', 'mis_registros']);
    expect(screenFor(ana, 'por_aprobar')).toBeNull();
    expect(screenFor(ana, 'tablero')).toBeNull();
    const gerente = await enter(postal, viewer(GERENTE));
    expect(visibleScreens(gerente).map((s) => s.slug)).toEqual(['tablero']);
    expect(screenFor(gerente, 'registrar')).toBeNull();
  });

  it('una app sin publicar sólo la abre quien administra', async () => {
    const fake = createFakeSupabase(seed());
    for (const a of fake.tables.custom_apps ?? []) a.status = 'draft';
    const db = createOrgScopedClient(fake.client, POSTAL);
    expect(await resolveAppAccess(db, 'planta', viewer(ANA))).toBeNull();
    expect(await resolveAppAccess(db, 'planta', viewer(ADMIN, true))).not.toBeNull();
  });

  it('«Ver como…» entrega el rol pedido, no el de administrador', async () => {
    const { postal } = world();
    const access = await resolveAppAccess(postal, 'planta', viewer(ADMIN, true), {
      preview: { roleKey: 'operario' },
    });
    expect(access?.role.admin).toBe(false);
    expect(access && visibleScreens(access).map((s) => s.slug)).toEqual([
      'registrar',
      'mis_registros',
    ]);
  });
});

describe('aplicaciones: escrituras con rol', () => {
  it('el operario no aprueba ni rechaza', async () => {
    const { postal } = world();
    const ana = await enter(postal, viewer(ANA));
    const screen = screenFor(ana, 'mis_registros');
    if (!screen) throw new Error('sin pantalla');
    const { view } = await readScreen(postal, ana, screen);
    const por = view.spec.blocks.find((b) => 'tracker' in b);
    await expect(
      runAppAction(postal, ana, view, {
        blockId: por?.id ?? 'x',
        actionId: APPROVE_ACTION_ID,
        rowId: 'p1',
      }),
    ).rejects.toThrow(/no aprueba/);
  });

  it('no escribe campos fuera de su lista', async () => {
    const { postal } = world();
    const ana = await enter(postal, viewer(ANA));
    const screen = screenFor(ana, 'registrar');
    if (!screen) throw new Error('sin pantalla');
    const { view } = await readScreen(postal, ana, screen);
    const form = view.spec.blocks.find((b) => b.type === 'form');
    await expect(
      submitAppForm(postal, ana, view, {
        blockId: form?.id ?? 'x',
        values: { numero_guia: '999-001', estado: 'Aprobada' },
      }),
    ).rejects.toThrow(/no puede escribir/);
  });

  it('no edita la fila de otro ni una de otra empresa: para él no existe', async () => {
    const { postal } = world();
    const ana = await enter(postal, viewer(ANA));
    const screen = screenFor(ana, 'mis_registros');
    if (!screen) throw new Error('sin pantalla');
    const { view } = await readScreen(postal, ana, screen);
    const block = view.spec.blocks.find((b) => b.type === 'table');
    for (const rowId of ['p3', 'a1']) {
      await expect(
        editAppRow(postal, ana, view, {
          blockId: block?.id ?? 'x',
          rowId,
          patch: { ubicacion: 'Muelle 9' },
        }),
      ).rejects.toThrow(/ya no está/);
    }
  });

  it('gerencia no registra: su rol no crea en la tabla', async () => {
    const { postal } = world();
    const gerente = await enter(postal, viewer(GERENTE));
    const ana = await enter(postal, viewer(ANA));
    const screen = screenFor(ana, 'registrar');
    if (!screen) throw new Error('sin pantalla');
    const { view } = await readScreen(postal, ana, screen);
    const form = view.spec.blocks.find((b) => b.type === 'form');
    await expect(
      submitAppForm(postal, gerente, view, { blockId: form?.id ?? 'x', values: {} }),
    ).rejects.toThrow(/no registra/);
  });
});

describe('aplicaciones: las pantallas no se abren por la puerta de las vistas', () => {
  it('getView, listViews y setViewAccess no ven una pantalla de app (saltaría el rol)', async () => {
    const { postal } = world();
    expect(await getView(postal, 'p_tablero')).toBeNull();
    expect((await getView(postal, 'p_tablero', { appScreens: true }))?.app_id).toBe('app-postal');
    expect(await listViews(postal)).toEqual([]);
    await expect(
      setViewAccess(postal, 'p-view-tablero', { visibility: 'link', userId: ADMIN }),
    ).rejects.toThrow();
    expect(await archiveView(postal, 'p-view-tablero')).toBe(false);
    expect(await findViewByToken(postal, 'x'.repeat(32))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// FASE 2: USUARIOS EXTERNOS (0209)
// ---------------------------------------------------------------------------

const EXT_ANA = 'e0000000-0000-4000-8000-00000000a001'; // operaria externa de Postal
const EXT_BETO = 'e0000000-0000-4000-8000-00000000b002'; // operario externo de Postal
const EXT_CLIENTE = 'e0000000-0000-4000-8000-00000000c003'; // cliente de Postal, zona Norte
const EXT_CARLA = 'e0000000-0000-4000-8000-00000000d004'; // operaria externa de Aduanas

const externalUser = (
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

function externalWorld() {
  const data = seed();
  const row = (
    id: string,
    by: Partial<Record<'created_by' | 'created_by_app_user', string>>,
    numero: string,
    zona: string,
    org = POSTAL,
    trk = 'trk-postal',
  ) => ({
    id,
    organization_id: org,
    tracker_id: trk,
    label: numero,
    values: { numero_guia: numero, fecha: '2026-10-05', estado: 'Por aprobar', ubicacion: zona },
    created_by: by.created_by ?? null,
    created_by_app_user: by.created_by_app_user ?? null,
    created_at: '2026-10-05T10:00:00Z',
    updated_at: '2026-10-05T10:00:00Z',
  });
  (data.tracker_rows as Array<Record<string, unknown>>).push(
    row('e1', { created_by_app_user: EXT_ANA }, '777-001', 'Norte'),
    row('e2', { created_by_app_user: EXT_BETO }, '777-002', 'Sur'),
    // Un MIEMBRO con el mismo uuid que una externa: «own» no los mezcla.
    row('m1', { created_by: EXT_ANA }, '777-003', 'Norte'),
    row('c1', { created_by_app_user: EXT_CARLA }, '777-001', 'Norte', ADUANAS, 'trk-aduanas'),
  );
  const cliente = {
    id: 'app-postal-role-cliente',
    organization_id: POSTAL,
    app_id: 'app-postal',
    key: 'cliente',
    name: 'Cliente',
    description: '',
    permissions: {
      tables: {
        guias: {
          read: { field: 'ubicacion', equals: '$user.zona' },
          create: false,
          edit: 'none',
          actions: [],
        },
      },
      export: true,
    },
    position: 9,
  };
  (data.custom_app_roles as Array<Record<string, unknown>>).push(cliente);
  const fake = createFakeSupabase({
    ...data,
    custom_view_submissions: [] as Array<Record<string, unknown>>,
  });
  return {
    fake,
    postal: createOrgScopedClient(fake.client, POSTAL),
    aduanas: createOrgScopedClient(fake.client, ADUANAS),
  };
}

async function enterExternal(
  db: ReturnType<typeof externalWorld>['postal'],
  user: ExternalUserRow,
  appRef = 'planta',
) {
  const app = await getApp(db, appRef);
  if (!app) throw new Error('sin app');
  const access = await externalAppAccess(db, app, user);
  if (!access) throw new Error(`${user.id} no entra`);
  return access;
}

const idsOf = async (
  db: ReturnType<typeof externalWorld>['postal'],
  access: AppAccess,
  slug: string,
) => {
  const screen = access.screens.find((s) => s.slug === slug);
  if (!screen) throw new Error('sin pantalla');
  const read = await readScreen(db, access, screen);
  const rows = read.sources.get('guias')?.rows ?? [];
  return { read, ids: rows.map((r) => r.id).sort(), labels: rows.map((r) => r.label).sort() };
};

describe('aplicaciones, usuarios externos: aislamiento', () => {
  it('el externo de Aduanas nunca ve filas de Postal ni al revés, aunque el número coincida', async () => {
    const { postal, aduanas } = externalWorld();
    const carla = await enterExternal(aduanas, externalUser(EXT_CARLA, 'operario'));
    expect((await idsOf(aduanas, carla, 'mis_registros')).ids).toEqual(['c1']);
    const ana = await enterExternal(postal, externalUser(EXT_ANA, 'operario'));
    expect((await idsOf(postal, ana, 'mis_registros')).ids).not.toContain('c1');
    // La app de Postal no existe para el handle de Aduanas.
    expect(await getApp(aduanas, 'app-postal')).toBeNull();
  });

  it('«own» de un externo mira created_by_app_user: no ve lo de otro externo ni lo de un miembro con su mismo uuid', async () => {
    const { postal } = externalWorld();
    const ana = await enterExternal(postal, externalUser(EXT_ANA, 'operario'));
    const beto = await enterExternal(postal, externalUser(EXT_BETO, 'operario'));
    expect((await idsOf(postal, ana, 'mis_registros')).ids).toEqual(['e1']);
    expect((await idsOf(postal, beto, 'mis_registros')).ids).toEqual(['e2']);
  });

  it('un MIEMBRO sigue viendo lo suyo por created_by (las dos formas de «own» conviven)', async () => {
    const { fake, postal } = externalWorld();
    // Un miembro con el mismo uuid que la externa: lee `created_by`, no `created_by_app_user`.
    fake.tables.custom_app_members?.push({
      id: 'm-x',
      organization_id: POSTAL,
      app_id: 'app-postal',
      user_id: EXT_ANA,
      role_key: 'operario',
      attributes: {},
      created_by: null,
      created_at: '2026-10-01T00:00:00Z',
    });
    const miembro = await enter(postal, viewer(EXT_ANA));
    expect((await idsOf(postal, miembro, 'mis_registros')).labels).toEqual(['777-003']);
    const externa = await enterExternal(postal, externalUser(EXT_ANA, 'operario'));
    expect((await idsOf(postal, externa, 'mis_registros')).labels).toEqual(['777-001']);
  });

  it('un externo no entra a pantallas de otro rol (404) ni lee con el Feed: audiencia pública', async () => {
    const { postal } = externalWorld();
    const ana = await enterExternal(postal, externalUser(EXT_ANA, 'operario'));
    expect(visibleScreens(ana).map((s) => s.slug)).toEqual(['registrar', 'mis_registros']);
    expect(screenFor(ana, 'tablero')).toBeNull();
    expect(ana.role.admin).toBe(false);
  });
});

describe('aplicaciones, usuarios externos: portal de clientes con $user.<atributo>', () => {
  it('el cliente de la zona Norte sólo ve filas Norte: en tablas, cifras y exportar', async () => {
    const { postal } = externalWorld();
    const norte = await enterExternal(
      postal,
      externalUser(EXT_CLIENTE, 'cliente', { zona: 'Norte' }),
    );
    const sur = await enterExternal(postal, externalUser(EXT_CLIENTE, 'cliente', { zona: 'Sur' }));
    const sin = await enterExternal(postal, externalUser(EXT_CLIENTE, 'cliente', {}));
    expect((await idsOf(postal, norte, 'tablero')).ids).toEqual(['e1', 'm1']);
    expect((await idsOf(postal, sur, 'tablero')).ids).toEqual(['e2']);
    // Sin el atributo no ve NINGUNA, no «todas».
    expect((await idsOf(postal, sin, 'tablero')).ids).toEqual([]);
    // Cifras: parten de las filas permitidas.
    const metrics = async (a: AppAccess) =>
      (await idsOf(postal, a, 'tablero')).read.computed.blocks.flatMap((b) =>
        b.type === 'metric' && typeof b.value === 'number' ? [b.value] : [],
      );
    expect(Math.max(0, ...(await metrics(norte)))).toBeLessThanOrEqual(2);
    expect(Math.max(0, ...(await metrics(sur)))).toBeLessThanOrEqual(1);
    // Exportar: el rol exporta y lo que baja sale del MISMO scope.
    expect(appCanExport(norte)).toBe(true);
    const tabla = (await idsOf(postal, sur, 'tablero')).read.computed.blocks.find(
      (b) => b.type === 'table',
    );
    expect(numbers(tabla)).toEqual(['777-002']);
  });

  it('un cliente no escribe: su rol no crea ni edita', async () => {
    const { postal } = externalWorld();
    const cli = await enterExternal(
      postal,
      externalUser(EXT_CLIENTE, 'cliente', { zona: 'Norte' }),
    );
    const ana = await enterExternal(postal, externalUser(EXT_ANA, 'operario'));
    const screen = screenFor(ana, 'registrar');
    if (!screen) throw new Error('sin pantalla');
    const { view } = await readScreen(postal, ana, screen);
    const form = view.spec.blocks.find((b) => b.type === 'form');
    await expect(
      submitAppForm(postal, cli, view, { blockId: form?.id ?? 'x', values: {} }),
    ).rejects.toThrow(/no registra/);
  });
});

describe('aplicaciones, usuarios externos: escrituras', () => {
  async function formOf(db: ReturnType<typeof externalWorld>['postal'], access: AppAccess) {
    const screen = screenFor(access, 'registrar');
    if (!screen) throw new Error('sin pantalla');
    const { view } = await readScreen(db, access, screen);
    const form = view.spec.blocks.find((b) => b.type === 'form');
    return { view, blockId: form?.id ?? 'x' };
  }

  it('el operario externo no aprueba, no rechaza y no escribe campos ajenos', async () => {
    const { postal } = externalWorld();
    const ana = await enterExternal(postal, externalUser(EXT_ANA, 'operario'));
    const { view, blockId } = await formOf(postal, ana);
    await expect(
      runAppAction(postal, ana, view, { blockId, actionId: APPROVE_ACTION_ID, rowId: 'e1' }),
    ).rejects.toThrow(/no aprueba/);
    await expect(
      submitAppForm(postal, ana, view, {
        blockId,
        values: { numero_guia: '999-001', estado: 'Aprobada' },
      }),
    ).rejects.toThrow(/no puede escribir/);
  });

  it('no edita la fila de otro externo ni la de un miembro: para él no existen', async () => {
    const { postal } = externalWorld();
    const ana = await enterExternal(postal, externalUser(EXT_ANA, 'operario'));
    const screen = screenFor(ana, 'mis_registros');
    if (!screen) throw new Error('sin pantalla');
    const { view } = await readScreen(postal, ana, screen);
    const block = view.spec.blocks.find((b) => b.type === 'table');
    for (const rowId of ['e2', 'm1', 'p1', 'c1'])
      await expect(
        editAppRow(postal, ana, view, {
          blockId: block?.id ?? 'x',
          rowId,
          patch: { ubicacion: 'Muelle 9' },
        }),
      ).rejects.toThrow(/ya no está/);
  });

  it('su envío queda con created_by_app_user (y created_by vacío) y lo ve en «Mis registros»', async () => {
    const { postal, fake } = externalWorld();
    const ana = await enterExternal(postal, externalUser(EXT_ANA, 'operario'));
    const { view, blockId } = await formOf(postal, ana);
    const res = await submitAppForm(postal, ana, view, {
      blockId,
      values: { numero_guia: '888-001', fecha: '2026-10-05', ubicacion: 'Norte' },
    });
    expect(res.message).toBeTruthy();
    const row = fake.tables.tracker_rows?.find((r) => r.label === '888-001');
    expect(row?.created_by_app_user).toBe(EXT_ANA);
    expect(row?.created_by).toBeNull();
    expect((await idsOf(postal, ana, 'mis_registros')).labels).toContain('888-001');
    const beto = await enterExternal(postal, externalUser(EXT_BETO, 'operario'));
    expect((await idsOf(postal, beto, 'mis_registros')).labels).not.toContain('888-001');
    // El envío queda a nombre del externo (para poder corregirlo dentro de la ventana).
    expect(fake.tables.custom_view_submissions?.at(-1)?.submitted_by).toBe(EXT_ANA);
  });

  it('lo que hace un supervisor externo deja el evento con el actor externo', async () => {
    const { postal, fake } = externalWorld();
    const sofia = await enterExternal(postal, externalUser(EXT_BETO, 'supervisor'));
    const screen = screenFor(sofia, 'por_aprobar');
    if (!screen) throw new Error('sin pantalla');
    const { view } = await readScreen(postal, sofia, screen);
    const block = view.spec.blocks.find((b) => 'actions' in b);
    // El supervisor externo SÍ aprueba (su rol lo permite): p1 es de un miembro y lo ve por scope «all».
    for (const r of fake.tables.tracker_rows ?? [])
      if (r.id === 'p1') (r.values as Record<string, string>).estado = 'Pendiente';
    await runAppAction(postal, sofia, view, {
      blockId: block?.id ?? 'x',
      actionId: APPROVE_ACTION_ID,
      rowId: 'p1',
    });
    expect(fake.tables.custom_view_events?.at(-1)).toMatchObject({
      actor: EXT_BETO,
      actor_kind: 'app_user',
    });
  });

  it('el tope por usuario corta los envíos de la hora', async () => {
    const { postal, fake } = externalWorld();
    const ana = await enterExternal(postal, externalUser(EXT_ANA, 'operario'));
    const { view, blockId } = await formOf(postal, ana);
    const now = new Date().toISOString();
    for (let i = 0; i < EXTERNAL_SUBMISSIONS_PER_USER_HOUR; i++)
      fake.tables.custom_view_submissions?.push({
        id: `s${i}`,
        organization_id: POSTAL,
        view_id: view.id,
        submitted_by: EXT_ANA,
        created_at: now,
      });
    await expect(
      submitAppForm(postal, ana, view, {
        blockId,
        values: { numero_guia: '888-009', fecha: '2026-10-05' },
      }),
    ).rejects.toBeInstanceOf(SubmissionLimitError);
    // Otro usuario externo de la misma app no está topado por el de Ana.
    const beto = await enterExternal(postal, externalUser(EXT_BETO, 'operario'));
    await expect(
      submitAppForm(postal, beto, view, {
        blockId,
        values: { numero_guia: '888-010', fecha: '2026-10-05' },
      }),
    ).resolves.toBeTruthy();
  });
});
