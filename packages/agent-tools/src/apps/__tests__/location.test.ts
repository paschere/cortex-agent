import { describe, expect, it } from 'vitest';
import { createFakeSupabase } from '../../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../tenancy/scoped-client';
import { computeView } from '../../views/compute';
import { findWriteBlock } from '../../views/spec';
import { externalAppAccess } from '../external';
import type { ExternalUserRow } from '../external';
import {
  acceptLocationConsent,
  closeStaleShifts,
  endShift,
  listAssignablePeople,
  listLivePeople,
  locationStatus,
  purgeLocationHistory,
  recordPosition,
  revokeLocation,
  startShift,
} from '../location';
import {
  HISTORY_INTERVAL_SECONDS,
  LOCATION_TEXT_VERSION,
  MIN_PING_INTERVAL_SECONDS,
  consentText,
  parsePersonRef,
  parsePosition,
  personRef,
} from '../location-shape';
import { USER_ID_ATTRIBUTE, canViewLocations, rowAccessFor } from '../permissions';
import {
  type AppAccess,
  type AppViewer,
  assignTaskFromMap,
  readScreen,
  removeMember,
  resolveAppAccess,
  runAppAction,
  screenFor,
  updateApp,
} from '../store';
import { EQUIPO_EN_CAMPO } from '../templates';

/**
 * UBICACIÓN DEL EQUIPO Y TAREAS: consentimiento, tope de frecuencia, retención,
 * quién ve, asignación y «Mis tareas».
 *
 * Mismo fixture adverso de isolation.test.ts: dos empresas con una app y una
 * persona en turno cada una; si una consulta perdiera el filtro de empresa o de
 * app, devolvería algo plausible.
 */

