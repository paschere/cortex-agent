import { describe, expect, it } from 'vitest';
import { createFakeSupabase } from '../../../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../../tenancy/scoped-client';
import type { ToolContext } from '../../../types';
import { CONTROL_EN_PLANTA } from '../../templates';
import {
  appsAutomationsCreate,
  appsAutomationsList,
  appsAutomationsPause,
  appsAutomationsUpdate,
} from '../tools';

/**
 * LAS HERRAMIENTAS DEL CHAT PARA AUTOMATIZACIONES: sólo quien administra la
 * empresa, validación contra la app real, y pausar no borra nada.
 */

const ORG = 'org-postal';
const ADMIN = 'u-admin';
const MEMBER = 'u-member';
const APP_ID = '11111111-1111-4111-8111-111111111111';

function world() {
  const fake = createFakeSupabase({
    users: [
      {
        id: ADMIN,
        organization_id: ORG,
        name: 'Admin',
        email: 'a@p.co',
        role: 'org_admin',
        created_at: '2026-10-01T00:00:00Z',
      },
      {
        id: MEMBER,
        organization_id: ORG,
        name: 'Mia',
        email: 'm@p.co',
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
        fields: CONTROL_EN_PLANTA.trackers[0]?.fields ?? [],
        duplicates: null,
        created_by: null,
        created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-01T00:00:00Z',
      },
    ],
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
        status: 'published',
        version: 1,
        created_by: null,
        updated_by: null,
        created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-01T00:00:00Z',
        archived_at: null,
      },
    ],
    custom_app_screens: [],
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
    custom_app_automations: [],
    custom_app_automation_runs: [],
  });
  const db = createOrgScopedClient(fake.client, ORG);
  const ctx = (userId: string) =>
    ({
      db,
      userId,
      organizationId: ORG,
      agentId: 'a',
      logger: console,
      integrations: {},
    }) as unknown as ToolContext;
  return { fake, ctx };
}

describe('apps.automations.*', () => {
  it('un miembro cualquiera no ve ni cambia nada', async () => {
    const { ctx, fake } = world();
    const c = ctx(MEMBER);
    await expect(appsAutomationsList.handler({ app: 'planta' }, c)).rejects.toThrow(/administra/);
    await expect(
      appsAutomationsCreate.handler(
        {
          app: 'planta',
          template: { id: 'rejected_to_operator', tracker: 'guias' },
          conditions: [],
        } as never,
        c,
      ),
    ).rejects.toThrow(/administra/);
    expect(fake.tables.custom_app_automations).toHaveLength(0);
  });

  it('crea desde una plantilla, lista, cambia y pausa', async () => {
    const { ctx, fake } = world();
    const c = ctx(ADMIN);
    const created = await appsAutomationsCreate.handler(
      {
        app: 'planta',
        template: { id: 'duplicate_to_supervisor', tracker: 'guias', role: 'supervisor' },
        conditions: [],
      } as never,
      c,
    );
    expect(created.markdown).toContain('Avisar al supervisor');
    const row = fake.tables.custom_app_automations?.[0];
    expect(row).toMatchObject({
      tracker_id: 'trk',
      trigger_kind: 'row_flagged_duplicate',
      enabled: true,
    });

    const listed = await appsAutomationsList.handler({ app: 'planta' }, c);
    expect(listed.automations).toHaveLength(1);
    expect(listed.templates.length).toBe(4);

    await appsAutomationsUpdate.handler(
      { app: 'planta', id: created.id, name: 'Duplicados al supervisor' },
      c,
    );
    expect(fake.tables.custom_app_automations?.[0]?.name).toBe('Duplicados al supervisor');

    const paused = await appsAutomationsPause.handler(
      { app: 'planta', id: created.id, paused: true },
      c,
    );
    expect(paused.enabled).toBe(false);
    expect(fake.tables.custom_app_automations?.[0]?.enabled).toBe(false);
    const resumed = await appsAutomationsPause.handler(
      { app: 'planta', id: created.id, paused: false },
      c,
    );
    expect(resumed.enabled).toBe(true);
  });

  it('valida contra la app: un rol que no existe se rechaza y no se guarda', async () => {
    const { ctx, fake } = world();
    await expect(
      appsAutomationsCreate.handler(
        {
          app: 'planta',
          template: { id: 'duplicate_to_supervisor', tracker: 'guias', role: 'fantasma' },
          conditions: [],
        } as never,
        ctx(ADMIN),
      ),
    ).rejects.toThrow(/fantasma/);
    expect(fake.tables.custom_app_automations).toHaveLength(0);
  });

  it('exige confirmación en las que cambian y no en la lectura', () => {
    expect(appsAutomationsList.requiresConfirmation).toBeFalsy();
    for (const t of [appsAutomationsCreate, appsAutomationsUpdate, appsAutomationsPause])
      expect(t.requiresConfirmation).toBe(true);
  });
});
