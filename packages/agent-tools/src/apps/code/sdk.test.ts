import { ForbiddenError, NotFoundError, ValidationError } from '@cortex/core';
import { describe, expect, it } from 'vitest';
import { createFakeSupabase } from '../../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../tenancy/scoped-client';
import { type AppAccess, resolveAppAccess } from '../store';
import { CONTROL_EN_PLANTA } from '../templates';
import { runSdkOp } from './sdk';

/**
 * EL SDK DE LAS PANTALLAS CON CÓDIGO: LOS PERMISOS DE CADA OPERACIÓN.
 *
 * Misma postura que isolation.test.ts: la base falsa con una empresa, una app
 * «planta» y tres guías de dos operarios. Cada prueba afirma qué volvió o qué
 * se rechazó (y que NO se escribió nada) para el rol que llama; los permisos
 * en sí ya los prueba permissions.test.ts, aquí se comprueba que el SDK los usa.
 */

const ORG = 'org-postal';
const APP = 'app-postal';
const ADMIN = 'u-admin';
const ANA = 'u-ana'; // operaria: lee y edita lo suyo
const BETO = 'u-beto'; // operario
const SOFIA = 'u-sofia'; // supervisora: todo
const GERENTE = 'u-gerente'; // gerencia: lee, no escribe
const HOY = new Date().toISOString().slice(0, 10);

const guiaFields = CONTROL_EN_PLANTA.trackers[0]?.fields ?? [];

function seed() {
  const row = (id: string, by: string, numero: string) => ({
    id,
    organization_id: ORG,
    tracker_id: 'trk-guias',
    label: numero,
    values: { numero_guia: numero, fecha: HOY, estado: 'Pendiente' },
    created_by: by,
    created_at: '2026-10-05T10:00:00Z',
    updated_at: '2026-10-05T10:00:00Z',
  });
  const member = (user: string, roleKey: string) => ({
    id: `m-${user}`,
    organization_id: ORG,
    app_id: APP,
    user_id: user,
    role_key: roleKey,
    attributes: {},
    created_by: null,
    created_at: '2026-10-01T00:00:00Z',
  });
  return {
    trackers: [
      {
        id: 'trk-guias',
        organization_id: ORG,
        slug: 'guias',
        name: 'Guías',
        description: '',
        fields: guiaFields,
        duplicates: null,
        created_by: null,
        created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-01T00:00:00Z',
      },
      {
        id: 'trk-secreta',
        organization_id: ORG,
        slug: 'nomina',
        name: 'Nómina',
        description: '',
        fields: [{ key: 'sueldo', label: 'Sueldo', type: 'number', required: false }],
        duplicates: null,
        created_by: null,
        created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-01T00:00:00Z',
      },
    ],
    tracker_rows: [
      row('r1', ANA, '123-001'),
      row('r2', ANA, '123-002'),
      row('r3', BETO, '123-003'),
      {
        id: 'r-nomina',
        organization_id: ORG,
        tracker_id: 'trk-secreta',
        label: 'x',
        values: { sueldo: 9999 },
        created_by: ADMIN,
        created_at: '2026-10-05T10:00:00Z',
        updated_at: '2026-10-05T10:00:00Z',
      },
    ],
    custom_apps: [
      {
        id: APP,
        organization_id: ORG,
        slug: 'planta',
        name: 'Control en planta',
        description: '',
        icon: '🏭',
        theme: {},
        home_screen: null,
        status: 'published',
        version: 1,
        location: {
          enabled: true,
          retentionDays: 30,
          geofences: [{ id: 'bodega', name: 'Bodega', lat: 4.7, lng: -74.1, radiusM: 150 }],
        },
        created_by: null,
        updated_by: null,
        created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-01T00:00:00Z',
        archived_at: null,
      },
    ],
    custom_app_screens: [
      {
        id: 'scr-torre',
        organization_id: ORG,
        app_id: APP,
        view_id: 'view-torre',
        slug: 'torre',
        title: 'Torre',
        icon: 'LayoutPanelTop',
        position: 0,
        roles: [],
        kind: 'code',
        code_entry: 'screens/torre.tsx',
      },
    ],
    custom_views: [],
    custom_view_events: [],
    custom_app_roles: CONTROL_EN_PLANTA.roles.map((r, i) => ({
      id: `role-${r.key}`,
      organization_id: ORG,
      app_id: APP,
      key: r.key,
      name: r.name,
      description: r.description,
      permissions: r.permissions,
      position: i,
    })),
    custom_app_members: [
      member(ANA, 'operario'),
      member(BETO, 'operario'),
      member(SOFIA, 'supervisor'),
      member(GERENTE, 'gerencia'),
    ],
  };
}

const SCREEN = { id: 'scr-torre', slug: 'torre', view_id: 'view-torre' };

