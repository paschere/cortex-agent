import { describe, expect, it } from 'vitest';
import { createFakeSupabase } from '../../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../tenancy/scoped-client';
import type { ComputedBlock } from '../../views/compute';
import { APPROVE_ACTION_ID } from '../../views/spec';
import { archiveView, findViewByToken, getView, listViews, setViewAccess } from '../../views/store';
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
