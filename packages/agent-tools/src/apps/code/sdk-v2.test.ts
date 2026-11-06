import { ForbiddenError, NotFoundError, ValidationError } from '@cortex/core';
import { describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from '../../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../tenancy/scoped-client';
import { APPROVE_ACTION_ID, REJECT_ACTION_ID, viewSpecSchema } from '../../views/spec';
import { type AppAccess, resolveAppAccess } from '../store';
import { CONTROL_EN_PLANTA } from '../templates';
import { runSdkOp } from './sdk';

/**
 * EL SDK v2: acciones por clave, subida de archivos a una fila, zonas.
 * Misma base falsa que sdk.test.ts: una empresa, la app «planta» (Guías), una
 * pantalla de código y una pantalla de bloques (oculta para todos) que define los
 * botones de fila. La pantalla de código no define botones: los toma de ahí.
 */

const ORG = 'org-postal';
const APP = 'app-postal';
const ANA = 'u-ana'; // operaria: lo suyo, sin botones
const SOFIA = 'u-sofia'; // supervisora: botones Revisar, Aprobar, Rechazar
const GERENTE = 'u-gerente'; // gerencia: no escribe

const guiaFields = CONTROL_EN_PLANTA.trackers[0]?.fields ?? [];

const botones = viewSpecSchema.parse({
  version: 1,
  accent: 'amber',
  refreshSeconds: 0,
  editing: 'team',
  alerts: [],
  theme: { accent: 'amber', density: 'compact' },
  blocks: [
    {
      id: 'cola',
      type: 'table',
      width: 'full',
      tracker: 'guias',
      title: 'Cola',
      columns: ['numero_guia', 'estado'],
      filters: [],
      limit: 50,
      actions: [
        { id: 'revisar', label: 'Revisar', kind: 'set_field', field: 'estado', value: 'Aprobada' },
      ],
    },
    {
      id: 'registrar_sup',
      type: 'form',
      width: 'full',
      tracker: 'guias',
      title: 'Registrar',
      fields: ['numero_guia', 'fecha'],
      submitLabel: 'Registrar',
      successMessage: 'Listo',
      approval: {
        field: 'estado',
        pending: 'Pendiente',
        approved: 'Aprobada',
        rejected: 'Rechazada',
        notesField: 'motivo_rechazo',
      },
    },
  ],
});

function seed() {
  const row = (id: string, by: string, numero: string) => ({
    id,
    organization_id: ORG,
    tracker_id: 'trk-guias',
    label: numero,
    values: { numero_guia: numero, fecha: '2026-10-05', estado: 'Pendiente' },
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
        fields: [
          ...guiaFields,
          {
            key: 'anexos',
            label: 'Anexos',
            type: 'file',
            required: false,
            accept: 'any',
            multiple: true,
          },
        ],
        duplicates: null,
        created_by: null,
        created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-01T00:00:00Z',
      },
    ],
    tracker_rows: [row('r1', ANA, '123-001'), row('r2', 'u-beto', '123-002')],
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
          geofences: [
            { id: 'bodega', name: 'Bodega', lat: 4.7, lng: -74.1, radiusM: 150 },
            {
              id: 'plataforma',
              name: 'Plataforma',
              lat: 4.8,
              lng: -74.2,
              radiusM: 500,
              polygon: [
                [4.8, -74.2],
                [4.8, -74.19],
                [4.81, -74.19],
                [4.81, -74.2],
              ],
              marginM: 10,
            },
          ],
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
      {
        id: 'scr-botones',
        organization_id: ORG,
        app_id: APP,
        view_id: 'view-botones',
        slug: 'botones',
        title: 'Botones',
        icon: 'BadgeCheck',
        position: 1,
        roles: [], // ningún rol la ve; sólo define los botones
        kind: 'view',
      },
    ],
    custom_views: [
      {
        id: 'view-botones',
        organization_id: ORG,
        slug: 'p_botones',
        name: 'Botones',
        description: '',
        spec: botones,
        version: 1,
        visibility: 'workspace',
        share_token: null,
        share_expires_at: null,
        share_views: 0,
        pinned: false,
        app_id: APP,
        created_by: null,
        updated_by: null,
        created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-01T00:00:00Z',
        archived_at: null,
      },
    ],
    custom_view_events: [],
    custom_app_roles: CONTROL_EN_PLANTA.roles.map((r, i) => ({
      id: `role-${r.key}`,
      organization_id: ORG,
      app_id: APP,
      key: r.key,
      name: r.name,
      description: r.description,
      permissions:
        r.key === 'supervisor'
          ? {
              ...r.permissions,
              tables: {
                guias: {
                  read: 'all',
                  create: true,
                  edit: 'all',
                  actions: ['revisar', APPROVE_ACTION_ID, REJECT_ACTION_ID],
                },
              },
            }
          : r.permissions,
      position: i,
    })),
    custom_app_members: [
      member(ANA, 'operario'),
      member('u-beto', 'operario'),
      member(SOFIA, 'supervisor'),
      member(GERENTE, 'gerencia'),
    ],
  };
}