async function setup() {
  const fake = createFakeSupabase(seed());
  const db = createOrgScopedClient(fake.client, ORG);
  const as = async (id: string, companyAdmin = false): Promise<AppAccess> => {
    const access = await resolveAppAccess(db, 'planta', { id, name: id, companyAdmin });
    if (!access) throw new Error(`sin acceso: ${id}`);
    return access;
  };
  return { db, fake, as };
}

const ids = (res: unknown) =>
  ((res as { rows: Array<{ id: string }> }).rows ?? []).map((r) => r.id).sort();

describe('user.me y tables.list', () => {
  it('devuelve quién es y su rol', async () => {
    const { db, as } = await setup();
    const me = (await runSdkOp(db, await as(ANA), 'user.me', null)) as { id: string; role: string };
    expect(me).toMatchObject({ id: ANA, role: 'operario' });
  });
  it('lista sólo las tablas que el rol lee', async () => {
    const { db, as } = await setup();
    const list = (await runSdkOp(db, await as(ANA), 'tables.list', null)) as Array<{ id: string }>;
    expect(list.map((t) => t.id)).toEqual(['guias']);
    const all = (await runSdkOp(db, await as(ADMIN, true), 'tables.list', null)) as Array<{
      id: string;
    }>;
    expect(all.map((t) => t.id).sort()).toEqual(['guias', 'nomina']);
  });
});