const T0 = new Date('2026-10-08T15:00:00Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

const ORG = 'org-campo';
const OTRA = 'org-otra';
const ADMIN = '00000000-0000-4000-8000-0000000000a1';
const LUCIA = '00000000-0000-4000-8000-0000000000b1'; // coordinadora (miembro)
const MARIO = '00000000-0000-4000-8000-0000000000c1'; // terreno (miembro de Cortex)
const EXT = '00000000-0000-4000-8000-0000000000d1'; // terreno externo
const EXT2 = '00000000-0000-4000-8000-0000000000d2'; // otro terreno externo
const AJENO = '00000000-0000-4000-8000-0000000000e1'; // externo de la OTRA empresa
const OBS = '00000000-0000-4000-8000-0000000000f1'; // rol sin permisos de ubicación

const tareasFields = EQUIPO_EN_CAMPO.trackers[0]?.fields ?? [];

function seed(options: { enabled?: boolean } = {}) {
  const enabled = options.enabled ?? true;
  const app = (org: string, id: string) => ({
    id,
    organization_id: org,
    slug: 'campo',
    name: 'Equipo en campo',
    description: '',
    icon: '🗺️',
    theme: {},
    home_screen: 'mapa',
    location: { enabled, retentionDays: 30 },
    status: 'published',
    version: 1,
    created_by: null,
    updated_by: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    archived_at: null,
  });
  const tracker = (org: string, id: string) => ({
    id,
    organization_id: org,
    slug: 'tareas',
    name: 'Tareas',
    description: '',
    fields: tareasFields,
    duplicates: null,
    created_by: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
  });
  const screens = (org: string, appId: string, p: string) =>
    EQUIPO_EN_CAMPO.screens.map((s, i) => ({
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
    EQUIPO_EN_CAMPO.screens.map((s) => ({
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
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-01T00:00:00Z',
      archived_at: null,
    }));
  const roles = (org: string, appId: string) =>
    [
      ...EQUIPO_EN_CAMPO.roles,
      {
        key: 'observador',
        name: 'Observador',
        description: '',
        permissions: { tables: {}, export: false },
      },
    ].map((r, i) => ({
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
  const appUser = (org: string, appId: string, id: string, name: string, role: string) => ({
    id,
    organization_id: org,
    app_id: appId,
    name,
    email: `${name.toLowerCase()}@example.com`,
    role_key: role,
    attributes: {},
    status: 'active',
    last_seen_at: '2026-10-05T10:00:00Z',
  });
  return {
    trackers: [tracker(ORG, 'trk-campo'), tracker(OTRA, 'trk-otra')],
    tracker_rows: [
      {
        id: 'tk-ext',
        organization_id: ORG,
        tracker_id: 'trk-campo',
        label: 'Entregar caja',
        values: {
          titulo: 'Entregar caja',
          asignado: EXT,
          asignado_nombre: 'Elena',
          estado: 'Pendiente',
          lugar: '4.710989,-74.072092',
        },
        created_by: LUCIA,
        created_at: '2026-10-07T10:00:00Z',
        updated_at: '2026-10-07T10:00:00Z',
      },
      {
        id: 'tk-ext2',
        organization_id: ORG,
        tracker_id: 'trk-campo',
        label: 'Revisar bodega',
        values: {
          titulo: 'Revisar bodega',
          asignado: EXT2,
          asignado_nombre: 'Emilio',
          estado: 'En curso',
        },
        created_by: LUCIA,
        created_at: '2026-10-07T10:00:00Z',
        updated_at: '2026-10-07T10:00:00Z',
      },
    ],
    custom_apps: [app(ORG, 'app-campo'), app(OTRA, 'app-otra')],
    custom_app_screens: [...screens(ORG, 'app-campo', 'c'), ...screens(OTRA, 'app-otra', 'o')],
    custom_views: [...views(ORG, 'app-campo', 'c'), ...views(OTRA, 'app-otra', 'o')],
    custom_app_roles: [...roles(ORG, 'app-campo'), ...roles(OTRA, 'app-otra')],
    custom_app_members: [
      member(ORG, 'app-campo', LUCIA, 'coordinador'),
      member(ORG, 'app-campo', MARIO, 'terreno'),
      member(ORG, 'app-campo', OBS, 'observador'),
    ],
    custom_app_users: [
      appUser(ORG, 'app-campo', EXT, 'Elena', 'terreno'),
      appUser(ORG, 'app-campo', EXT2, 'Emilio', 'terreno'),
      appUser(OTRA, 'app-otra', AJENO, 'Aurelio', 'terreno'),
    ],
    users: [
      { id: LUCIA, organization_id: ORG, name: 'Lucía', email: 'lucia@example.com' },
      { id: MARIO, organization_id: ORG, name: 'Mario', email: 'mario@example.com' },
      { id: OBS, organization_id: ORG, name: 'Olga', email: 'olga@example.com' },
      { id: ADMIN, organization_id: ORG, name: 'Ana', email: 'ana@example.com' },
    ],
    custom_app_location_consents: [],
    custom_app_locations: [],
    custom_app_location_history: [],
  };
}

function world(options: { enabled?: boolean } = {}) {
  const fake = createFakeSupabase(seed(options));
  return {
    fake,
    db: createOrgScopedClient(fake.client, ORG),
    otra: createOrgScopedClient(fake.client, OTRA),
  };
}

const viewer = (id: string, companyAdmin = false): AppViewer => ({ id, name: id, companyAdmin });

async function member(db: ReturnType<typeof world>['db'], id: string, admin = false) {
  const access = await resolveAppAccess(db, 'campo', viewer(id, admin));
  if (!access) throw new Error(`${id} no entra`);
  return access;
}

async function external(
  db: ReturnType<typeof world>['db'],
  id: string,
  name: string,
  role = 'terreno',
) {
  const access = await resolveAppAccess(db, 'campo', viewer(ADMIN, true));
  if (!access) throw new Error('sin app');
  const user = { id, name, role_key: role, status: 'active', attributes: {} } as ExternalUserRow;
  const out = await externalAppAccess(db, access.app, user);
  if (!out) throw new Error('externo no entra');
  return out;
}

/** Una persona que acepta, abre turno y manda una posición. */
async function onShift(
  db: ReturnType<typeof world>['db'],
  access: AppAccess,
  lat = 4.71,
  lng = -74.07,
) {
  await acceptLocationConsent(db, access, T0);
  await startShift(db, access, T0);
  return recordPosition(db, access, { lat, lng, accuracy: 12 }, T0);
}

describe('ubicación: sin consentimiento no se guarda nada', () => {
  it('sin aceptar el texto, ni un turno abierto ni una posición', async () => {
    const { db, fake } = world();
    const elena = await external(db, EXT, 'Elena');
    expect(await recordPosition(db, elena, { lat: 4.7, lng: -74.07 }, T0)).toEqual({
      saved: false,
      reason: 'inactive',
    });
    await expect(startShift(db, elena, T0)).rejects.toThrow(/Primero acepta/);
    expect(fake.tables.custom_app_locations).toHaveLength(0);
    expect(fake.tables.custom_app_location_history).toHaveLength(0);
  });

  it('aceptar no abre el turno: sin turno tampoco se guarda', async () => {
    const { db, fake } = world();
    const elena = await external(db, EXT, 'Elena');
    await acceptLocationConsent(db, elena, T0);
    const status = await locationStatus(db, elena);
    expect(status.consented).toBe(true);
    expect(status.onShift).toBe(false);
    expect((await recordPosition(db, elena, { lat: 4.7, lng: -74.07 }, T0)).saved).toBe(false);
    expect(fake.tables.custom_app_locations).toHaveLength(0);
  });

  it('con consentimiento y turno, guarda su posición; queda la versión y la fecha del texto', async () => {
    const { db, fake } = world();
    const elena = await external(db, EXT, 'Elena');
    expect(await onShift(db, elena)).toEqual({ saved: true });
    const consent = fake.tables.custom_app_location_consents?.[0];
    expect(consent?.text_version).toBe(LOCATION_TEXT_VERSION);
    expect(consent?.accepted_at).toBe(T0.toISOString());
    expect(fake.tables.custom_app_locations).toHaveLength(1);
    expect(fake.tables.custom_app_locations?.[0]?.subject_id).toBe(EXT);
  });

  it('un texto de una versión anterior pide aceptar de nuevo', async () => {
    const { db, fake } = world();
    const elena = await external(db, EXT, 'Elena');
    await onShift(db, elena);
    const row = fake.tables.custom_app_location_consents?.[0];
    if (row) row.text_version = '2025-01-v0';
    const status = await locationStatus(db, elena);
    expect(status.consented).toBe(false);
    expect(status.consentOutdated).toBe(true);
    expect(status.onShift).toBe(false);
    expect((await recordPosition(db, elena, { lat: 4.7, lng: -74.07 }, at(60))).saved).toBe(false);
  });

  it('app apagada o rol sin permiso de compartir: no se acepta, no se abre turno', async () => {
    const off = world({ enabled: false });
    const elena = await external(off.db, EXT, 'Elena');
    await expect(acceptLocationConsent(off.db, elena, T0)).rejects.toThrow(/no comparte/);
    expect((await locationStatus(off.db, elena)).canShare).toBe(false);
    expect((await recordPosition(off.db, elena, { lat: 4.7, lng: -74.07 }, T0)).saved).toBe(false);

    const { db } = world();
    const olga = await member(db, OBS);
    await expect(acceptLocationConsent(db, olga, T0)).rejects.toThrow(/no comparte/);
    const lucia = await member(db, LUCIA);
    await expect(startShift(db, lucia, T0)).rejects.toThrow(/no comparte/);
  });

  it('un administrador de la empresa puede compartir (es una persona en terreno más)', async () => {
    const { db } = world();
    const admin = await member(db, ADMIN, true);
    expect(await onShift(db, admin, 4.6, -74.1)).toEqual({ saved: true });
  });
});

describe('ubicación: tope de frecuencia y validación', () => {
  it('una posición cada 15 s por persona: lo que llega antes se descarta sin error', async () => {
    const { db, fake } = world();
    const elena = await external(db, EXT, 'Elena');
    await onShift(db, elena);
    const early = await recordPosition(
      db,
      elena,
      { lat: 4.8, lng: -74.0 },
      at(MIN_PING_INTERVAL_SECONDS - 1),
    );
    expect(early).toEqual({ saved: false, reason: 'rate' });
    expect(fake.tables.custom_app_locations?.[0]?.lat).toBe(4.71);
    const ok = await recordPosition(
      db,
      elena,
      { lat: 4.8, lng: -74.0 },
      at(MIN_PING_INTERVAL_SECONDS),
    );
    expect(ok).toEqual({ saved: true });
    expect(fake.tables.custom_app_locations).toHaveLength(1);
    expect(fake.tables.custom_app_locations?.[0]?.lat).toBe(4.8);
  });

  it('el tope es por persona: otra persona manda a la vez', async () => {
    const { db, fake } = world();
    const elena = await external(db, EXT, 'Elena');
    const emilio = await external(db, EXT2, 'Emilio');
    await onShift(db, elena);
    expect(await onShift(db, emilio)).toEqual({ saved: true });
    expect(fake.tables.custom_app_locations).toHaveLength(2);
  });

  it('al historial va una muestra por minuto, no una por posición', async () => {
    const { db, fake } = world();
    const elena = await external(db, EXT, 'Elena');
    await onShift(db, elena);
    for (let s = 15; s <= HISTORY_INTERVAL_SECONDS - 15; s += 15)
      await recordPosition(db, elena, { lat: 4.72, lng: -74.07 }, at(s));
    expect(fake.tables.custom_app_location_history).toHaveLength(1);
    await recordPosition(db, elena, { lat: 4.73, lng: -74.07 }, at(HISTORY_INTERVAL_SECONDS));
    expect(fake.tables.custom_app_location_history).toHaveLength(2);
  });

  it('coordenadas imposibles no se guardan', () => {
    expect(parsePosition({ lat: 91, lng: 0.1 })).toBeNull();
    expect(parsePosition({ lat: 4, lng: 181 })).toBeNull();
    expect(parsePosition({ lat: Number.NaN, lng: 1 })).toBeNull();
    expect(parsePosition({ lat: 0, lng: 0 })).toBeNull();
    expect(parsePosition({ lat: 4, lng: -74, accuracy: 90_000 })).toBeNull();
    expect(parsePosition({ lat: '4.5', lng: '-74.5', battery: 50 })).toMatchObject({
      lat: 4.5,
      lng: -74.5,
      batteryPct: 50,
    });
    expect(parsePosition({ lat: 4, lng: -74, heading: 500, speed: -3 })).toMatchObject({
      heading: null,
      speedMps: null,
    });
  });

  it('un teléfono que miente no pisa lo guardado', async () => {
    const { db, fake } = world();
    const elena = await external(db, EXT, 'Elena');
    await onShift(db, elena);
    expect(await recordPosition(db, elena, { lat: 500, lng: 0.5 }, at(60))).toEqual({
      saved: false,
      reason: 'invalid',
    });
    expect(fake.tables.custom_app_locations?.[0]?.lat).toBe(4.71);
  });
});

describe('ubicación: apagar y borrar', () => {
  it('terminar el turno borra la posición actual pero no el rastro', async () => {
    const { db, fake } = world();
    const elena = await external(db, EXT, 'Elena');
    await onShift(db, elena);
    await endShift(db, elena, at(30));
    expect(fake.tables.custom_app_locations).toHaveLength(0);
    expect(fake.tables.custom_app_location_history).toHaveLength(1);
    expect((await locationStatus(db, elena)).onShift).toBe(false);
    expect((await recordPosition(db, elena, { lat: 4.7, lng: -74.07 }, at(60))).saved).toBe(false);
  });

  it('revocar borra posición y rastro, y obliga a aceptar de nuevo', async () => {
    const { db, fake } = world();
    const elena = await external(db, EXT, 'Elena');
    const emilio = await external(db, EXT2, 'Emilio');
    await onShift(db, elena);
    await onShift(db, emilio);
    await revokeLocation(db, elena, at(30));
    expect(fake.tables.custom_app_locations?.map((l) => l.subject_id)).toEqual([EXT2]);
    expect(fake.tables.custom_app_location_history?.map((l) => l.subject_id)).toEqual([EXT2]);
    const status = await locationStatus(db, elena);
    expect(status.consented).toBe(false);
    await expect(startShift(db, elena, at(40))).rejects.toThrow(/Primero acepta/);
    await acceptLocationConsent(db, elena, at(50));
    expect((await locationStatus(db, elena)).consented).toBe(true);
  });

  it('apagar la función en la app borra todas las posiciones y cierra los turnos', async () => {
    const { db, fake } = world();
    const elena = await external(db, EXT, 'Elena');
    await onShift(db, elena);
    const admin = await member(db, ADMIN, true);
    await updateApp(db, 'campo', { location: { enabled: false }, userId: ADMIN });
    expect(fake.tables.custom_app_locations).toHaveLength(0);
    expect(fake.tables.custom_app_location_consents?.[0]?.on_shift).toBe(false);
  });

  it('quitar a una persona de la app borra lo suyo', async () => {
    const { db, fake } = world();
    const mario = await member(db, MARIO);
    await onShift(db, mario);
    expect(fake.tables.custom_app_locations).toHaveLength(1);
    await removeMember(db, mario.app.id, MARIO);
    expect(fake.tables.custom_app_locations).toHaveLength(0);
    expect(fake.tables.custom_app_location_history).toHaveLength(0);
    expect(fake.tables.custom_app_location_consents).toHaveLength(0);
  });
});

describe('ubicación: retención', () => {
  it('el trabajo borra el historial más viejo que la retención y deja el reciente', async () => {
    const { db, fake } = world();
    const hist = (id: string, daysAgo: number, appId = 'app-campo') => ({
      id,
      organization_id: ORG,
      app_id: appId,
      subject_kind: 'app_user',
      subject_id: EXT,
      lat: 4.7,
      lng: -74.07,
      accuracy_m: 10,
      recorded_at: new Date(T0.getTime() - daysAgo * 86_400_000).toISOString(),
    });
    fake.tables.custom_app_location_history = [
      hist('h-vieja', 31),
      hist('h-justa', 29),
      hist('h-hoy', 0),
    ];
    const borradas = await purgeLocationHistory(db, 'app-campo', 30, T0);
    expect(borradas).toBe(1);
    expect(fake.tables.custom_app_location_history?.map((h) => h.id).sort()).toEqual([
      'h-hoy',
      'h-justa',
    ]);
    // Con una retención de 7 días se va también la de hace 29.
    await purgeLocationHistory(db, 'app-campo', 7, T0);
    expect(fake.tables.custom_app_location_history?.map((h) => h.id)).toEqual(['h-hoy']);
  });

  it('un turno que se quedó abierto se cierra solo y se borra su posición', async () => {
    const { db, fake } = world();
    const elena = await external(db, EXT, 'Elena');
    await onShift(db, elena);
    expect(await closeStaleShifts(db, 'app-campo', at(3600))).toBe(0);
    expect(fake.tables.custom_app_locations).toHaveLength(1);
    const cerrados = await closeStaleShifts(db, 'app-campo', at(17 * 3600));
    expect(cerrados).toBeGreaterThanOrEqual(1);
    expect(fake.tables.custom_app_locations).toHaveLength(0);
    expect(fake.tables.custom_app_location_consents?.[0]?.on_shift).toBe(false);
  });
});

describe('ubicación: quién ve a quién', () => {
  it('el coordinador ve a las personas en turno, con nombre, rol y hace cuánto', async () => {
    const { db } = world();
    await onShift(db, await external(db, EXT, 'Elena'));
    await onShift(db, await member(db, MARIO), 4.6, -74.1);
    const lucia = await member(db, LUCIA);
    const people = await listLivePeople(db, lucia, {}, at(120));
    expect(people.map((p) => p.name)).toEqual(['Elena', 'Mario']);
    expect(people[0]).toMatchObject({
      roleName: 'Persona en terreno',
      ageSeconds: 120,
      stale: false,
      onShift: true,
      self: false,
    });
    expect(people[0]?.ref).toBe(personRef('app_user', EXT));
    // Sin correos ni ids de sesión en lo que sale.
    expect(JSON.stringify(people)).not.toContain('@');
    // Pasado un rato sin señal se marca apagada.
    expect((await listLivePeople(db, lucia, {}, at(400)))[0]?.stale).toBe(true);
  });

  it('un admin de la empresa sin rol en la app aparece en el mapa como Administrador', async () => {
    const { db } = world();
    const admin = await member(db, ADMIN, true);
    expect((await onShift(db, admin)).saved).toBe(true);
    const people = await listLivePeople(db, admin, {}, at(10));
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({ roleName: 'Administrador', self: true });
    // Aunque el mapa filtre por otro rol, cada quien se ve a sí mismo.
    expect(await listLivePeople(db, admin, { roles: ['terreno'] }, at(10))).toHaveLength(1);
  });

  it('el filtro por rol funciona; quien terminó turno o revocó no aparece', async () => {
    const { db } = world();
    const elena = await external(db, EXT, 'Elena');
    const emilio = await external(db, EXT2, 'Emilio');
    await onShift(db, elena);
    await onShift(db, emilio);
    const lucia = await member(db, LUCIA);
    expect((await listLivePeople(db, lucia, { roles: ['coordinador'] }, at(10))).length).toBe(0);
    await endShift(db, elena, at(5));
    expect((await listLivePeople(db, lucia, {}, at(10))).map((p) => p.name)).toEqual(['Emilio']);
  });

  it('un usuario externo NUNCA ve la ubicación de otro si su rol no lo permite', async () => {
    const { db } = world();
    await onShift(db, await external(db, EXT, 'Elena'));
    const emilio = await external(db, EXT2, 'Emilio');
    await expect(listLivePeople(db, emilio, {}, at(10))).rejects.toThrow(/no ve la ubicación/);
    expect(canViewLocations(emilio.role)).toBe(false);
    const olga = await member(db, OBS);
    await expect(listLivePeople(db, olga, {}, at(10))).rejects.toThrow(/no ve la ubicación/);
    // Mario es de terreno: tampoco.
    await expect(listLivePeople(db, await member(db, MARIO), {}, at(10))).rejects.toThrow();
  });

  it('un externo con un rol que SÍ ve (dado por el editor) ve a los demás', async () => {
    const { db, fake } = world();
    await onShift(db, await external(db, EXT, 'Elena'));
    const role = fake.tables.custom_app_roles?.find(
      (r) => r.app_id === 'app-campo' && r.key === 'observador',
    );
    if (role) role.permissions = { tables: {}, export: false, location: { view: true } };
    const olga = await member(db, OBS);
    expect((await listLivePeople(db, olga, {}, at(10))).map((p) => p.name)).toEqual(['Elena']);
  });

  it('con la función apagada nadie ve nada, ni el administrador', async () => {
    const { db } = world({ enabled: false });
    const admin = await member(db, ADMIN, true);
    await expect(listLivePeople(db, admin, {}, T0)).rejects.toThrow(/no comparte/);
  });

  it('aislamiento: las personas de otra empresa y otra app no salen', async () => {
    const { db, otra, fake } = world();
    await onShift(db, await external(db, EXT, 'Elena'));
    // La otra empresa tiene a Aurelio en turno con posición propia.
    fake.tables.custom_app_location_consents?.push({
      id: 'c-ajeno',
      organization_id: OTRA,
      app_id: 'app-otra',
      subject_kind: 'app_user',
      subject_id: AJENO,
      text_version: LOCATION_TEXT_VERSION,
      on_shift: true,
      revoked_at: null,
      shift_started_at: T0.toISOString(),
    });
    fake.tables.custom_app_locations?.push({
      id: 'l-ajeno',
      organization_id: OTRA,
      app_id: 'app-otra',
      subject_kind: 'app_user',
      subject_id: AJENO,
      lat: 10,
      lng: -70,
      recorded_at: T0.toISOString(),
    });
    const lucia = await member(db, LUCIA);
    expect((await listLivePeople(db, lucia, {}, at(10))).map((p) => p.name)).toEqual(['Elena']);
    // Y la coordinadora de la otra empresa (mismo rol, misma app "campo") ve sólo a Aurelio.
    fake.tables.custom_app_members?.push({
      id: 'm-otra',
      organization_id: OTRA,
      app_id: 'app-otra',
      user_id: LUCIA,
      role_key: 'coordinador',
      attributes: {},
    });
    const otraAccess = await resolveAppAccess(otra, 'campo', viewer(LUCIA));
    if (!otraAccess) throw new Error('sin acceso');
    expect((await listLivePeople(otra, otraAccess, {}, at(10))).map((p) => p.name)).toEqual([
      'Aurelio',
    ]);
  });

  it('una persona desactivada deja de aparecer', async () => {
    const { db, fake } = world();
    await onShift(db, await external(db, EXT, 'Elena'));
    const row = fake.tables.custom_app_users?.find((u) => u.id === EXT);
    if (row) row.status = 'disabled';
    const lucia = await member(db, LUCIA);
    expect(await listLivePeople(db, lucia, {}, at(10))).toEqual([]);
  });
});

describe('mapa: la capa de personas llega sólo a quien puede verla', () => {
  async function mapOf(db: ReturnType<typeof world>['db'], access: AppAccess) {
    const screen = screenFor(access, 'mapa') ?? access.screens.find((s) => s.slug === 'mapa');
    if (!screen) throw new Error('sin pantalla');
    const { computed } = await readScreen(db, access, screen);
    const block = computed.blocks.find((b) => b.type === 'map');
    return block?.type === 'map' ? block : null;
  }

  it('el coordinador recibe la capa de personas y «Asignar»; los marcadores salen de la tabla', async () => {
    const { db } = world();
    const map = await mapOf(db, await member(db, LUCIA));
    expect(map?.people).toMatchObject({ pollSeconds: 20 });
    expect(map?.assign?.titleLabel).toBe('Tarea');
    expect(map?.markers.map((m) => m.id)).toEqual(['tk-ext']);
    expect(map?.withoutLocation).toBe(1);
    expect(map?.markers[0]).toMatchObject({ lat: 4.710989, lng: -74.072092, tag: 'Pendiente' });
  });

  it('un rol sin permiso de ver no recibe la capa (aunque forzara la lectura de la pantalla)', async () => {
    const { db } = world();
    const elena = await external(db, EXT, 'Elena');
    const screen = elena.screens.find((s) => s.slug === 'mapa');
    if (!screen) throw new Error('sin pantalla');
    // La pantalla no es de su rol (404 por la ruta), pero aun forzando la lectura:
    const { computed } = await readScreen(db, elena, screen);
    const block = computed.blocks.find((b) => b.type === 'map');
    expect(block?.type === 'map' ? block.people : 'sin bloque').toBeNull();
    expect(block?.type === 'map' ? block.assign : 'sin bloque').toBeNull();
    expect(screenFor(elena, 'mapa')).toBeNull();
  });

  it('una vista fuera de una app (enlace público) nunca trae personas ni asignación', async () => {
    const { db } = world();
    const lucia = await member(db, LUCIA);
    const screen = lucia.screens.find((s) => s.slug === 'mapa');
    if (!screen) throw new Error('sin pantalla');
    const { view, sources } = await readScreen(db, lucia, screen);
    const publico = computeView(view.spec, sources, T0, { writable: false, audience: 'public' });
    const block = publico.blocks.find((b) => b.type === 'map');
    expect(block?.type === 'map' ? block.people : 'sin bloque').toBeNull();
    expect(block?.type === 'map' ? block.assign : 'sin bloque').toBeNull();
    // Ni con una vista del equipo: sin `location`, no hay capa.
    const equipo = computeView(view.spec, sources, T0, { writable: true, audience: 'team' });
    const b2 = equipo.blocks.find((b) => b.type === 'map');
    expect(b2?.type === 'map' ? b2.people : 'sin bloque').toBeNull();
  });
});

describe('tareas: asignar con aviso y «Mis tareas»', () => {
  it('el coordinador asigna desde el mapa: nace la fila para esa persona, Pendiente', async () => {
    const { db, fake } = world();
    const lucia = await member(db, LUCIA);
    const screen = lucia.screens.find((s) => s.slug === 'mapa');
    if (!screen) throw new Error('sin pantalla');
    const { view } = await readScreen(db, lucia, screen);
    const out = await assignTaskFromMap(db, lucia, view, {
      blockId: 'mapa',
      person: { kind: 'app_user', id: EXT },
      title: 'Cambiar medidor',
      description: 'Calle 10 con 5',
      due: '2026-10-09',
      priority: 'Alta',
      location: '4.650000,-74.100000',
    });
    expect(out.person).toMatchObject({ id: EXT, name: 'Elena', email: 'elena@example.com' });
    expect(out.screen).toBe('mis_tareas');
    const row = fake.tables.tracker_rows?.find((r) => r.id === out.rowId);
    expect(row?.values).toMatchObject({
      titulo: 'Cambiar medidor',
      asignado: EXT,
      asignado_nombre: 'Elena',
      estado: 'Pendiente',
      prioridad: 'Alta',
      lugar: '4.650000,-74.100000',
      limite: '2026-10-09',
    });
    expect(row?.created_by).toBe(LUCIA);
    expect(row?.organization_id).toBe(ORG);
  });

  it('a un miembro de Cortex también; a alguien de otra app, de otra empresa o sin permiso, no', async () => {
    const { db } = world();
    const lucia = await member(db, LUCIA);
    const screen = lucia.screens.find((s) => s.slug === 'mapa');
    if (!screen) throw new Error('sin pantalla');
    const { view } = await readScreen(db, lucia, screen);
    const ok = await assignTaskFromMap(db, lucia, view, {
      blockId: 'mapa',
      person: { kind: 'member', id: MARIO },
      title: 'Visitar cliente',
    });
    expect(ok.person.kind).toBe('member');
    // Aurelio es de la otra empresa: no existe para esta app.
    await expect(
      assignTaskFromMap(db, lucia, view, {
        blockId: 'mapa',
        person: { kind: 'app_user', id: AJENO },
        title: 'X',
      }),
    ).rejects.toThrow(/no está en esta aplicación/);
    // Un id de miembro ajeno a la app tampoco.
    await expect(
      assignTaskFromMap(db, lucia, view, {
        blockId: 'mapa',
        person: { kind: 'member', id: ADMIN },
        title: 'X',
      }),
    ).rejects.toThrow(/no está en esta aplicación/);
    // Una persona en terreno no asigna.
    const elena = await external(db, EXT, 'Elena');
    await expect(
      assignTaskFromMap(db, elena, view, {
        blockId: 'mapa',
        person: { kind: 'app_user', id: EXT2 },
        title: 'X',
      }),
    ).rejects.toThrow(/no asigna tareas/);
    // Sin título no hay tarea.
    await expect(
      assignTaskFromMap(db, lucia, view, {
        blockId: 'mapa',
        person: { kind: 'app_user', id: EXT },
        title: '   ',
      }),
    ).rejects.toThrow(/Escribe qué hay que hacer/);
  });

  it('desde una lista: el botón «Asignar a…» cambia quién y el estado de una fila existente', async () => {
    const { db, fake } = world();
    const lucia = await member(db, LUCIA);
    const screen = lucia.screens.find((s) => s.slug === 'tareas');
    if (!screen) throw new Error('sin pantalla');
    const { view } = await readScreen(db, lucia, screen);
    const res = await runAppAction(db, lucia, view, {
      blockId: 'todas',
      actionId: 'asignar',
      rowId: 'tk-ext2',
      person: { kind: 'app_user', id: EXT },
    });
    expect(res.kind).toBe('assign');
    const row = fake.tables.tracker_rows?.find((r) => r.id === 'tk-ext2');
    expect(row?.values).toMatchObject({
      asignado: EXT,
      asignado_nombre: 'Elena',
      estado: 'Pendiente',
    });
    // Sin persona, sin asignación; con una persona que no es de la app, tampoco.
    await expect(
      runAppAction(db, lucia, view, { blockId: 'todas', actionId: 'asignar', rowId: 'tk-ext2' }),
    ).rejects.toThrow(/Elige a quién/);
    await expect(
      runAppAction(db, lucia, view, {
        blockId: 'todas',
        actionId: 'asignar',
        rowId: 'tk-ext2',
        person: { kind: 'app_user', id: AJENO },
      }),
    ).rejects.toThrow(/no está en esta aplicación/);
  });

  it('quién puede ser asignado: gente de la app, sin coordenadas, sólo para quien asigna', async () => {
    const { db } = world();
    const lucia = await member(db, LUCIA);
    const people = await listAssignablePeople(db, lucia);
    expect(people.map((p) => p.name)).toEqual(['Elena', 'Emilio', 'Lucía', 'Mario', 'Olga']);
    expect(JSON.stringify(people)).not.toMatch(/lat|lng/);
    const elena = await external(db, EXT, 'Elena');
    await expect(listAssignablePeople(db, elena)).rejects.toThrow(/no asigna tareas/);
  });

  it('«Mis tareas»: cada persona ve sólo las suyas (por su id), nunca las de otra', async () => {
    const { db } = world();
    const read = async (access: AppAccess) => {
      const screen = access.screens.find((s) => s.slug === 'mis_tareas');
      if (!screen) throw new Error('sin pantalla');
      return readScreen(db, access, screen);
    };
    const elena = await external(db, EXT, 'Elena');
    const emilio = await external(db, EXT2, 'Emilio');
    expect((await read(elena)).sources.get('tareas')?.rows.map((r) => r.id)).toEqual(['tk-ext']);
    expect((await read(emilio)).sources.get('tareas')?.rows.map((r) => r.id)).toEqual(['tk-ext2']);
    // Un miembro de Cortex con el mismo rol: su id no coincide con ninguna → nada.
    expect((await read(await member(db, MARIO))).sources.get('tareas')?.rows).toEqual([]);
    // El id sale de la sesión: un atributo con ese nombre no lo reemplaza.
    elena.user.attributes = { id: EXT2 };
    expect(rowAccessFor(elena.role, elena.user, 'tareas')).toEqual({
      kind: 'equals',
      field: 'asignado',
      value: EXT,
    });
    expect(USER_ID_ATTRIBUTE).toBe('id');
  });

  it('Empezar y Terminar: terminar exige foto y nota de cierre; empezar no escribe en filas ajenas', async () => {
    const { db, fake } = world();
    const elena = await external(db, EXT, 'Elena');
    const screen = elena.screens.find((s) => s.slug === 'mis_tareas');
    if (!screen) throw new Error('sin pantalla');
    const { view } = await readScreen(db, elena, screen);
    await runAppAction(db, elena, view, { blockId: 'lista', actionId: 'empezar', rowId: 'tk-ext' });
    expect(fake.tables.tracker_rows?.find((r) => r.id === 'tk-ext')?.values).toMatchObject({
      estado: 'En curso',
    });
    await expect(
      runAppAction(db, elena, view, { blockId: 'lista', actionId: 'terminar', rowId: 'tk-ext' }),
    ).rejects.toThrow(/Antes de «Terminar» completa: Foto de cierre, Nota de cierre/);
    // La tarea de Emilio no existe para Elena: ni empezarla.
    await expect(
      runAppAction(db, elena, view, { blockId: 'lista', actionId: 'empezar', rowId: 'tk-ext2' }),
    ).rejects.toThrow(/ya no está/);
    // Con foto y nota, termina.
    const row = fake.tables.tracker_rows?.find((r) => r.id === 'tk-ext');
    if (row)
      row.values = {
        ...(row.values as object),
        foto_cierre: JSON.stringify({
          url: '/f/x.jpg',
          name: 'x.jpg',
          mime: 'image/jpeg',
          size: 10,
        }),
        nota_cierre: 'Listo, firmó el cliente',
      };
    await runAppAction(db, elena, view, {
      blockId: 'lista',
      actionId: 'terminar',
      rowId: 'tk-ext',
    });
    expect(fake.tables.tracker_rows?.find((r) => r.id === 'tk-ext')?.values).toMatchObject({
      estado: 'Hecha',
    });
  });

  it('una persona en terreno no usa el botón de asignar aunque lo pida', async () => {
    const { db } = world();
    const lucia = await member(db, LUCIA);
    const screen = lucia.screens.find((s) => s.slug === 'tareas');
    if (!screen) throw new Error('sin pantalla');
    const { view } = await readScreen(db, lucia, screen);
    const elena = await external(db, EXT, 'Elena');
    await expect(
      runAppAction(db, elena, view, {
        blockId: 'todas',
        actionId: 'asignar',
        rowId: 'tk-ext',
        person: { kind: 'app_user', id: EXT2 },
      }),
    ).rejects.toThrow(/no asigna tareas/);
  });
});

describe('contrato: spec y texto', () => {
  it('el bloque de la plantilla se valida contra la tabla real', async () => {
    const block = findWriteBlock(
      EQUIPO_EN_CAMPO.screens[0]?.spec ?? ({ blocks: [] } as never),
      'mapa',
    );
    expect(block?.type).toBe('map');
  });

  it('el texto del consentimiento dice qué, quién, cuánto y cómo apagarlo', () => {
    const text = consentText({
      appName: 'Campo',
      retentionDays: 30,
      viewerRoleNames: ['Coordinador'],
    });
    const all = text.points.map((p) => `${p.title}: ${p.body}`).join('\n');
    expect(text.version).toBe(LOCATION_TEXT_VERSION);
    expect(all).toMatch(/Qué se comparte/);
    expect(all).toMatch(/Coordinador y quienes administran la empresa/);
    expect(all).toMatch(/30 días/);
    expect(all).toMatch(/Terminar turno/);
    expect(all).toMatch(/Dejar de compartir/);
    expect(text.footer).toMatch(/Ley 1581/);
  });

  it('las referencias de persona se validan', () => {
    expect(parsePersonRef(personRef('member', MARIO))).toEqual({ kind: 'member', id: MARIO });
    expect(parsePersonRef('m:no-es-uuid')).toBeNull();
    expect(parsePersonRef(`x:${MARIO}`)).toBeNull();
    expect(parsePersonRef(null)).toBeNull();
  });
});
