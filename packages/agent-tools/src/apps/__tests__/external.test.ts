import { describe, expect, it } from 'vitest';
import { createFakeSupabase } from '../../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../tenancy/scoped-client';
import {
  CODES_PER_HOUR,
  MAX_CODE_ATTEMPTS,
  appUserInputSchema,
  cleanCode,
  deviceLabel,
  externalAppAccess,
  findPublishedApp,
  generateLoginCode,
  hashLoginCode,
  hashSessionToken,
  importAppUsers,
  inviteAppUser,
  listAppUsers,
  parseUsersCsv,
  requestLoginCode,
  resolveExternalSession,
  revokeSessionByToken,
  revokeUserSessions,
  setAppUserStatus,
  verifyLoginCode,
} from '../external';
import { getApp } from '../store';
import { CONTROL_EN_PLANTA } from '../templates';

/**
 * LA ENTRADA DE UN USUARIO EXTERNO: código, sesión y desactivación (0209).
 *
 * Se prueba con el cliente acotado real y una base de mentira. Lo que importa:
 * el código vence, se bloquea a los 5 intentos y no dice si el correo existe;
 * la sesión guarda sólo el hash, vence, se revoca, y un usuario desactivado
 * queda fuera en la SIGUIENTE petición (no cuando venza la sesión).
 */