describe('tables.query / tables.get', () => {
  it('un operario ve sólo lo que registró', async () => {
    const { db, as } = await setup();
    const res = await runSdkOp(
      db,
      await as(ANA),
      'tables.query',
      { table: 'guias' },
      { screen: SCREEN },
    );
    expect(ids(res)).toEqual(['r1', 'r2']);
    const beto = await runSdkOp(db, await as(BETO), 'tables.query', { table: 'guias' });
    expect(ids(beto)).toEqual(['r3']);
  });
  it('gerencia y supervisión ven todas', async () => {
    const { db, as } = await setup();
    expect(ids(await runSdkOp(db, await as(GERENTE), 'tables.query', { table: 'guias' }))).toEqual([
      'r1',
      'r2',
      'r3',
    ]);
    expect(
      ids(await runSdkOp(db, await as(SOFIA), 'tables.query', { table: 'guias' })),
    ).toHaveLength(3);
  });
  it('una tabla que el rol no nombra se niega, exista o no', async () => {
    const { db, as } = await setup();
    await expect(
      runSdkOp(db, await as(ANA), 'tables.query', { table: 'nomina' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      runSdkOp(db, await as(ANA), 'tables.query', { table: 'no_existe' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
  it('where, orden y límite se aplican sobre lo que el rol ya ve', async () => {
    const { db, as } = await setup();
    const res = await runSdkOp(db, await as(SOFIA), 'tables.query', {
      table: 'guias',
      where: { numero_guia: '123-003' },
    });
    expect(ids(res)).toEqual(['r3']);
    // Ana filtra por el número de la guía de Beto: el scope manda, no ve nada.
    const none = await runSdkOp(db, await as(ANA), 'tables.query', {
      table: 'guias',
      where: { numero_guia: '123-003' },
    });
    expect(ids(none)).toEqual([]);
    const limited = await runSdkOp(db, await as(SOFIA), 'tables.query', {
      table: 'guias',
      order: { field: 'label', dir: 'desc' },
      limit: 1,
    });
    expect(ids(limited)).toEqual(['r3']);
  });
  it('rechaza campos que no existen y límites absurdos', async () => {
    const { db, as } = await setup();
    await expect(
      runSdkOp(db, await as(SOFIA), 'tables.query', { table: 'guias', where: { zzz: 1 } }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      runSdkOp(db, await as(SOFIA), 'tables.query', { table: 'guias', limit: 5000 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
  it('get: una fila ajena no existe', async () => {
    const { db, as } = await setup();
    const own = (await runSdkOp(db, await as(ANA), 'tables.get', { table: 'guias', id: 'r1' })) as {
      id: string;
    };
    expect(own.id).toBe('r1');
    await expect(
      runSdkOp(db, await as(ANA), 'tables.get', { table: 'guias', id: 'r3' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('tables.insert', () => {
  it('quien no puede crear en la tabla es rechazado y no se escribe', async () => {
    const { db, fake, as } = await setup();
    const before = fake.tables.tracker_rows?.length ?? 0;
    await expect(
      runSdkOp(db, await as(GERENTE), 'tables.insert', {
        table: 'guias',
        values: { numero_guia: 'X-1' },
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(fake.tables.tracker_rows?.length ?? 0).toBe(before);
  });
  it('un campo fuera de la lista del rol se rechaza', async () => {
    const { db, as } = await setup();
    await expect(
      runSdkOp(db, await as(ANA), 'tables.insert', {
        table: 'guias',
        values: { numero_guia: 'X-2', fecha: HOY, estado: 'Aprobada' },
      }),
    ).rejects.toThrow(/no puede escribir/);
  });
  it('un campo que la tabla no tiene se rechaza', async () => {
    const { db, as } = await setup();
    await expect(
      runSdkOp(db, await as(ANA), 'tables.insert', { table: 'guias', values: { zzz: '1' } }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
  it('«Ver como…» no escribe', async () => {
    const { db, as } = await setup();
    await expect(
      runSdkOp(
        db,
        await as(ANA),
        'tables.insert',
        { table: 'guias', values: { numero_guia: 'X-3', fecha: HOY } },
        { readOnly: true },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
  it('un operario crea una fila suya y la ve después', async () => {
    const { db, fake, as } = await setup();
    const access = await as(ANA);
    const row = (await runSdkOp(
      db,
      access,
      'tables.insert',
      { table: 'guias', values: { numero_guia: 'X-4', fecha: HOY } },
      { screen: SCREEN },
    )) as { id: string };
    const stored = fake.tables.tracker_rows?.find((r) => r.id === row.id) as { created_by: string };
    expect(stored.created_by).toBe(ANA);
    const mine = await runSdkOp(db, access, 'tables.query', { table: 'guias' });
    expect(ids(mine)).toContain(row.id);
  });
});

describe('tables.update', () => {
  it('edita lo suyo, con campos permitidos, y deja el evento de auditoría', async () => {
    const { db, fake, as } = await setup();
    await runSdkOp(
      db,
      await as(ANA),
      'tables.update',
      { table: 'guias', id: 'r1', values: { ubicacion: 'Muelle 3' } },
      { screen: SCREEN },
    );
    const stored = fake.tables.tracker_rows?.find((r) => r.id === 'r1') as {
      values: Record<string, unknown>;
    };
    expect(stored.values.ubicacion).toBe('Muelle 3');
    const events = fake.tables.custom_view_events ?? [];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      view_id: 'view-torre',
      block_id: 'code',
      kind: 'edit',
      actor: ANA,
    });
  });
  it('una fila ajena no existe para quien no la ve', async () => {
    const { db, as } = await setup();
    await expect(
      runSdkOp(db, await as(ANA), 'tables.update', {
        table: 'guias',
        id: 'r3',
        values: { ubicacion: 'x' },
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
  it('un campo fuera de la lista se rechaza; gerencia no edita', async () => {
    const { db, fake, as } = await setup();
    await expect(
      runSdkOp(db, await as(ANA), 'tables.update', {
        table: 'guias',
        id: 'r1',
        values: { estado: 'Aprobada' },
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      runSdkOp(db, await as(GERENTE), 'tables.update', {
        table: 'guias',
        id: 'r1',
        values: { ubicacion: 'x' },
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const stored = fake.tables.tracker_rows?.find((r) => r.id === 'r1') as {
      values: Record<string, unknown>;
    };
    expect(stored.values.estado).toBe('Pendiente');
    expect(fake.tables.custom_view_events ?? []).toHaveLength(0);
  });
  it('el supervisor edita cualquiera; «Ver como…» no', async () => {
    const { db, as } = await setup();
    await runSdkOp(db, await as(SOFIA), 'tables.update', {
      table: 'guias',
      id: 'r3',
      values: { ubicacion: 'Z' },
    });
    await expect(
      runSdkOp(
        db,
        await as(SOFIA),
        'tables.update',
        { table: 'guias', id: 'r3', values: { ubicacion: 'Q' } },
        { readOnly: true },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('ubicaciones, zonas y lo que llega después', () => {
  it('locations.live exige el permiso de ver ubicaciones', async () => {
    const { db, as } = await setup();
    await expect(runSdkOp(db, await as(ANA), 'locations.live', null)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
  it('geofences.list devuelve las zonas de la app', async () => {
    const { db, as } = await setup();
    const zones = (await runSdkOp(db, await as(ANA), 'geofences.list', null)) as Array<{
      id: string;
      radiusM: number;
    }>;
    expect(zones).toEqual([expect.objectContaining({ id: 'bodega', radiusM: 150 })]);
  });
  it('functions.call valida el nombre, pide código publicado y no se anida; db.query avisa su fase', async () => {
    const { db, as } = await setup();
    await expect(runSdkOp(db, await as(ANA), 'functions.call', { name: 'X!' })).rejects.toThrow(
      /minúsculas/,
    );
    await expect(runSdkOp(db, await as(ANA), 'functions.call', { name: 'cobrar' })).rejects.toThrow(
      /código/,
    );
    await expect(
      runSdkOp(db, await as(ANA), 'functions.call', { name: 'cobrar' }, { via: 'function' }),
    ).rejects.toThrow(/otra función/);
    await expect(runSdkOp(db, await as(ANA), 'db.query', { sql: 'select 1' })).rejects.toThrow(
      /fase 3/,
    );
  });
  it('una operación que no existe se rechaza', async () => {
    const { db, as } = await setup();
    await expect(runSdkOp(db, await as(ANA), 'tables.drop', {})).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
