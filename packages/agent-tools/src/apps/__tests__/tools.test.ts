import { describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from '../../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../tenancy/scoped-client';
import type { ToolContext } from '../../types';
import { deleteView } from '../../views/store';
import { CONTROL_EN_PLANTA } from '../templates';
import {
  appsAssignMembers,
  appsCreate,
  appsDelete,
  appsGet,
  appsInviteUsers,
  appsPublish,
  appsUpdate,
} from '../tools';

/**
 * LAS HERRAMIENTAS DE APLICACIONES DEL CHAT (0208 + 0209): permisos y validación.
 *
 * Todas cambian lo que ve gente de afuera, así que valen lo mismo que el editor:
 * sólo owner/admin (si no, Forbidden, sin tocar nada), y cada pieza se valida
 * con lo mismo que el editor antes de escribir.
 */

const ORG = 'org-postal';
const ADMIN = 'u-admin';
const OPERARIO = 'u-operario';
const APP_ID = '11111111-1111-4111-8111-111111111111';

function world() {
  const guiaFields = CONTROL_EN_PLANTA.trackers[0]?.fields ?? [];
  const fake = createFakeSupabase({
    users: [
      {
        id: ADMIN,
        organization_id: ORG,
        name: 'Admin',
        email: 'admin@postal.co',
        role: 'org_admin',
        created_at: '2026-10-01T00:00:00Z',
      },
      {
        id: OPERARIO,
        organization_id: ORG,
        name: 'Olga Operaria',
        email: 'olga@postal.co',
        role: 'member',
        created_at: '2026-10-02T00:00:00Z',
      },
    ],
    trackers: [
      {
        id: 'trk',
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
    ],
    tracker_rows: [],
    custom_apps: [
      {
        id: APP_ID,
        organization_id: ORG,
        slug: 'planta',
        name: 'Control en planta',
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
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-01T00:00:00Z',
      archived_at: null,
    })),
    custom_view_versions: [],
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
    custom_app_members: [],
    custom_app_users: [],
    custom_app_sessions: [],
  });
  const db = createOrgScopedClient(fake.client, ORG);
  const ctx = (userId: string, extra: Partial<ToolContext> = {}) =>
    ({
      db,
      userId,
      organizationId: ORG,
      agentId: 'a',
      logger: console,
      integrations: {},
      ...extra,
    }) as unknown as ToolContext;
  return { fake, db, ctx };
}

describe('apps.*: sólo quien administra la empresa', () => {
  it('un miembro cualquiera no crea, cambia, publica, asigna ni invita (y no se escribe nada)', async () => {
    const { ctx, fake } = world();
    const c = ctx(OPERARIO);
    await expect(appsCreate.handler({ template: 'control_planta' } as never, c)).rejects.toThrow(
      /administra/,
    );
    await expect(appsUpdate.handler({ app: 'planta', name: 'Otro' } as never, c)).rejects.toThrow(
      /administra/,
    );
    await expect(appsPublish.handler({ app: 'planta', publish: true }, c)).rejects.toThrow(
      /administra/,
    );
    await expect(
      appsAssignMembers.handler(
        { app: 'planta', assign: [{ person: 'admin@postal.co', roleKey: 'operario' }], remove: [] },
        c,
      ),
    ).rejects.toThrow(/administra/);
    await expect(
      appsInviteUsers.handler(
        { app: 'planta', users: [{ name: 'X', email: 'x@y.co', roleKey: 'operario' }], send: true },
        c,
      ),
    ).rejects.toThrow(/administra/);
    expect(fake.tables.custom_apps?.[0]?.name).toBe('Control en planta');
    expect(fake.tables.custom_apps?.[0]?.status).toBe('draft');
    expect(fake.tables.custom_app_users).toHaveLength(0);
    expect(fake.tables.custom_app_members).toHaveLength(0);
  });

  it('apps.get lo puede leer cualquiera, pero los usuarios invitados sólo los ve quien administra', async () => {
    const { ctx } = world();
    const admin = await appsGet.handler({ app: 'planta' }, ctx(ADMIN));
    const member = await appsGet.handler({ app: 'planta' }, ctx(OPERARIO));
    expect(admin.screens.map((s) => s.slug)).toContain('registrar');
    expect(admin.roles.map((r) => r.key)).toContain('operario');
    expect(admin.users).toEqual([]);
    expect(member.users).toBeNull();
  });
});

describe('apps.update', () => {
  it('renombra, cambia pantalla de inicio y roles con la misma validación del editor', async () => {
    const { ctx, fake } = world();
    const res = await appsUpdate.handler(
      {
        app: 'planta',
        name: 'Planta Norte',
        homeScreen: 'mis_registros',
        roles: [
          {
            key: 'operario',
            name: 'Operario',
            description: '',
            permissions: {
              tables: { guias: { read: 'own', create: true, edit: 'none', actions: [] } },
              export: false,
            },
          },
          {
            key: 'supervisor',
            name: 'Supervisor',
            description: '',
            permissions: { tables: {}, export: true },
          },
          {
            key: 'gerencia',
            name: 'Gerencia',
            description: '',
            permissions: { tables: {}, export: false },
          },
        ],
      } as never,
      ctx(ADMIN),
    );
    expect(res.app.name).toBe('Planta Norte');
    expect(fake.tables.custom_apps?.[0]?.home_screen).toBe('mis_registros');
    const operario = fake.tables.custom_app_roles?.find((r) => r.key === 'operario');
    expect(
      (operario?.permissions as { tables: { guias: { edit: string } } }).tables.guias.edit,
    ).toBe('none');
  });

  it('una pantalla con una tabla que no existe se rechaza ANTES de escribir', async () => {
    const { ctx, fake } = world();
    const spec = { ...(CONTROL_EN_PLANTA.screens[1]?.spec as object) } as {
      blocks: Array<{ tracker?: string }>;
    };
    spec.blocks = spec.blocks.map((b) => ('tracker' in b ? { ...b, tracker: 'no_existe' } : b));
    await expect(
      appsUpdate.handler(
        { app: 'planta', updateScreens: [{ slug: 'mis_registros', spec }] } as never,
        ctx(ADMIN),
      ),
    ).rejects.toThrow();
    expect(fake.tables.custom_views?.find((v) => v.id === 'view-mis_registros')?.version).toBe(1);
  });

  it('nombrar una pantalla que no existe, o una de inicio inexistente, es un error claro', async () => {
    const { ctx } = world();
    await expect(
      appsUpdate.handler({ app: 'planta', removeScreens: ['fantasma'] } as never, ctx(ADMIN)),
    ).rejects.toThrow(/fantasma/);
    await expect(
      appsUpdate.handler({ app: 'planta', homeScreen: 'fantasma' } as never, ctx(ADMIN)),
    ).rejects.toThrow(/fantasma/);
  });

  it('no deja quitar un rol que tiene usuarios externos', async () => {
    const { ctx, db } = world();
    await appsInviteUsers.handler(
      {
        app: 'planta',
        users: [{ name: 'Ana', email: 'ana@x.co', roleKey: 'operario' }],
        send: false,
      },
      ctx(ADMIN),
    );
    await expect(
      appsUpdate.handler(
        {
          app: 'planta',
          roles: [
            {
              key: 'supervisor',
              name: 'Supervisor',
              description: '',
              permissions: { tables: {}, export: true },
            },
          ],
        } as never,
        ctx(ADMIN),
      ),
    ).rejects.toThrow(/usuarios externos/);
    expect(((await db.from('custom_app_roles').select('key')).data ?? []).length).toBe(3);
  });

  it('exige algo que cambiar', () => {
    expect(appsUpdate.inputSchema.safeParse({ app: 'planta' }).success).toBe(false);
  });
});

describe('apps.publish', () => {
  it('publica y despublica', async () => {
    const { ctx, fake } = world();
    await appsPublish.handler({ app: 'planta', publish: true }, ctx(ADMIN));
    expect(fake.tables.custom_apps?.[0]?.status).toBe('published');
    await appsPublish.handler({ app: 'planta', publish: false }, ctx(ADMIN));
    expect(fake.tables.custom_apps?.[0]?.status).toBe('draft');
  });
});

describe('apps.delete', () => {
  it('borra la app con sus pantallas-vista; sólo owner/admin; los datos no se tocan', async () => {
    const { ctx, fake } = world();
    await expect(appsDelete.handler({ app: 'planta' }, ctx(OPERARIO))).rejects.toThrow();
    expect(fake.tables.custom_apps?.length).toBe(1);
    const out = await appsDelete.handler({ app: 'planta' }, ctx(ADMIN));
    expect(out.deleted).toBe(true);
    expect(fake.tables.custom_apps?.length).toBe(0);
    expect(fake.tables.custom_views?.length).toBe(0);
    expect(fake.tables.trackers?.length).toBe(1);
  });
  it('pide confirmación', () => {
    expect(appsDelete.requiresConfirmation).toBe(true);
  });
});

describe('views.delete (deleteView)', () => {
  it('se niega a borrar una vista que es pantalla de una app y dice cuál', async () => {
    const { db, fake } = world();
    const id = String(fake.tables.custom_views?.[0]?.id);
    await expect(deleteView(db, id)).rejects.toThrow(/Control en planta/);
    expect(fake.tables.custom_views?.length).toBeGreaterThan(0);
  });
});

describe('apps.assign_members', () => {
  it('asigna por correo o nombre, y si una persona no existe no se escribe nada', async () => {
    const { ctx, fake } = world();
    await expect(
      appsAssignMembers.handler(
        {
          app: 'planta',
          assign: [
            { person: 'olga@postal.co', roleKey: 'operario' },
            { person: 'nadie@postal.co', roleKey: 'operario' },
          ],
          remove: [],
        },
        ctx(ADMIN),
      ),
    ).rejects.toThrow(/nadie@postal.co/);
    expect(fake.tables.custom_app_members).toHaveLength(0);
    const ok = await appsAssignMembers.handler(
      {
        app: 'planta',
        assign: [
          { person: 'Olga Operaria', roleKey: 'operario', attributes: { cliente: 'Andina' } },
        ],
        remove: [],
      },
      ctx(ADMIN),
    );
    expect(ok.assigned).toBe(1);
    expect(fake.tables.custom_app_members?.[0]).toMatchObject({
      user_id: OPERARIO,
      role_key: 'operario',
      attributes: { cliente: 'Andina' },
    });
    await expect(
      appsAssignMembers.handler(
        { app: 'planta', assign: [{ person: 'olga@postal.co', roleKey: 'inventado' }], remove: [] },
        ctx(ADMIN),
      ),
    ).rejects.toThrow(/no tiene el rol/);
  });
});

describe('apps.invite_users', () => {
  it('invita, manda el correo con la función del contexto y reporta lo que falla', async () => {
    const { ctx, fake } = world();
    const send = vi.fn(async (input: { appId: string; userIds: string[] }) => ({
      sent: input.userIds.length,
      failed: [],
    }));
    const res = await appsInviteUsers.handler(
      {
        app: 'planta',
        users: [
          {
            name: 'Ana',
            email: 'ANA@x.co',
            roleKey: 'operario',
            attributes: { cliente: 'Andina' },
          },
          { name: 'Mala', email: 'sin-arroba', roleKey: 'operario' },
          { name: 'Rol', email: 'rol@x.co', roleKey: 'inventado' },
        ],
        send: true,
      },
      ctx(ADMIN, { sendAppInvitations: send }),
    );
    expect(res.invited).toBe(1);
    expect(res.emailed).toBe(1);
    expect(res.notes).toHaveLength(2);
    expect(send).toHaveBeenCalledWith({
      appId: APP_ID,
      userIds: [fake.tables.custom_app_users?.[0]?.id],
    });
    expect(fake.tables.custom_app_users?.[0]).toMatchObject({
      email: 'ana@x.co',
      status: 'invited',
      attributes: { cliente: 'Andina' },
    });
  });

  it('sin la función de correo deja a la gente en la lista y lo dice', async () => {
    const { ctx, fake } = world();
    const res = await appsInviteUsers.handler(
      {
        app: 'planta',
        users: [{ name: 'Ana', email: 'ana@x.co', roleKey: 'operario' }],
        send: true,
      },
      ctx(ADMIN),
    );
    expect(res.emailed).toBe(0);
    expect(res.notes.join(' ')).toMatch(/Usuarios/);
    expect(fake.tables.custom_app_users).toHaveLength(1);
  });
});
