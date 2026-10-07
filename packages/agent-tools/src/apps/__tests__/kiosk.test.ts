import { describe, expect, it } from 'vitest';
import { createFakeSupabase } from '../../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../tenancy/scoped-client';
import {
  externalAppAccess,
  hashSessionToken,
  inviteAppUser,
  resolveExternalSession,
  revokeSessionByToken,
  setAppUserStatus,
} from '../external';
import {
  KIOSK_SESSION_HOURS,
  MAX_PIN_ATTEMPTS,
  PAIRING_TTL_MINUTES,
  PIN_LOCK_MINUTES,
  changeOwnPin,
  claimPairing,
  clearUserPin,
  createPairing,
  enrollDevice,
  getKioskSettings,
  hashPin,
  listDevices,
  listKioskPeople,
  listPinStates,
  pinLogin,
  pinProblem,
  resolveDevice,
  revokeDevice,
  setKioskSettings,
  setUserPin,
  verifyPinHash,
} from '../kiosk';
import { getApp, readScreen, screenFor } from '../store';
import { CONTROL_EN_PLANTA } from '../templates';

/**
 * MODO KIOSCO: PIN, BLOQUEO, DISPOSITIVO REVOCADO E INACTIVIDAD (0211).
 *
 * Lo que se prueba es lo que protege a la gente de planta cuando varias
 * personas comparten un celular: el PIN sólo vale en un dispositivo autorizado,
 * se bloquea a los 5 fallos (aun con el PIN bueno), revocar el dispositivo corta
 * las sesiones, la sesión se cierra sola por inactividad, y una persona nunca
 * ve las filas «own» de otra en el mismo aparato.
 */