const ORG = 'org-postal';
const OTRA = 'org-aduanas';
const SECRET = 'llave-de-prueba';
const T0 = new Date('2026-10-07T10:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

function world() {
  const role = (
    org: string,
    appId: string,
    r: (typeof CONTROL_EN_PLANTA.roles)[number],
    i: number,
  ) => ({
    id: `${appId}-role-${r.key}`,
    organization_id: org,
    app_id: appId,
    key: r.key,
    name: r.name,
    description: r.description,
    permissions: r.permissions,
    position: i,
  });
  const app = (org: string, id: string, status = 'published') => ({
    id,
    organization_id: org,
    slug: 'planta',
    name: 'Control en planta',
    description: '',
    icon: '🏭',
    theme: {},
    home_screen: null,
    status,
    version: 1,
    created_by: null,
    updated_by: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    archived_at: null,
  });
  const fake = createFakeSupabase({
    custom_apps: [
      app(ORG, '11111111-1111-4111-8111-111111111111'),
      app(OTRA, '22222222-2222-4222-8222-222222222222'),
      app(ORG, '33333333-3333-4333-8333-333333333333', 'draft'),
    ],
    custom_app_roles: [
      ...CONTROL_EN_PLANTA.roles.map((r, i) =>
        role(ORG, '11111111-1111-4111-8111-111111111111', r, i),
      ),
      ...CONTROL_EN_PLANTA.roles.map((r, i) =>
        role(OTRA, '22222222-2222-4222-8222-222222222222', r, i),
      ),
    ],
    custom_app_screens: [],
    custom_app_users: [],
    custom_app_sessions: [],
    custom_app_login_codes: [],
  });
  return {
    fake,
    db: createOrgScopedClient(fake.client, ORG),
    otra: createOrgScopedClient(fake.client, OTRA),
  };
}

const APP = { id: '11111111-1111-4111-8111-111111111111' };

async function invited(db: ReturnType<typeof world>['db'], email = 'ana@empresa.com') {
  const { user } = await inviteAppUser(
    db,
    APP.id,
    { name: 'Ana', email, roleKey: 'operario' },
    'u-admin',
  );
  return user;
}

describe('usuarios externos: invitar', () => {
  it('normaliza el correo, valida el rol y no duplica', async () => {
    const { db } = world();
    const a = await inviteAppUser(
      db,
      APP.id,
      { name: 'Ana', email: '  ANA@Empresa.com ', roleKey: 'operario' },
      'x',
    );
    expect(a.created).toBe(true);
    expect(a.user.email).toBe('ana@empresa.com');
    expect(a.user.status).toBe('invited');
    const b = await inviteAppUser(
      db,
      APP.id,
      { name: 'Ana P.', email: 'ana@empresa.com', roleKey: 'supervisor' },
      'x',
    );
    expect(b.created).toBe(false);
    expect((await listAppUsers(db, APP.id)).length).toBe(1);
    await expect(
      inviteAppUser(db, APP.id, { name: 'X', email: 'x@y.co', roleKey: 'inventado' }, 'x'),
    ).rejects.toThrow(/no tiene el rol/);
    expect(
      appUserInputSchema.safeParse({ name: 'X', email: 'no-es-correo', roleKey: 'operario' })
        .success,
    ).toBe(false);
  });

  it('el CSV acepta punto y coma, trae atributos y salta filas malas sin tumbar las demás', async () => {
    const parsed = parseUsersCsv(
      'Nombre;Correo;Rol;Cliente\nAna;ana@e.com;Operario;Andina\nSin correo;;operario;X\nBeto;beto@e.com;inventado;\n',
    );
    expect(parsed.error).toBeNull();
    expect(parsed.rows[0]).toMatchObject({
      roleKey: 'operario',
      attributes: { cliente: 'Andina' },
    });
    const { db } = world();
    const res = await importAppUsers(db, APP.id, parsed.rows, 'x');
    expect(res.invited.map((u) => u.email)).toEqual(['ana@e.com']);
    expect(res.skipped.map((s) => s.line)).toEqual([2, 3]);
    expect(parseUsersCsv('a,b\n1,2').error).toMatch(/nombre/);
  });
});

describe('usuarios externos: el código', () => {
  it('seis dígitos, sólo se guarda el hash, y es el correcto el que entra', async () => {
    const { db, fake } = world();
    const u = await invited(db);
    const req = await requestLoginCode(db, APP, 'ANA@empresa.com', { secret: SECRET, now: T0 });
    if (!req.issued) throw new Error('debió emitirse');
    expect(req.code).toMatch(/^\d{6}$/);
    expect(generateLoginCode()).toMatch(/^\d{6}$/);
    const stored = fake.tables.custom_app_login_codes?.[0];
    expect(JSON.stringify(stored)).not.toContain(req.code);
    expect(stored?.code_hash).toBe(hashLoginCode(SECRET, u.id, req.code));
    expect(hashLoginCode('otra-llave', u.id, req.code)).not.toBe(stored?.code_hash);
    const ok = await verifyLoginCode(
      db,
      APP,
      'ana@empresa.com',
      `${req.code.slice(0, 3)} ${req.code.slice(3)}`,
      {
        secret: SECRET,
        device: 'Chrome · Android',
        now: at(60_000),
      },
    );
    expect(ok.ok).toBe(true);
    // El código sirve UNA vez.
    expect(
      (
        await verifyLoginCode(db, APP, 'ana@empresa.com', req.code, {
          secret: SECRET,
          now: at(61_000),
        })
      ).ok,
    ).toBe(false);
    expect(cleanCode('12-34 56')).toBe('123456');
  });

  it('vence a los 10 minutos', async () => {
    const { db } = world();
    await invited(db);
    const req = await requestLoginCode(db, APP, 'ana@empresa.com', { secret: SECRET, now: T0 });
    if (!req.issued) throw new Error('debió emitirse');
    expect(
      (
        await verifyLoginCode(db, APP, 'ana@empresa.com', req.code, {
          secret: SECRET,
          now: at(10 * 60_000 + 1),
        })
      ).ok,
    ).toBe(false);
  });

  it('se bloquea a los 5 intentos: ni el código bueno entra después', async () => {
    const { db } = world();
    await invited(db);
    const req = await requestLoginCode(db, APP, 'ana@empresa.com', { secret: SECRET, now: T0 });
    if (!req.issued) throw new Error('debió emitirse');
    const wrong = req.code === '000000' ? '111111' : '000000';
    for (let i = 0; i < MAX_CODE_ATTEMPTS; i++)
      expect(
        (
          await verifyLoginCode(db, APP, 'ana@empresa.com', wrong, {
            secret: SECRET,
            now: at(i * 1000),
          })
        ).ok,
      ).toBe(false);
    expect(
      (
        await verifyLoginCode(db, APP, 'ana@empresa.com', req.code, {
          secret: SECRET,
          now: at(10_000),
        })
      ).ok,
    ).toBe(false);
  });

  it('pedir códigos tiene tope por hora y un código nuevo anula el anterior', async () => {
    const { db } = world();
    await invited(db);
    const first = await requestLoginCode(db, APP, 'ana@empresa.com', { secret: SECRET, now: T0 });
    const second = await requestLoginCode(db, APP, 'ana@empresa.com', {
      secret: SECRET,
      now: at(1000),
    });
    if (!first.issued || !second.issued) throw new Error('debieron emitirse');
    if (first.code !== second.code)
      expect(
        (
          await verifyLoginCode(db, APP, 'ana@empresa.com', first.code, {
            secret: SECRET,
            now: at(2000),
          })
        ).ok,
      ).toBe(false);
    for (let i = 2; i < CODES_PER_HOUR; i++)
      expect(
        (await requestLoginCode(db, APP, 'ana@empresa.com', { secret: SECRET, now: at(i * 1000) }))
          .issued,
      ).toBe(true);
    expect(
      (await requestLoginCode(db, APP, 'ana@empresa.com', { secret: SECRET, now: at(30_000) }))
        .issued,
    ).toBe(false);
  });

  it('no revela si el correo existe: desconocido y desactivado dan lo mismo que un código malo', async () => {
    const { db } = world();
    const u = await invited(db);
    expect(
      await requestLoginCode(db, APP, 'nadie@empresa.com', { secret: SECRET, now: T0 }),
    ).toEqual({ issued: false });
    await setAppUserStatus(db, APP.id, u.id, 'disabled');
    expect(await requestLoginCode(db, APP, 'ana@empresa.com', { secret: SECRET, now: T0 })).toEqual(
      { issued: false },
    );
    // Verificar con un correo que no existe y con uno desactivado: el mismo `{ok:false}`.
    expect(
      await verifyLoginCode(db, APP, 'nadie@empresa.com', '123456', { secret: SECRET, now: T0 }),
    ).toEqual({ ok: false });
    expect(
      await verifyLoginCode(db, APP, 'ana@empresa.com', '123456', { secret: SECRET, now: T0 }),
    ).toEqual({ ok: false });
  });

  it('un usuario de la empresa A no entra a la app de la empresa B con su correo', async () => {
    const { db, otra } = world();
    await invited(db);
    const req = await requestLoginCode(db, APP, 'ana@empresa.com', { secret: SECRET, now: T0 });
    if (!req.issued) throw new Error('debió emitirse');
    const appB = { id: '22222222-2222-4222-8222-222222222222' };
    expect(
      (await requestLoginCode(otra, appB, 'ana@empresa.com', { secret: SECRET, now: T0 })).issued,
    ).toBe(false);
    expect(
      (await verifyLoginCode(otra, appB, 'ana@empresa.com', req.code, { secret: SECRET, now: T0 }))
        .ok,
    ).toBe(false);
  });
});

async function signIn(db: ReturnType<typeof world>['db'], now = T0) {
  await invited(db);
  const req = await requestLoginCode(db, APP, 'ana@empresa.com', { secret: SECRET, now });
  if (!req.issued) throw new Error('debió emitirse');
  const out = await verifyLoginCode(db, APP, 'ana@empresa.com', req.code, {
    secret: SECRET,
    device: 'Chrome · Android',
    now,
  });
  if (!out.ok) throw new Error('debió entrar');
  return out;
}

describe('usuarios externos: la sesión', () => {
  it('guarda el hash del token, no el token', async () => {
    const { db, fake } = world();
    const out = await signIn(db);
    const row = fake.tables.custom_app_sessions?.[0];
    expect(row?.token_hash).toBe(hashSessionToken(out.token));
    expect(JSON.stringify(row)).not.toContain(out.token);
    expect(row?.device).toBe('Chrome · Android');
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit Safari/604.1')).toBe(
      'Safari · iPhone',
    );
  });

  it('resuelve al usuario, se desliza y vence a los 30 días', async () => {
    const { db } = world();
    const out = await signIn(db);
    const early = await resolveExternalSession(db, APP, out.token, { now: at(5 * 60_000) });
    expect(early?.user.email).toBe('ana@empresa.com');
    expect(early?.renewed).toBe(false);
    const later = await resolveExternalSession(db, APP, out.token, { now: at(2 * 3_600_000) });
    expect(later?.renewed).toBe(true);
    // Renovada en t=2h: sigue viva a los 29 días contados desde ahí...
    expect(
      await resolveExternalSession(db, APP, out.token, {
        now: at(2 * 3_600_000 + 29 * 86_400_000),
      }),
    ).not.toBeNull();
    // ...y muere pasados 30 días SIN usarla (esa lectura del día 29 la renovó, así que se cuenta desde ahí).
    expect(
      await resolveExternalSession(db, APP, out.token, {
        now: at(2 * 3_600_000 + 29 * 86_400_000 + 31 * 86_400_000),
      }),
    ).toBeNull();
  });

  it('un token inventado o de otra app no entra', async () => {
    const { db, otra } = world();
    const out = await signIn(db);
    expect(await resolveExternalSession(db, APP, 'x'.repeat(43), { now: T0 })).toBeNull();
    expect(
      await resolveExternalSession(
        otra,
        { id: '22222222-2222-4222-8222-222222222222' },
        out.token,
        { now: T0 },
      ),
    ).toBeNull();
  });

  it('cerrar sesión revoca ESA sesión; «cerrar todas» revoca todas', async () => {
    const { db } = world();
    const a = await signIn(db);
    const req = await requestLoginCode(db, APP, 'ana@empresa.com', {
      secret: SECRET,
      now: at(1000),
    });
    if (!req.issued) throw new Error('debió emitirse');
    const b = await verifyLoginCode(db, APP, 'ana@empresa.com', req.code, {
      secret: SECRET,
      now: at(2000),
    });
    if (!b.ok) throw new Error('debió entrar');
    await revokeSessionByToken(db, APP, a.token);
    expect(await resolveExternalSession(db, APP, a.token, { now: at(3000) })).toBeNull();
    expect(await resolveExternalSession(db, APP, b.token, { now: at(3000) })).not.toBeNull();
    await revokeUserSessions(db, b.user.id);
    expect(await resolveExternalSession(db, APP, b.token, { now: at(4000) })).toBeNull();
  });

  it('desactivar al usuario lo saca en la SIGUIENTE petición, con la sesión vigente', async () => {
    const { db } = world();
    const out = await signIn(db);
    expect(await resolveExternalSession(db, APP, out.token, { now: at(1000) })).not.toBeNull();
    await setAppUserStatus(db, APP.id, out.user.id, 'disabled');
    expect(await resolveExternalSession(db, APP, out.token, { now: at(2000) })).toBeNull();
    // Reactivarlo no resucita la sesión vieja: tiene que volver a entrar con código.
    await setAppUserStatus(db, APP.id, out.user.id, 'active');
    expect(await resolveExternalSession(db, APP, out.token, { now: at(3000) })).toBeNull();
  });

  it('si el rol deja de existir, queda fuera', async () => {
    const { db, fake } = world();
    const out = await signIn(db);
    fake.tables.custom_app_roles = (fake.tables.custom_app_roles ?? []).filter(
      (r) => r.key !== 'operario' || r.organization_id !== ORG,
    );
    expect(await resolveExternalSession(db, APP, out.token, { now: at(1000) })).toBeNull();
  });
});

describe('usuarios externos: la app desde afuera', () => {
  it('sólo se encuentran apps publicadas; borrador, ajena o id malo no', async () => {
    const { fake } = world();
    expect((await findPublishedApp(fake.client, APP.id))?.organization_id).toBe(ORG);
    expect(await findPublishedApp(fake.client, '33333333-3333-4333-8333-333333333333')).toBeNull();
    expect(await findPublishedApp(fake.client, 'planta')).toBeNull();
    expect(await findPublishedApp(fake.client, '99999999-9999-4999-8999-999999999999')).toBeNull();
  });

  it('el acceso externo lleva `external` (su «own» mira created_by_app_user) y nunca es administrador', async () => {
    const { db } = world();
    const out = await signIn(db);
    const app = await getApp(db, APP.id);
    if (!app) throw new Error('sin app');
    const access = await externalAppAccess(db, app, out.user);
    expect(access?.user.external).toBe(true);
    expect(access?.role.admin).toBe(false);
    expect(access?.role.key).toBe('operario');
  });
});