const SCREEN = { id: 'scr-torre', slug: 'torre', view_id: 'view-torre' };

async function setup() {
  const fake = createFakeSupabase(seed());
  const db = createOrgScopedClient(fake.client, ORG);
  const as = async (id: string): Promise<AppAccess> => {
    const access = await resolveAppAccess(db, 'planta', { id, name: id, companyAdmin: false });
    if (!access) throw new Error(`sin acceso: ${id}`);
    return access;
  };
  return { db, fake, as };
}

const stateOf = (fake: { tables: Record<string, unknown[] | undefined> }, id: string) =>
  (
    fake.tables.tracker_rows?.find((r) => (r as { id: string }).id === id) as {
      values: Record<string, unknown>;
    }
  ).values;

describe('tables.listActions', () => {
  it('lista los botones que el rol puede correr, con Aprobar / Rechazar', async () => {
    const { db, as } = await setup();
    const sofia = (await runSdkOp(db, await as(SOFIA), 'tables.listActions', {
      table: 'guias',
    })) as Array<{
      key: string;
    }>;
    expect(sofia.map((a) => a.key).sort()).toEqual(['aprobar', 'rechazar', 'revisar']);
    expect(await runSdkOp(db, await as(ANA), 'tables.listActions', { table: 'guias' })).toEqual([]);
  });
  it('una tabla que el rol no lee se niega', async () => {
    const { db, as } = await setup();
    await expect(
      runSdkOp(db, await as(ANA), 'tables.listActions', { table: 'nomina' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('tables.action', () => {
  it('un rol sin la acción recibe ForbiddenError y no se escribe', async () => {
    const { db, fake, as } = await setup();
    for (const action of ['revisar', 'aprobar', 'cualquiera']) {
      await expect(
        runSdkOp(
          db,
          await as(ANA),
          'tables.action',
          { table: 'guias', id: 'r1', action },
          { screen: SCREEN },
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(stateOf(fake, 'r1').estado).toBe('Pendiente');
    expect(fake.tables.custom_view_events ?? []).toHaveLength(0);
  });
  it('«Ver como…» (readOnly) no escribe', async () => {
    const { db, fake, as } = await setup();
    await expect(
      runSdkOp(
        db,
        await as(SOFIA),
        'tables.action',
        { table: 'guias', id: 'r1', action: 'revisar' },
        { screen: SCREEN, readOnly: true },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(stateOf(fake, 'r1').estado).toBe('Pendiente');
  });
  it('corre el botón de la vista: cambia el campo, deja el evento y devuelve la fila', async () => {
    const { db, fake, as } = await setup();
    const out = (await runSdkOp(
      db,
      await as(SOFIA),
      'tables.action',
      { table: 'guias', id: 'r1', action: 'revisar' },
      { screen: SCREEN },
    )) as { message: string; row?: { values: Record<string, unknown> } };
    expect(out.message).toMatch(/revisar/i);
    expect(out.row?.values.estado).toBe('Aprobada');
    expect(stateOf(fake, 'r1').estado).toBe('Aprobada');
    expect(fake.tables.custom_view_events?.[0]).toMatchObject({
      kind: 'action',
      action_id: 'revisar',
    });
  });
  it('rechazar guarda el motivo; aprobar una ya revisada se rechaza', async () => {
    const { db, fake, as } = await setup();
    await runSdkOp(
      db,
      await as(SOFIA),
      'tables.action',
      { table: 'guias', id: 'r2', action: 'rechazar', reason: 'Guía ilegible' },
      { screen: SCREEN },
    );
    expect(stateOf(fake, 'r2')).toMatchObject({
      estado: 'Rechazada',
      motivo_rechazo: 'Guía ilegible',
    });
    await expect(
      runSdkOp(
        db,
        await as(SOFIA),
        'tables.action',
        { table: 'guias', id: 'r2', action: 'aprobar' },
        { screen: SCREEN },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
  it('una acción que ninguna vista define es NotFound (para quien sí podría)', async () => {
    const { db, fake, as } = await setup();
    // El administrador salta el permiso, pero la acción tiene que existir.
    const admin = await resolveAppAccess(db, 'planta', {
      id: 'u-admin',
      name: 'Admin',
      companyAdmin: true,
    });
    await expect(
      runSdkOp(
        db,
        admin as AppAccess,
        'tables.action',
        { table: 'guias', id: 'r1', action: 'inventada' },
        { screen: SCREEN },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(stateOf(fake, 'r1').estado).toBe('Pendiente');
  });
});

describe('files.upload', () => {
  const upload = (name = 'foto.jpg', type = 'image/jpeg') => {
    const store = vi.fn(async (_accept: 'image' | 'any', fileName: string) => ({
      url: `/api/files/blob/${fileName}`,
      name: fileName,
      mime: type,
      size: 10,
    }));
    return { store, upload: { file: { name, type, size: 10 }, store } };
  };

  it('guarda el archivo en el campo de la fila (reemplaza si no admite varios)', async () => {
    const { db, fake, as } = await setup();
    const u = upload();
    const out = (await runSdkOp(
      db,
      await as(ANA),
      'files.upload',
      { table: 'guias', id: 'r1', field: 'foto', name: 'guia.jpg' },
      { screen: SCREEN, upload: u.upload },
    )) as { url: string; name: string; values: Record<string, unknown> };
    expect(u.store).toHaveBeenCalledWith('image', 'guia.jpg');
    expect(out).toMatchObject({ name: 'guia.jpg', url: '/api/files/blob/guia.jpg' });
    expect(JSON.parse(String(stateOf(fake, 'r1').foto))).toMatchObject({ name: 'guia.jpg' });
  });
  it('en un campo con varios archivos AGREGA', async () => {
    const { db, fake, as } = await setup();
    // El supervisor edita todo; los anexos no están en la lista de campos de un operario.
    const sofia = await as(SOFIA);
    for (const n of ['a.pdf', 'b.pdf']) {
      const u = upload(n, 'application/pdf');
      await runSdkOp(
        db,
        sofia,
        'files.upload',
        { table: 'guias', id: 'r1', field: 'anexos' },
        { screen: SCREEN, upload: u.upload },
      );
    }
    const list = JSON.parse(String(stateOf(fake, 'r1').anexos)) as Array<{ name: string }>;
    expect(list.map((f) => f.name)).toEqual(['a.pdf', 'b.pdf']);
  });
  it('rechaza un campo que no es de archivos o que no existe, sin guardar nada', async () => {
    const { db, as } = await setup();
    const u = upload();
    await expect(
      runSdkOp(
        db,
        await as(ANA),
        'files.upload',
        { table: 'guias', id: 'r1', field: 'ubicacion' },
        { screen: SCREEN, upload: u.upload },
      ),
    ).rejects.toThrow(/no recibe archivos/);
    await expect(
      runSdkOp(
        db,
        await as(ANA),
        'files.upload',
        { table: 'guias', id: 'r1', field: 'nada' },
        { screen: SCREEN, upload: u.upload },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(u.store).not.toHaveBeenCalled();
  });
  it('exige permiso de edición del campo y de la fila; readOnly no guarda', async () => {
    const { db, as } = await setup();
    const u = upload();
    // Gerencia no edita la tabla.
    await expect(
      runSdkOp(
        db,
        await as(GERENTE),
        'files.upload',
        { table: 'guias', id: 'r1', field: 'foto' },
        { screen: SCREEN, upload: u.upload },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // El operario no ve la fila de otro.
    await expect(
      runSdkOp(
        db,
        await as(ANA),
        'files.upload',
        { table: 'guias', id: 'r2', field: 'foto' },
        { screen: SCREEN, upload: u.upload },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    // «anexos» no está en la lista de campos del operario.
    await expect(
      runSdkOp(
        db,
        await as(ANA),
        'files.upload',
        { table: 'guias', id: 'r1', field: 'anexos' },
        { screen: SCREEN, upload: u.upload },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      runSdkOp(
        db,
        await as(SOFIA),
        'files.upload',
        { table: 'guias', id: 'r1', field: 'foto' },
        { screen: SCREEN, readOnly: true, upload: u.upload },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(u.store).not.toHaveBeenCalled();
  });
  it('sin archivo adjunto se rechaza', async () => {
    const { db, as } = await setup();
    await expect(
      runSdkOp(
        db,
        await as(ANA),
        'files.upload',
        { table: 'guias', id: 'r1', field: 'foto' },
        { screen: SCREEN },
      ),
    ).rejects.toThrow(/ningún archivo/);
  });
});

describe('location.status y location.evaluate', () => {
  it('status dice si la app comparte ubicación y si ya aceptó', async () => {
    const { db, as } = await setup();
    const s = (await runSdkOp(db, await as(ANA), 'location.status', null)) as {
      enabled: boolean;
      consented: boolean;
    };
    expect(s.enabled).toBe(true);
    expect(s.consented).toBe(false);
  });
  it('evalúa círculo y polígono con holgura; fuera de todo es zone null', async () => {
    const { db, as } = await setup();
    const ana = await as(ANA);
    expect(
      await runSdkOp(db, ana, 'location.evaluate', { lat: 4.7005, lng: -74.1, accuracy: 20 }),
    ).toEqual({
      zone: 'Bodega',
      inside: true,
    });
    expect(await runSdkOp(db, ana, 'location.evaluate', { lat: 4.805, lng: -74.195 })).toEqual({
      zone: 'Plataforma',
      inside: true,
    });
    expect(await runSdkOp(db, ana, 'location.evaluate', { lat: 4.9, lng: -74.5 })).toEqual({
      zone: null,
      inside: false,
    });
    await expect(
      runSdkOp(db, ana, 'location.evaluate', { lat: 99, lng: 0 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('pantalla oculta', () => {
  it('no sale en el menú de nadie, ni del administrador', async () => {
    const { canSeeScreen, HIDDEN_SCREEN_ROLE } = await import('../permissions');
    const admin = {
      key: 'admin',
      name: 'Admin',
      permissions: { tables: {} },
      admin: true,
    } as never;
    const sup = {
      key: 'supervisor',
      name: 'Sup',
      permissions: { tables: {} },
      admin: false,
    } as never;
    expect(canSeeScreen(admin, [HIDDEN_SCREEN_ROLE])).toBe(false);
    expect(canSeeScreen(sup, [HIDDEN_SCREEN_ROLE, 'supervisor'])).toBe(false);
    expect(canSeeScreen(sup, [])).toBe(true);
    expect(canSeeScreen(admin, ['operario'])).toBe(true);
  });
});

describe('people.list y user.me.ref', () => {
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  async function withPeople() {
    const w = await setup();
    const roles = w.fake.tables.custom_app_roles as Array<{
      key: string;
      permissions: Record<string, unknown>;
    }>;
    const sup = roles.find((r) => r.key === 'supervisor');
    if (sup) sup.permissions = { ...sup.permissions, location: { assign: true } };
    w.fake.tables.users = [
      { id: SOFIA, organization_id: ORG, name: 'Sofía', email: 's@x.co' },
      { id: ANA, organization_id: ORG, name: 'Ana', email: 'a@x.co' },
    ];
    w.fake.tables.custom_app_users = [
      {
        id: uuid(7),
        organization_id: ORG,
        app_id: APP,
        name: 'Externo',
        role_key: 'operario',
        status: 'active',
      },
    ];
    return w;
  }
  it('sin permiso de asignar, error claro', async () => {
    const { db, as } = await withPeople();
    await expect(runSdkOp(db, await as(ANA), 'people.list', {})).rejects.toThrow(
      /no asigna tareas/,
    );
  });
  it('lista personas con ref y filtra por rol; el ref de user.me coincide', async () => {
    const { db, as } = await withPeople();
    const sofia = await as(SOFIA);
    const all = (await runSdkOp(db, sofia, 'people.list', null)) as Array<{
      ref: string;
      name: string;
      roleKey: string;
    }>;
    expect(all.map((p) => p.ref)).toContain(`u:${uuid(7)}`);
    const me = (await runSdkOp(db, sofia, 'user.me', null)) as { ref: string };
    expect(me.ref).toBe(`m:${SOFIA}`);
    expect(all.find((p) => p.name === 'Sofía')?.ref).toBe(me.ref);
    const ops = (await runSdkOp(db, sofia, 'people.list', { roles: ['operario'] })) as Array<{
      roleKey: string;
    }>;
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.every((p) => p.roleKey === 'operario')).toBe(true);
  });
});