const ORG = 'org-postal';
const APP_ID = '11111111-1111-4111-8111-111111111111';
const SECRET = 'llave-de-prueba';
const T0 = new Date('2026-10-07T10:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const MIN = 60_000;

function world() {
  const base = { created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' };
  const row = (id: string, by: string, numero: string) => ({
    id,
    organization_id: ORG,
    tracker_id: 'trk',
    label: numero,
    values: { numero_guia: numero, fecha: '2026-10-05', estado: 'Pendiente' },
    created_by: null,
    created_by_app_user: by,
    ...base,
  });
  const fake = createFakeSupabase({
    custom_apps: [
      {
        id: APP_ID,
        organization_id: ORG,
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
        kiosk_enabled: true,
        kiosk_idle_minutes: 5,
        ...base,
        archived_at: null,
      },
    ],
    custom_app_roles: CONTROL_EN_PLANTA.roles.map((r, i) => ({
      id: `role-${r.key}`,
      organization_id: ORG,
      app_id: APP_ID,
      key: r.key,
      name: r.name,
      description: r.description,
      permissions: r.permissions,
      position: i,
    })),
    custom_app_screens: CONTROL_EN_PLANTA.screens.map((s, i) => ({
      id: `scr-${s.slug}`,
      organization_id: ORG,
      app_id: APP_ID,
      view_id: `view-${s.slug}`,
      slug: s.slug,
      title: s.title,
      icon: s.icon,
      position: i,
      roles: s.roles,
    })),
    custom_views: CONTROL_EN_PLANTA.screens.map((s) => ({
      id: `view-${s.slug}`,
      organization_id: ORG,
      slug: `planta_${s.slug}`,
      name: s.title,
      description: '',
      spec: s.spec,
      version: 1,
      visibility: 'workspace',
      share_token: null,
      share_expires_at: null,
      share_views: 0,
      pinned: false,
      app_id: APP_ID,
      created_by: null,
      updated_by: null,
      ...base,
      archived_at: null,
    })),
    trackers: [
      {
        id: 'trk',
        organization_id: ORG,
        slug: 'guias',
        name: 'Guías',
        description: '',
        fields: CONTROL_EN_PLANTA.trackers[0]?.fields ?? [],
        duplicates: null,
        created_by: null,
        ...base,
      },
    ],
    tracker_rows: [] as Array<Record<string, unknown>>,
    custom_app_users: [],
    custom_app_sessions: [],
    custom_app_login_codes: [],
    custom_app_devices: [],
  });
  return { fake, db: createOrgScopedClient(fake.client, ORG) };
}

type World = ReturnType<typeof world>;
const APP = { id: APP_ID };

async function person(w: World, name: string, pin?: string, roleKey = 'operario') {
  const { user } = await inviteAppUser(
    w.db,
    APP_ID,
    { name, email: `${name.toLowerCase()}@planta.co`, roleKey },
    'admin',
  );
  // Un usuario invitado pasa a activo al entrar por primera vez.
  await w.db
    .from('custom_app_users')
    .update({ status: 'active', last_seen_at: '2026-10-05T00:00:00Z' })
    .eq('id', user.id);
  if (pin) await setUserPin(w.db, APP_ID, user.id, pin, { secret: SECRET });
  return user;
}

async function device(w: World, now = T0) {
  const { device: d, token } = await enrollDevice(w.db, APP, {
    name: 'Muelle 3',
    by: 'admin',
    kind: 'member',
  });
  return { d, token, now };
}

describe('PIN: forma y hash', () => {
  it('4 a 6 números; rechaza los triviales', () => {
    expect(pinProblem('4829')).toBeNull();
    expect(pinProblem('482915')).toBeNull();
    expect(pinProblem('123')).toMatch(/4 a 6/);
    expect(pinProblem('1234567')).toMatch(/4 a 6/);
    expect(pinProblem('12ab')).toMatch(/4 a 6/);
    expect(pinProblem('0000')).toMatch(/fácil/);
    expect(pinProblem('1234')).toMatch(/fácil/);
    expect(pinProblem('9876')).toMatch(/fácil/);
  });

  it('guarda sólo un hash con sal: no es el PIN, cambia con la sal y verifica', () => {
    const a = hashPin(SECRET, 'u1', '4829');
    const b = hashPin(SECRET, 'u1', '4829');
    expect(a).not.toContain('4829');
    expect(a).not.toBe(b);
    expect(verifyPinHash(SECRET, 'u1', '4829', a)).toBe(true);
    expect(verifyPinHash(SECRET, 'u1', '4830', a)).toBe(false);
    // Otra persona o otra llave del servidor no valen con el mismo hash.
    expect(verifyPinHash(SECRET, 'u2', '4829', a)).toBe(false);
    expect(verifyPinHash('otra-llave', 'u1', '4829', a)).toBe(false);
    expect(verifyPinHash(SECRET, 'u1', '4829', null)).toBe(false);
  });

  it('en la base queda sólo el hash', async () => {
    const w = world();
    const ana = await person(w, 'Ana', '4829');
    const row = w.fake.tables.custom_app_users?.find((u) => u.id === ana.id);
    expect(JSON.stringify(row)).not.toContain('4829');
    expect(String(row?.pin_hash)).toMatch(/^s1\$/);
  });
});

describe('dispositivo: emparejar, revocar', () => {
  it('sin el kiosco encendido no se deja un dispositivo', async () => {
    const w = world();
    await setKioskSettings(w.db, APP_ID, { enabled: false });
    await expect(enrollDevice(w.db, APP, { name: 'X', by: 'a', kind: 'member' })).rejects.toThrow(
      /Activa el modo kiosco/,
    );
    await expect(createPairing(w.db, APP, { name: 'X', by: 'a' })).rejects.toThrow(/Activa/);
  });

  it('el token sólo se guarda en hash y el dispositivo se reconoce con él', async () => {
    const w = world();
    const { d, token } = await device(w);
    const stored = w.fake.tables.custom_app_devices?.[0];
    expect(stored?.token_hash).toBe(hashSessionToken(token));
    expect(JSON.stringify(stored)).not.toContain(token);
    expect((await resolveDevice(w.db, APP, token))?.id).toBe(d.id);
    expect(await resolveDevice(w.db, APP, 'x'.repeat(43))).toBeNull();
    expect(await resolveDevice(w.db, APP, null)).toBeNull();
  });

  it('el enlace de emparejamiento sirve una vez, vence a los 15 minutos y no sirve en otra app', async () => {
    const w = world();
    const { code, device: pending } = await createPairing(w.db, APP, {
      name: 'Muelle 5',
      by: 'admin',
      now: T0,
    });
    expect(pending.state).toBe('pending');
    // Sin reclamar, el dispositivo todavía no resuelve nada.
    expect((await listDevices(w.db, APP_ID))[0]?.state).toBe('pending');
    const claimed = await claimPairing(w.db, APP, code, { now: at(MIN) });
    expect(claimed?.device.state).toBe('active');
    expect((await resolveDevice(w.db, APP, claimed?.token))?.name).toBe('Muelle 5');
    // Segundo uso: nada.
    expect(await claimPairing(w.db, APP, code, { now: at(2 * MIN) })).toBeNull();
    // Uno que vence.
    const late = await createPairing(w.db, APP, { name: 'Muelle 6', by: 'admin', now: T0 });
    expect(
      await claimPairing(w.db, APP, late.code, { now: at((PAIRING_TTL_MINUTES + 1) * MIN) }),
    ).toBeNull();
    // Código inventado o de otra app.
    expect(await claimPairing(w.db, APP, 'a'.repeat(30))).toBeNull();
    expect(await claimPairing(w.db, { id: 'otra-app' }, late.code)).toBeNull();
  });

  it('un dispositivo revocado deja de valer y corta las sesiones abiertas en él', async () => {
    const w = world();
    const ana = await person(w, 'Ana', '4829');
    const { d, token } = await device(w);
    const login = await pinLogin(w.db, APP, token, ana.id, '4829', { secret: SECRET, now: T0 });
    if (!login.ok) throw new Error('debía entrar');
    expect(await resolveExternalSession(w.db, APP, login.token, { now: at(MIN) })).not.toBeNull();
    await revokeDevice(w.db, APP_ID, d.id);
    expect(await resolveDevice(w.db, APP, token)).toBeNull();
    expect(await resolveExternalSession(w.db, APP, login.token, { now: at(2 * MIN) })).toBeNull();
    // Ya no entra nadie con PIN, ni con el PIN bueno.
    expect(
      await pinLogin(w.db, APP, token, ana.id, '4829', { secret: SECRET, now: at(3 * MIN) }),
    ).toEqual({ ok: false, reason: 'invalid' });
    await expect(revokeDevice(w.db, APP_ID, d.id)).rejects.toThrow(/ya no está/);
  });

  it('apagar el kiosco corta las sesiones de dispositivo y el PIN deja de servir', async () => {
    const w = world();
    const ana = await person(w, 'Ana', '4829');
    const { token } = await device(w);
    const login = await pinLogin(w.db, APP, token, ana.id, '4829', { secret: SECRET, now: T0 });
    if (!login.ok) throw new Error('debía entrar');
    await setKioskSettings(w.db, APP_ID, { enabled: false });
    expect(await resolveExternalSession(w.db, APP, login.token, { now: at(MIN) })).toBeNull();
    expect(
      await pinLogin(w.db, APP, token, ana.id, '4829', { secret: SECRET, now: at(MIN) }),
    ).toEqual({ ok: false, reason: 'invalid' });
  });

  it('los minutos sin uso se acotan', async () => {
    const w = world();
    await expect(setKioskSettings(w.db, APP_ID, { idleMinutes: 0 })).rejects.toThrow(/1 a 120/);
    await expect(setKioskSettings(w.db, APP_ID, { idleMinutes: 500 })).rejects.toThrow(/1 a 120/);
    expect((await setKioskSettings(w.db, APP_ID, { idleMinutes: 12 })).idleMinutes).toBe(12);
    expect((await getKioskSettings(w.db, APP_ID)).enabled).toBe(true);
  });
});

describe('PIN: entrar, equivocarse y bloqueo', () => {
  it('el PIN bueno en un dispositivo autorizado abre una sesión atada a ese dispositivo', async () => {
    const w = world();
    const ana = await person(w, 'Ana', '4829');
    const { d, token } = await device(w);
    const login = await pinLogin(w.db, APP, token, ana.id, '4829', { secret: SECRET, now: T0 });
    expect(login.ok).toBe(true);
    if (!login.ok) return;
    expect(login.idleMinutes).toBe(5);
    const session = w.fake.tables.custom_app_sessions?.[0];
    expect(session?.device_id).toBe(d.id);
    expect(session?.idle_minutes).toBe(5);
    expect(session?.token_hash).toBe(hashSessionToken(login.token));
    const resolved = await resolveExternalSession(w.db, APP, login.token, { now: at(MIN) });
    expect(resolved?.user.id).toBe(ana.id);
    expect(resolved?.deviceId).toBe(d.id);
    // Tope de turno: la sesión vence aunque la usen sin parar.
    expect(new Date(login.expiresAt).getTime()).toBe(
      T0.getTime() + KIOSK_SESSION_HOURS * 3_600_000,
    );
  });

  it('sin dispositivo autorizado el PIN no vale, ni con el PIN bueno (un navegador cualquiera no entra)', async () => {
    const w = world();
    const ana = await person(w, 'Ana', '4829');
    expect(
      await pinLogin(w.db, APP, 'z'.repeat(43), ana.id, '4829', { secret: SECRET, now: T0 }),
    ).toEqual({ ok: false, reason: 'invalid' });
    expect(await pinLogin(w.db, APP, null, ana.id, '4829', { secret: SECRET, now: T0 })).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(w.fake.tables.custom_app_sessions?.length).toBe(0);
  });

  it('PIN incorrecto: cuenta intentos y avisa cuántos quedan; el bueno los reinicia', async () => {
    const w = world();
    const ana = await person(w, 'Ana', '4829');
    const { token } = await device(w);
    const bad = await pinLogin(w.db, APP, token, ana.id, '1111', { secret: SECRET, now: T0 });
    expect(bad).toEqual({ ok: false, reason: 'invalid', attemptsLeft: MAX_PIN_ATTEMPTS - 1 });
    const bad2 = await pinLogin(w.db, APP, token, ana.id, '2222', { secret: SECRET, now: T0 });
    expect(bad2).toEqual({ ok: false, reason: 'invalid', attemptsLeft: MAX_PIN_ATTEMPTS - 2 });
    expect(
      (await pinLogin(w.db, APP, token, ana.id, '4829', { secret: SECRET, now: at(MIN) })).ok,
    ).toBe(true);
    const row = w.fake.tables.custom_app_users?.find((u) => u.id === ana.id);
    expect(row?.pin_attempts).toBe(0);
  });

  it('a los 5 intentos fallidos se bloquea, y el PIN bueno tampoco entra mientras dure', async () => {
    const w = world();
    const ana = await person(w, 'Ana', '4829');
    const { token } = await device(w);
    let last: Awaited<ReturnType<typeof pinLogin>> | null = null;
    for (let i = 0; i < MAX_PIN_ATTEMPTS; i++)
      last = await pinLogin(w.db, APP, token, ana.id, '1111', { secret: SECRET, now: T0 });
    expect(last).toMatchObject({ ok: false, reason: 'locked' });
    // El PIN bueno, bloqueada: no entra.
    expect(
      await pinLogin(w.db, APP, token, ana.id, '4829', { secret: SECRET, now: at(MIN) }),
    ).toMatchObject({ ok: false, reason: 'locked' });
    expect(
      (await listPinStates(w.db, APP_ID, { now: at(MIN) })).find((p) => p.userId === ana.id)
        ?.lockedUntil,
    ).toBeTruthy();
    // Otro celular kiosco tampoco la deja pasar: el contador es de la persona.
    const second = await device(w);
    expect(
      await pinLogin(w.db, APP, second.token, ana.id, '4829', { secret: SECRET, now: at(2 * MIN) }),
    ).toMatchObject({ ok: false, reason: 'locked' });
    // Pasado el bloqueo vuelve a entrar con el bueno.
    const after = await pinLogin(w.db, APP, token, ana.id, '4829', {
      secret: SECRET,
      now: at((PIN_LOCK_MINUTES + 1) * MIN),
    });
    expect(after.ok).toBe(true);
    expect(w.fake.tables.custom_app_sessions?.length).toBe(1);
  });

  it('bloquear a una persona no bloquea a otra', async () => {
    const w = world();
    const ana = await person(w, 'Ana', '4829');
    const beto = await person(w, 'Beto', '7351');
    const { token } = await device(w);
    for (let i = 0; i < MAX_PIN_ATTEMPTS; i++)
      await pinLogin(w.db, APP, token, ana.id, '1111', { secret: SECRET, now: T0 });
    expect(
      (await pinLogin(w.db, APP, token, beto.id, '7351', { secret: SECRET, now: at(MIN) })).ok,
    ).toBe(true);
  });

  it('el PIN de otra persona no abre la sesión de Ana', async () => {
    const w = world();
    const ana = await person(w, 'Ana', '4829');
    await person(w, 'Beto', '7351');
    const { token } = await device(w);
    expect(
      await pinLogin(w.db, APP, token, ana.id, '7351', { secret: SECRET, now: T0 }),
    ).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('un usuario desactivado o sin PIN no entra; reasignar el PIN destraba', async () => {
    const w = world();
    const ana = await person(w, 'Ana', '4829');
    const sinpin = await person(w, 'Sin');
    const { token } = await device(w);
    expect(
      await pinLogin(w.db, APP, token, sinpin.id, '4829', { secret: SECRET, now: T0 }),
    ).toEqual({ ok: false, reason: 'invalid' });
    await setAppUserStatus(w.db, APP_ID, ana.id, 'disabled');
    expect(await pinLogin(w.db, APP, token, ana.id, '4829', { secret: SECRET, now: T0 })).toEqual({
      ok: false,
      reason: 'invalid',
    });
    await setAppUserStatus(w.db, APP_ID, ana.id, 'active');
    for (let i = 0; i < MAX_PIN_ATTEMPTS; i++)
      await pinLogin(w.db, APP, token, ana.id, '1111', { secret: SECRET, now: T0 });
    await setUserPin(w.db, APP_ID, ana.id, '5927', { secret: SECRET, now: at(MIN) });
    expect(
      (await pinLogin(w.db, APP, token, ana.id, '5927', { secret: SECRET, now: at(MIN) })).ok,
    ).toBe(true);
  });

  it('un PIN trivial no se puede asignar', async () => {
    const w = world();
    const ana = await person(w, 'Ana');
    await expect(setUserPin(w.db, APP_ID, ana.id, '0000', { secret: SECRET })).rejects.toThrow(
      /fácil/,
    );
  });

  it('la lista del kiosco: sólo activos con PIN, y sólo nombres', async () => {
    const w = world();
    await person(w, 'Ana', '4829');
    await person(w, 'Beto', '7351');
    await person(w, 'Sin');
    const off = await person(w, 'Off', '5927');
    await setAppUserStatus(w.db, APP_ID, off.id, 'disabled');
    const people = await listKioskPeople(w.db, APP_ID);
    expect(people.map((p) => p.name)).toEqual(['Ana', 'Beto']);
    expect(Object.keys(people[0] ?? {}).sort()).toEqual(['id', 'name']);
  });
});

describe('cambiar el PIN', () => {
  it('en un kiosco pide el PIN actual y los fallos cuentan para el bloqueo', async () => {
    const w = world();
    const ana = await person(w, 'Ana', '4829');
    const bad = await changeOwnPin(
      w.db,
      APP_ID,
      ana.id,
      { current: '1111', next: '5927', viaDevice: true },
      { secret: SECRET, now: T0 },
    );
    expect(bad).toMatchObject({ ok: false, reason: 'wrong' });
    expect(w.fake.tables.custom_app_users?.find((u) => u.id === ana.id)?.pin_attempts).toBe(1);
    const ok = await changeOwnPin(
      w.db,
      APP_ID,
      ana.id,
      { current: '4829', next: '5927', viaDevice: true },
      { secret: SECRET, now: T0 },
    );
    expect(ok).toEqual({ ok: true });
    const { token } = await device(w);
    expect((await pinLogin(w.db, APP, token, ana.id, '5927', { secret: SECRET, now: T0 })).ok).toBe(
      true,
    );
    expect((await pinLogin(w.db, APP, token, ana.id, '4829', { secret: SECRET, now: T0 })).ok).toBe(
      false,
    );
  });

  it('quien entró por correo lo fija sin saber el anterior; uno débil se rechaza', async () => {
    const w = world();
    const ana = await person(w, 'Ana');
    expect(
      await changeOwnPin(
        w.db,
        APP_ID,
        ana.id,
        { next: '4829', viaDevice: false },
        { secret: SECRET },
      ),
    ).toEqual({ ok: true });
    expect(
      await changeOwnPin(
        w.db,
        APP_ID,
        ana.id,
        { next: '1234', viaDevice: false },
        { secret: SECRET },
      ),
    ).toMatchObject({ ok: false, reason: 'weak' });
  });

  it('quitar el PIN cierra sus sesiones de kiosco y la saca de la lista', async () => {
    const w = world();
    const ana = await person(w, 'Ana', '4829');
    const { token } = await device(w);
    const login = await pinLogin(w.db, APP, token, ana.id, '4829', { secret: SECRET, now: T0 });
    if (!login.ok) throw new Error('debía entrar');
    await clearUserPin(w.db, APP_ID, ana.id);
    expect(await resolveExternalSession(w.db, APP, login.token, { now: at(MIN) })).toBeNull();
    expect(await listKioskPeople(w.db, APP_ID)).toEqual([]);
  });
});

describe('inactividad', () => {
  it('se cierra sola a los N minutos sin uso: queda revocada, no sólo ignorada', async () => {
    const w = world();
    const ana = await person(w, 'Ana', '4829');
    const { token } = await device(w);
    const login = await pinLogin(w.db, APP, token, ana.id, '4829', { secret: SECRET, now: T0 });
    if (!login.ok) throw new Error('debía entrar');
    // Cuatro minutos después, todavía.
    expect(
      await resolveExternalSession(w.db, APP, login.token, { now: at(4 * MIN) }),
    ).not.toBeNull();
    // Esa petición cuenta como uso: otros cuatro minutos después sigue viva (8 desde el inicio).
    expect(
      await resolveExternalSession(w.db, APP, login.token, { now: at(8 * MIN) }),
    ).not.toBeNull();
    // Cinco minutos sin peticiones: fuera.
    expect(await resolveExternalSession(w.db, APP, login.token, { now: at(13 * MIN) })).toBeNull();
    expect(w.fake.tables.custom_app_sessions?.[0]?.revoked_at).toBeTruthy();
    // Y ya no resucita aunque alguien vuelva a pedir.
    expect(
      await resolveExternalSession(w.db, APP, login.token, { now: at(13 * MIN + 1000) }),
    ).toBeNull();
  });

  it('respeta los minutos configurados en la app', async () => {
    const w = world();
    await setKioskSettings(w.db, APP_ID, { idleMinutes: 1 });
    const ana = await person(w, 'Ana', '4829');
    const { token } = await device(w);
    const login = await pinLogin(w.db, APP, token, ana.id, '4829', { secret: SECRET, now: T0 });
    if (!login.ok) throw new Error('debía entrar');
    expect(login.idleMinutes).toBe(1);
    expect(await resolveExternalSession(w.db, APP, login.token, { now: at(2 * MIN) })).toBeNull();
  });

  it('cerrar sesión a mano y desactivar a la persona también la sacan', async () => {
    const w = world();
    const ana = await person(w, 'Ana', '4829');
    const { token } = await device(w);
    const a = await pinLogin(w.db, APP, token, ana.id, '4829', { secret: SECRET, now: T0 });
    if (!a.ok) throw new Error('debía entrar');
    await revokeSessionByToken(w.db, APP, a.token);
    expect(await resolveExternalSession(w.db, APP, a.token, { now: at(MIN) })).toBeNull();
    const b = await pinLogin(w.db, APP, token, ana.id, '4829', { secret: SECRET, now: at(MIN) });
    if (!b.ok) throw new Error('debía entrar');
    await setAppUserStatus(w.db, APP_ID, ana.id, 'disabled');
    expect(await resolveExternalSession(w.db, APP, b.token, { now: at(2 * MIN) })).toBeNull();
  });
});

describe('un mismo dispositivo, dos personas: nadie ve lo «own» de otro', () => {
  it('cada PIN abre SU sesión, y SU lectura trae sólo SUS filas', async () => {
    const w = world();
    const ana = await person(w, 'Ana', '4829');
    const beto = await person(w, 'Beto', '7351');
    const rows = w.fake.tables.tracker_rows as Array<Record<string, unknown>>;
    const mk = (id: string, by: string, numero: string) => ({
      id,
      organization_id: ORG,
      tracker_id: 'trk',
      label: numero,
      values: { numero_guia: numero, fecha: '2026-10-05', estado: 'Pendiente' },
      created_by: null,
      created_by_app_user: by,
      created_at: '2026-10-05T10:00:00Z',
      updated_at: '2026-10-05T10:00:00Z',
    });
    rows.push(mk('r-ana', ana.id, '111-001'), mk('r-beto', beto.id, '222-002'));
    const { token } = await device(w);
    const app = await getApp(w.db, APP_ID);
    if (!app) throw new Error('sin app');

    const readAs = async (loginToken: string, now: Date) => {
      const session = await resolveExternalSession(w.db, APP, loginToken, { now });
      if (!session) throw new Error('sin sesión');
      const access = await externalAppAccess(w.db, app, session.user);
      const screen = access ? screenFor(access, 'mis_registros') : null;
      if (!access || !screen) throw new Error('sin pantalla');
      const read = await readScreen(w.db, access, screen);
      return read.sources.get('guias')?.rows.map((r) => r.id) ?? [];
    };

    const a = await pinLogin(w.db, APP, token, ana.id, '4829', { secret: SECRET, now: T0 });
    if (!a.ok) throw new Error('Ana debía entrar');
    expect(await readAs(a.token, at(MIN))).toEqual(['r-ana']);

    // Ana se va (o se le acaba el tiempo) y entra Beto en el mismo celular.
    await revokeSessionByToken(w.db, APP, a.token);
    const b = await pinLogin(w.db, APP, token, beto.id, '7351', {
      secret: SECRET,
      now: at(2 * MIN),
    });
    if (!b.ok) throw new Error('Beto debía entrar');
    expect(await readAs(b.token, at(3 * MIN))).toEqual(['r-beto']);

    // Con el token de Ana ya no se lee nada, ni lo de ella ni lo de él.
    await expect(readAs(a.token, at(3 * MIN))).rejects.toThrow(/sin sesión/);
    // Y el PIN de Beto no abre la sesión de Ana en ese celular.
    expect(
      await pinLogin(w.db, APP, token, ana.id, '7351', { secret: SECRET, now: at(4 * MIN) }),
    ).toMatchObject({ ok: false });
  });
});
