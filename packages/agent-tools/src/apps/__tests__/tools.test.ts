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
  appsGeofences,
  appsGet,
  appsInviteUsers,
  appsPublish,
  appsRestoreVersion,
  appsUpdate,
  appsVersions,
} from '../tools';
import { appsInspect } from '../inspect';
import { previewAppForm, resolveAppAccess, screenView, undoAppRowChange } from '../store';

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

describe('apps.geofences', () => {
  it('agrega, cambia y quita lugares; sólo owner/admin; pide confirmación', async () => {
    const { ctx, fake } = world();
    expect(appsGeofences.requiresConfirmation).toBe(true);
    await expect(
      appsGeofences.handler(
        { app: 'planta', add: [{ name: 'Bodega Norte', lat: 4.7, lng: -74.05 }] },
        ctx(OPERARIO),
      ),
    ).rejects.toThrow();
    const out = await appsGeofences.handler(
      {
        app: 'planta',
        add: [
          { name: 'Bodega Norte', lat: 4.7, lng: -74.05, radiusM: 200, notifyAdmins: true },
          { name: 'Bodega Norte', lat: 4.8, lng: -74.0 },
        ],
      },
      ctx(ADMIN),
    );
    // Dos con el mismo nombre no chocan: el segundo recibe otro id.
    expect(out.geofences.map((g) => g.id)).toEqual(['bodega_norte', 'bodega_norte_2']);
    expect(out.geofences[0]).toMatchObject({ radiusM: 200, notifyAdmins: true, on: 'both' });
    const stored = fake.tables.custom_apps?.[0]?.location as { geofences: unknown[] };
    expect(stored.geofences).toHaveLength(2);

    const changed = await appsGeofences.handler(
      {
        app: 'planta',
        update: [{ id: 'bodega_norte', radiusM: 90, on: 'enter' }],
        remove: ['bodega_norte_2'],
      },
      ctx(ADMIN),
    );
    expect(changed.geofences).toHaveLength(1);
    expect(changed.geofences[0]).toMatchObject({ radiusM: 90, on: 'enter' });
    expect(changed.markdown).toMatch(/apagada/);
  });

  it('rechaza un rol que no existe, un lugar que no existe y coordenadas imposibles', async () => {
    const { ctx } = world();
    await expect(
      appsGeofences.handler(
        {
          app: 'planta',
          add: [{ name: 'X lugar', lat: 4.7, lng: -74.05, notifyRoles: ['fantasma'] }],
        },
        ctx(ADMIN),
      ),
    ).rejects.toThrow(/fantasma/);
    await expect(
      appsGeofences.handler({ app: 'planta', remove: ['nada'] }, ctx(ADMIN)),
    ).rejects.toThrow(/No hay un lugar/);
    expect(
      appsGeofences.inputSchema.safeParse({
        app: 'planta',
        add: [{ name: 'Lejos', lat: 120, lng: 0 }],
      }).success,
    ).toBe(false);
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

describe('apps.inspect (Cortex se autoverifica)', () => {
  it('es de sólo lectura, sólo de owner/admin, y revisa un rol o todos', async () => {
    const { ctx, fake } = world();
    expect(appsInspect.requiresConfirmation).toBeFalsy();
    await expect(
      appsInspect.handler({ app: 'planta', role: 'operario', version: 'draft' }, ctx(OPERARIO)),
    ).rejects.toThrow();
    const mine = () =>
      JSON.stringify([
        fake.tables.custom_apps,
        fake.tables.custom_app_screens,
        fake.tables.custom_views,
        fake.tables.custom_app_roles,
        fake.tables.tracker_rows,
      ]);
    const before = mine();
    const one = await appsInspect.handler(
      { app: 'planta', role: 'operario', version: 'draft', expect: ['campo_que_no_existe'] },
      ctx(ADMIN),
    );
    expect(one.reports).toHaveLength(1);
    expect(one.missing).toEqual(['campo_que_no_existe']);
    expect(one.ok).toBe(false);
    expect(one.markdown).toMatch(/NO está listo/);
    expect(one.markdown).toMatch(/vista como \*\*Operario\*\*/);
    const all = await appsInspect.handler({ app: 'planta', version: 'draft' }, ctx(ADMIN));
    expect(all.reports.length).toBeGreaterThan(1);
    const none = await appsInspect.handler(
      { app: 'planta', role: 'no_existe', version: 'draft' },
      ctx(ADMIN),
    );
    expect(none.ok).toBe(false);
    expect(none.problems.join(' ')).toMatch(/no tiene un rol/);
    expect(mine()).toBe(before);
  });
});

describe('apps.versions y apps.restore_version', () => {
  it('lista y compara sin pedir confirmación; volver atrás sí la pide y devuelve lo que cambió', async () => {
    const { ctx } = world();
    expect(appsVersions.requiresConfirmation).toBeFalsy();
    expect(appsRestoreVersion.requiresConfirmation).toBe(true);
    await appsPublish.handler({ app: 'planta', publish: true, note: 'primera' }, ctx(ADMIN));
    await appsUpdate.handler({ app: 'planta', name: 'Planta Norte' }, ctx(ADMIN));
    await appsPublish.handler({ app: 'planta', publish: true, note: 'segunda' }, ctx(ADMIN));
    const list = await appsVersions.handler({ app: 'planta' }, ctx(ADMIN));
    expect(list.markdown).toMatch(/v2 \(publicada\)/);
    const cmp = await appsVersions.handler(
      { app: 'planta', compare: { from: 1, to: 2 } },
      ctx(ADMIN),
    );
    expect(cmp.changes?.join(' ')).toMatch(/Nombre: «Control en planta» → «Planta Norte»/);
    await expect(
      appsRestoreVersion.handler({ app: 'planta', version: 1, publish: false }, ctx(OPERARIO)),
    ).rejects.toThrow();
    const back = await appsRestoreVersion.handler(
      { app: 'planta', version: 1, publish: false },
      ctx(ADMIN),
    );
    expect(back.app.name).toBe('Control en planta');
    expect(back.markdown).toMatch(/Devolví/);
    await expect(
      appsRestoreVersion.handler({ app: 'planta', version: 9, publish: false }, ctx(ADMIN)),
    ).rejects.toThrow();
  });
});

describe('«Deshacer este cambio» del historial de un registro', () => {
  const ROW = '33333333-3333-4333-8333-333333333333';
  const EVENT = '44444444-4444-4444-8444-444444444444';

  function seeded() {
    const w = world();
    (w.fake.tables.tracker_rows as unknown[]).push({
      id: ROW,
      organization_id: ORG,
      tracker_id: 'trk',
      label: 'A-1',
      values: { numero_guia: 'A-1', fecha: '2026-10-05', ubicacion: 'Muelle 3' },
      created_by: ADMIN,
      created_by_app_user: null,
      created_at: '2026-10-05T10:00:00Z',
      updated_at: '2026-10-05T10:00:00Z',
    });
    (w.fake.tables.custom_view_events ??= []).push({
      id: EVENT,
      organization_id: ORG,
      view_id: 'view-registrar',
      block_id: 'registrar',
      kind: 'edit',
      action_id: null,
      tracker_row_id: ROW,
      changes: { ubicacion: { from: 'Muelle 1', to: 'Muelle 3' } },
      actor: ADMIN,
      actor_kind: 'member',
      created_at: '2026-10-06T10:00:00Z',
    });
    return w;
  }

  async function enterAs(w: ReturnType<typeof world>, role: string) {
    const app = await resolveAppAccess(
      w.ctx(ADMIN).db,
      'planta',
      { id: ADMIN, name: 'Admin', companyAdmin: true },
      role === 'administrador' ? {} : { preview: { roleKey: role } },
    );
    if (!app) throw new Error('sin acceso');
    const screen = app.screens.find((s) => s.slug === 'registrar');
    if (!screen) throw new Error('sin pantalla');
    return { access: app, view: await screenView(w.ctx(ADMIN).db, screen), db: w.ctx(ADMIN).db };
  }

  it('vuelve el campo a su valor de antes y deja el cambio de vuelta en la historia', async () => {
    const w = seeded();
    const { access, view, db } = await enterAs(w, 'administrador');
    const res = await undoAppRowChange(db, access, view, {
      blockId: 'registrar',
      rowId: ROW,
      entryId: EVENT,
    });
    expect(res.applied).toEqual(['ubicacion']);
    const row = (w.fake.tables.tracker_rows as Array<{ id: string; values: Record<string, string> }>).find(
      (r) => r.id === ROW,
    );
    expect(row?.values.ubicacion).toBe('Muelle 1');
    const events = w.fake.tables.custom_view_events as Array<{ action_id: string | null }>;
    expect(events.some((e) => e.action_id === '__undo')).toBe(true);
    // Un segundo intento ya no encuentra el campo como el cambio lo dejó.
    await expect(
      undoAppRowChange(db, access, view, { blockId: 'registrar', rowId: ROW, entryId: EVENT }),
    ).rejects.toThrow(/ya estaba deshecho/);
  });

  it('no pisa lo que alguien cambió después', async () => {
    const w = seeded();
    const rows = w.fake.tables.tracker_rows as Array<{ id: string; values: Record<string, string> }>;
    const r = rows.find((x) => x.id === ROW);
    if (r) r.values.ubicacion = 'Muelle 9';
    const { access, view, db } = await enterAs(w, 'administrador');
    await expect(
      undoAppRowChange(db, access, view, { blockId: 'registrar', rowId: ROW, entryId: EVENT }),
    ).rejects.toThrow(/cambió otra vez después/);
    expect(r?.values.ubicacion).toBe('Muelle 9');
  });

  it('un rol que no edita la tabla no deshace nada', async () => {
    const w = seeded();
    const { access, view, db } = await enterAs(w, 'gerencia');
    await expect(
      undoAppRowChange(db, access, view, { blockId: 'registrar', rowId: ROW, entryId: EVENT }),
    ).rejects.toThrow(/no edita esta tabla/);
  });

  it('lo hecho desde el chat sólo lo deshace quien administra', async () => {
    const w = seeded();
    const { access, view, db } = await enterAs(w, 'supervisor');
    await expect(
      undoAppRowChange(db, access, view, {
        blockId: 'registrar',
        rowId: ROW,
        entryId: 'audit:55555555-5555-4555-8555-555555555555',
      }),
    ).rejects.toThrow(/quien administra/);
  });
});

describe('«Ver como…» en modo prueba: el formulario se valida y no escribe', () => {
  async function enter(role: string) {
    const w = world();
    const db = w.ctx(ADMIN).db;
    const access = await resolveAppAccess(
      db,
      'planta',
      { id: ADMIN, name: 'Admin', companyAdmin: true },
      { preview: { roleKey: role } },
    );
    if (!access) throw new Error('sin acceso');
    const screen = access.screens.find((s) => s.slug === 'registrar');
    if (!screen) throw new Error('sin pantalla');
    return { w, access, view: await screenView(db, screen), db };
  }

  it('devuelve la fila tal como se guardaría y no escribe nada', async () => {
    const { w, access, view, db } = await enter('operario');
    const out = await previewAppForm(db, access, view, {
      blockId: 'registrar',
      values: { numero_guia: 'Z-1', fecha: '2026-10-05', ubicacion: 'Muelle 3' },
    });
    expect(out.values).toMatchObject({ numero_guia: 'Z-1', ubicacion: 'Muelle 3' });
    expect(out.values.estado).toBe('Pendiente');
    expect(w.fake.tables.tracker_rows).toHaveLength(0);
    expect(w.fake.tables.custom_view_submissions ?? []).toHaveLength(0);
    expect(w.fake.tables.custom_view_events ?? []).toHaveLength(0);
  });

  it('rechaza con el mismo texto de verdad: campo obligatorio, campo fuera del rol, rol que no registra', async () => {
    const op = await enter('operario');
    await expect(
      previewAppForm(op.db, op.access, op.view, {
        blockId: 'registrar',
        values: { fecha: '2026-10-05' },
      }),
    ).rejects.toThrow(/Falta/);
    await expect(
      previewAppForm(op.db, op.access, op.view, {
        blockId: 'registrar',
        values: { numero_guia: 'Z-2', fecha: '2026-10-05', motivo_rechazo: 'x' },
      }),
    ).rejects.toThrow(/no puede escribir/);
    const ger = await enter('gerencia');
    await expect(
      previewAppForm(ger.db, ger.access, ger.view, {
        blockId: 'registrar',
        values: { numero_guia: 'Z-3', fecha: '2026-10-05' },
      }),
    ).rejects.toThrow(/no registra en esta tabla/);
  });
});
