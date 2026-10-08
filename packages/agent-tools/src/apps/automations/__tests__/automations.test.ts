import { describe, expect, it } from 'vitest';
import { createFakeSupabase } from '../../../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../../tenancy/scoped-client';
import { upsertRow } from '../../../trackers/store';
import { getTrackerBySlug } from '../../../trackers/store';
import { CONTROL_EN_PLANTA } from '../../templates';
import { emitAutomationEvent, forgetAutomationWatch, withAutomationOrigin } from '../emit';
import { type AutomationDeps, executeRun, fireButton, signWebhook, webhookSecretFor } from '../run';
import { adaptAutomation, validateAutomation } from '../store';

/**
 * LAS AUTOMATIZACIONES CONTRA UNA BASE CON DOS EMPRESAS.
 *
 * Mismo fixture adverso que apps/__tests__/isolation.test.ts: las dos empresas
 * tienen una app «planta», una tabla «guias», una regla que mira esa tabla y
 * un rol «supervisor» con usuarios. Una consulta que perdiera el filtro de
 * empresa o de app avisaría a alguien que no es: aquí se comprueba que no.
 */

const A = 'org-a';
const B = 'org-b';
const fields = CONTROL_EN_PLANTA.trackers[0]?.fields ?? [];
const NOW = new Date('2026-10-07T15:00:00.000Z');

function seed() {
  const tracker = (org: string, id: string) => ({
    id,
    organization_id: org,
    slug: 'guias',
    name: 'Guías',
    description: '',
    fields,
    duplicates: {
      key: 'numero_guia',
      distinctBy: 'fecha',
      flagField: 'estado',
      flagValue: 'Duplicada',
    },
    created_by: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
  });
  const app = (org: string, id: string, status = 'published') => ({
    id,
    organization_id: org,
    slug: 'planta',
    name: 'Control en planta',
    icon: '🏭',
    status,
    archived_at: null,
  });
  const auto = (org: string, id: string, appId: string, trackerId: string, extra = {}) => ({
    id,
    organization_id: org,
    app_id: appId,
    name: 'Avisar al supervisor',
    enabled: true,
    trigger: { type: 'row_flagged_duplicate', tracker: 'guias' },
    conditions: [],
    actions: [
      { type: 'notify_app_user', to: { role: 'supervisor' }, title: 'Duplicado: {{nombre}}' },
    ],
    tracker_id: trackerId,
    trigger_kind: 'row_flagged_duplicate',
    created_by: 'u-admin',
    ...extra,
  });
  const user = (
    org: string,
    appId: string,
    id: string,
    email: string,
    role = 'supervisor',
    status = 'active',
  ) => ({
    id,
    organization_id: org,
    app_id: appId,
    name: id,
    email,
    role_key: role,
    attributes: {},
    status,
  });
  return {
    trackers: [tracker(A, 't-a'), tracker(B, 't-b')],
    custom_apps: [app(A, 'app-a'), app(B, 'app-b'), app(A, 'app-draft', 'draft')],
    custom_app_screens: [],
    custom_app_roles: [],
    custom_app_automations: [auto(A, 'auto-a', 'app-a', 't-a'), auto(B, 'auto-b', 'app-b', 't-b')],
    custom_app_automation_runs: [] as Array<Record<string, unknown>>,
    custom_app_users: [
      user(A, 'app-a', 'sup-1', 'sup1@a.co'),
      user(A, 'app-a', 'sup-2', 'sup2@a.co'),
      user(A, 'app-a', 'op-1', 'op1@a.co', 'operario'),
      user(A, 'app-a', 'sup-off', 'off@a.co', 'supervisor', 'disabled'),
      user(B, 'app-b', 'sup-b', 'sup@b.co'),
    ],
    custom_app_members: [],
    tracker_rows: [] as Array<Record<string, unknown>>,
    users: [{ id: 'u-admin', organization_id: A, role: 'org_admin', email: 'admin@a.co' }],
    custom_view_events: [],
    custom_view_submissions: [],
  };
}

function setup(extra: Record<string, unknown[]> = {}) {
  const tables = { ...seed(), ...extra } as Record<string, Array<Record<string, unknown>>>;
  const fake = createFakeSupabase(tables);
  forgetAutomationWatch();
  return {
    tables,
    a: createOrgScopedClient(fake.client, A),
    b: createOrgScopedClient(fake.client, B),
  };
}

interface Calls {
  push: Array<{ appId: string; users: string[] }>;
  mail: Array<{ to: string; subject: string; text: string }>;
  bell: Array<{ users: string[]; title: string }>;
  ask: string[];
}

function deps(
  over: Partial<AutomationDeps> = {},
  pushTo: string[] = [],
): { d: AutomationDeps; calls: Calls } {
  const calls: Calls = { push: [], mail: [], bell: [], ask: [] };
  const d: AutomationDeps = {
    now: () => NOW,
    baseUrl: 'https://cortex.test',
    signingSecret: 'secreto-de-prueba',
    sendEmail: async (m) => {
      calls.mail.push(m);
      return { sent: true };
    },
    notifyMembers: async (_db, users, n) => {
      calls.bell.push({ users, title: n.title });
      return users.length;
    },
    pushAppUsers: async (_db, appId, users) => {
      calls.push.push({ appId, users });
      return users.filter((u) => pushTo.includes(u));
    },
    askCortex: async (_db, a) => {
      calls.ask.push(a.instruction);
      return { summary: 'listo', staged: 0 };
    },
    ...over,
  };
  return { d, calls };
}

const baseEvent = (over: Record<string, unknown> = {}) => ({
  kind: 'row_flagged_duplicate',
  trackerId: 't-a',
  rowId: 'row-1',
  after: { numero_guia: '045', fecha: '2026-10-05', estado: 'Duplicada' },
  label: '045',
  version: 'v1',
  actor: { kind: 'system' },
  chain: [],
  depth: 0,
  ...over,
});

function queuedRun(
  automationId: string,
  appId: string,
  org: string,
  over: Record<string, unknown> = {},
) {
  return {
    id: `run-${Math.random().toString(36).slice(2)}`,
    organization_id: org,
    app_id: appId,
    automation_id: automationId,
    trigger_ref: 'row:row-1',
    status: 'queued',
    attempts: 0,
    next_attempt_at: NOW.toISOString(),
    event: baseEvent(),
    result: [],
    error: null as string | null,
    ask_cortex_calls: 0,
    idempotency_key: `${automationId}:k:${Math.random()}`,
    created_at: NOW.toISOString(),
    ...over,
  };
}

describe('emisión de eventos', () => {
  it('sin reglas que miren la tabla no se escribe nada', async () => {
    const { a, tables } = setup();
    tables.custom_app_automations = [];
    const n = await emitAutomationEvent(a, {
      kind: 'row_created',
      trackerId: 't-a',
      rowId: 'r1',
      after: {},
      actor: { kind: 'member', id: 'u' },
    });
    expect(n).toBe(0);
    expect(tables.custom_app_automation_runs).toHaveLength(0);
  });

  it('la regla de la empresa A se encola sólo en A; la de B queda intacta', async () => {
    const { a, tables } = setup();
    const n = await emitAutomationEvent(a, {
      kind: 'row_flagged_duplicate',
      trackerId: 't-a',
      rowId: 'row-1',
      after: { numero_guia: '045' },
      actor: { kind: 'system' },
      version: 'v1',
    });
    expect(n).toBe(1);
    const runs = tables.custom_app_automation_runs ?? [];
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      automation_id: 'auto-a',
      organization_id: A,
      status: 'queued',
    });
    // un evento con el id de la tabla de B emitido desde A no encuentra nada
    expect(
      await emitAutomationEvent(a, {
        kind: 'row_flagged_duplicate',
        trackerId: 't-b',
        rowId: 'x',
        after: {},
        actor: { kind: 'system' },
      }),
    ).toBe(0);
  });

  it('idempotencia: el mismo suceso emitido dos veces deja UNA corrida', async () => {
    const { a, tables } = setup();
    const input = {
      kind: 'row_flagged_duplicate' as const,
      trackerId: 't-a',
      rowId: 'row-1',
      after: {},
      actor: { kind: 'system' as const },
      version: 'misma',
    };
    expect(await emitAutomationEvent(a, input)).toBe(1);
    expect(await emitAutomationEvent(a, input)).toBe(0);
    expect(tables.custom_app_automation_runs).toHaveLength(1);
    // otra versión del suceso sí es otra corrida
    expect(await emitAutomationEvent(a, { ...input, version: 'otra' })).toBe(1);
  });

  it('sin bucles: lo que escribe una regla no la vuelve a disparar, ni pasa de profundidad 3', async () => {
    const { a, tables } = setup();
    const input = {
      kind: 'row_flagged_duplicate' as const,
      trackerId: 't-a',
      rowId: 'row-1',
      after: {},
      actor: { kind: 'system' as const },
    };
    const inChain = await withAutomationOrigin({ chain: ['auto-a'], depth: 1 }, () =>
      emitAutomationEvent(a, { ...input, version: 'x1' }),
    );
    expect(inChain).toBe(0);
    const tooDeep = await withAutomationOrigin(
      { chain: ['otra1', 'otra2', 'otra3'], depth: 3 },
      () => emitAutomationEvent(a, { ...input, version: 'x2' }),
    );
    expect(tooDeep).toBe(0);
    // una cadena corta de OTRA regla sí corre
    const ok = await withAutomationOrigin({ chain: ['otra'], depth: 1 }, () =>
      emitAutomationEvent(a, { ...input, version: 'x3' }),
    );
    expect(ok).toBe(1);
    expect(tables.custom_app_automation_runs).toHaveLength(1);
  });

  it('una regla pausada no se encola', async () => {
    const { a, tables } = setup();
    const rule = (tables.custom_app_automations ?? []).find((r) => r.id === 'auto-a');
    if (rule) rule.enabled = false;
    expect(
      await emitAutomationEvent(a, {
        kind: 'row_flagged_duplicate',
        trackerId: 't-a',
        rowId: 'r',
        after: {},
        actor: { kind: 'system' },
      }),
    ).toBe(0);
  });

  it('upsertRow emite row_created y, al repetir la guía con otra fecha, row_flagged_duplicate', async () => {
    const { a, tables } = setup();
    // una regla de «se crea una fila» en A además de la del duplicado
    (tables.custom_app_automations ?? []).push({
      id: 'auto-created',
      organization_id: A,
      app_id: 'app-a',
      name: 'Nueva guía',
      enabled: true,
      trigger: { type: 'row_created', tracker: 'guias' },
      conditions: [],
      actions: [{ type: 'email', to: ['g@a.co'], roles: [], subject: 's', body: 'b' }],
      tracker_id: 't-a',
      trigger_kind: 'row_created',
    });
    forgetAutomationWatch();
    const tracker = await getTrackerBySlug(a, 'guias');
    if (!tracker) throw new Error('sin tabla');
    await upsertRow(a, {
      tracker,
      values: { numero_guia: '045-1', fecha: '2026-10-01' },
      userId: 'u-admin',
    });
    await upsertRow(a, {
      tracker,
      values: { numero_guia: '045-1', fecha: '2026-10-03' },
      userId: 'u-admin',
    });
    const kinds = (tables.custom_app_automation_runs ?? []).map((r) => r.trigger_ref as string);
    expect(kinds.filter((k) => k.startsWith('row_created')).length).toBe(2);
    expect(kinds.some((k) => k.startsWith('row_flagged_duplicate'))).toBe(true);
  });
});

describe('la corrida', () => {
  it('notify_app_user: push a quien lo tiene, correo a quien no; sólo usuarios de ESA app y activos', async () => {
    const { a, tables } = setup();
    const run = queuedRun('auto-a', 'app-a', A);
    (tables.custom_app_automation_runs ?? []).push(run);
    const { d, calls } = deps({}, ['sup-1']);
    const out = await executeRun(a, run.id as string, A, d);
    expect(out.status).toBe('succeeded');
    // el push se intentó para los dos supervisores activos de A (ni el desactivado, ni el de B, ni el operario)
    expect(calls.push).toEqual([
      { appId: 'app-a', users: expect.arrayContaining(['sup-1', 'sup-2']) },
    ]);
    expect(calls.push[0]?.users).toHaveLength(2);
    // sup-2 no tenía push: correo (y sólo a él)
    expect(calls.mail.map((m) => m.to)).toEqual(['sup2@a.co']);
    expect(calls.mail[0]?.subject).toBe('Duplicado: 045');
    expect(JSON.stringify(calls)).not.toContain('b.co');
  });

  it('sin llaves de push (nadie recibe push) todo cae a correo', async () => {
    const { a, tables } = setup();
    const run = queuedRun('auto-a', 'app-a', A);
    (tables.custom_app_automation_runs ?? []).push(run);
    const { d, calls } = deps({}, []);
    await executeRun(a, run.id as string, A, d);
    expect(calls.mail.map((m) => m.to).sort()).toEqual(['sup1@a.co', 'sup2@a.co']);
  });

  it('una corrida de la empresa B no se puede reclamar con el handle de A', async () => {
    const { a, b, tables } = setup();
    const run = queuedRun('auto-b', 'app-b', B, { event: baseEvent({ trackerId: 't-b' }) });
    (tables.custom_app_automation_runs ?? []).push(run);
    const { d, calls } = deps();
    expect((await executeRun(a, run.id as string, A, d)).status).toBe('not_claimable');
    expect(calls.mail).toHaveLength(0);
    expect((await executeRun(b, run.id as string, B, d)).status).toBe('succeeded');
    expect(calls.mail.map((m) => m.to)).toEqual(['sup@b.co']);
  });

  it('pausada, app sin publicar o condición que no se cumple: no hace nada y lo dice', async () => {
    const { a, tables } = setup();
    const auto = (tables.custom_app_automations ?? []).find((r) => r.id === 'auto-a');
    if (!auto) throw new Error('sin regla');
    const { d, calls } = deps();

    auto.enabled = false;
    const r1 = queuedRun('auto-a', 'app-a', A);
    (tables.custom_app_automation_runs ?? []).push(r1);
    expect((await executeRun(a, r1.id as string, A, d)).status).toBe('skipped');
    auto.enabled = true;

    auto.app_id = 'app-draft';
    const r2 = queuedRun('auto-a', 'app-draft', A);
    (tables.custom_app_automation_runs ?? []).push(r2);
    expect((await executeRun(a, r2.id as string, A, d)).status).toBe('skipped');
    auto.app_id = 'app-a';

    auto.conditions = [{ field: 'numero_guia', op: 'eq', value: 'otra' }];
    const r3 = queuedRun('auto-a', 'app-a', A);
    (tables.custom_app_automation_runs ?? []).push(r3);
    const out = await executeRun(a, r3.id as string, A, d);
    expect(out.status).toBe('skipped');
    expect(calls.mail).toHaveLength(0);
    expect(r3.status).toBe('skipped');
  });

  it('reintento con espera ante un error transitorio, sin repetir lo que ya salió', async () => {
    const { a, tables } = setup();
    const auto = (tables.custom_app_automations ?? []).find((r) => r.id === 'auto-a');
    if (!auto) throw new Error('sin regla');
    auto.actions = [
      { type: 'email', to: ['uno@a.co'], roles: [], subject: 'primero', body: 'x' },
      { type: 'webhook', url: 'https://ejemplo.com/hook' },
    ];
    const run = queuedRun('auto-a', 'app-a', A);
    (tables.custom_app_automation_runs ?? []).push(run);
    const { d, calls } = deps();
    // el webhook falla por red dos veces… se simula con un envío que lanza
    const flaky = {
      ...d,
      sendEmail: d.sendEmail,
    };
    // Primer intento: la acción 2 (webhook) no puede salir (sin red en la prueba): usamos un destino
    // inalcanzable; sendRequest devuelve error de red/bloqueo. Para controlar la causa se reemplaza
    // la resolución con una acción que lanza un error transitorio vía ask_cortex.
    auto.actions = [
      { type: 'email', to: ['uno@a.co'], roles: [], subject: 'primero', body: 'x' },
      { type: 'ask_cortex', instruction: 'haz algo' },
    ];
    let fail = true;
    const retrying: AutomationDeps = {
      ...flaky,
      askCortex: async () => {
        if (fail) throw new Error('fetch failed');
        return { summary: 'ok', staged: 0 };
      },
    };
    const first = await executeRun(a, run.id as string, A, retrying);
    expect(first.status).toBe('retry');
    expect(run.status).toBe('queued');
    expect(new Date(String(run.next_attempt_at)).getTime()).toBeGreaterThan(NOW.getTime());
    expect(calls.mail).toHaveLength(1);

    // todavía no vence la espera: no se puede reclamar
    expect((await executeRun(a, run.id as string, A, retrying)).status).toBe('not_claimable');

    fail = false;
    const later: AutomationDeps = { ...retrying, now: () => new Date(NOW.getTime() + 2 * 60_000) };
    const second = await executeRun(a, run.id as string, A, later);
    expect(second.status).toBe('succeeded');
    // el correo NO se repitió
    expect(calls.mail).toHaveLength(1);
    expect(run.attempts).toBe(2);
  });

  it('el webhook rechaza http y direcciones privadas sin llegar a la red', async () => {
    const { a, tables } = setup();
    const auto = (tables.custom_app_automations ?? []).find((r) => r.id === 'auto-a');
    if (!auto) throw new Error('sin regla');
    for (const url of [
      'http://ejemplo.com/hook',
      'https://127.0.0.1/hook',
      'https://169.254.169.254/latest/meta-data',
      'https://10.0.0.5/x',
      'https://localhost/x',
    ]) {
      auto.actions = [{ type: 'webhook', url }];
      const run = queuedRun('auto-a', 'app-a', A);
      (tables.custom_app_automation_runs ?? []).push(run);
      const out = await executeRun(a, run.id as string, A, deps().d);
      expect(out.status, url).toBe('failed');
      expect(String(run.error)).toContain('Destino no permitido');
    }
  });

  it('la firma HMAC es verificable con la llave de la regla', () => {
    const secret = webhookSecretFor('maestra', 'auto-a');
    expect(secret).not.toBe(webhookSecretFor('maestra', 'auto-b'));
    const sig = signWebhook(secret, '1760000000', '{"a":1}');
    expect(sig).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(signWebhook(secret, '1760000001', '{"a":1}')).not.toBe(sig);
  });

  it('set_field cambia el campo y NO re-dispara la misma regla; sí a otra distinta', async () => {
    const { a, tables } = setup();
    (tables.tracker_rows ?? []).push({
      id: 'row-1',
      organization_id: A,
      tracker_id: 't-a',
      label: '045',
      values: { numero_guia: '045', fecha: '2026-10-05', estado: 'Pendiente' },
      created_by: 'u-admin',
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    });
    const auto = (tables.custom_app_automations ?? []).find((r) => r.id === 'auto-a');
    if (!auto) throw new Error('sin regla');
    auto.trigger = { type: 'row_updated', tracker: 'guias', field: 'estado' };
    auto.trigger_kind = 'row_updated';
    auto.actions = [{ type: 'set_field', field: 'estado', value: 'Aprobada' }];
    // otra regla distinta que también mira los cambios de estado
    (tables.custom_app_automations ?? []).push({
      ...auto,
      id: 'auto-otra',
      name: 'Otra',
      actions: [{ type: 'email', to: ['x@a.co'], roles: [], subject: 's', body: 'b' }],
    });
    forgetAutomationWatch();
    const run = queuedRun('auto-a', 'app-a', A, {
      event: baseEvent({
        kind: 'row_updated',
        before: { estado: 'Pendiente' },
        after: { numero_guia: '045', estado: 'Pendiente' },
      }),
    });
    (tables.custom_app_automation_runs ?? []).push(run);
    const out = await executeRun(a, run.id as string, A, deps().d);
    expect(out.status).toBe('succeeded');
    const row = (tables.tracker_rows ?? []).find((r) => r.id === 'row-1');
    expect((row?.values as Record<string, unknown>).estado).toBe('Aprobada');
    const created = (tables.custom_app_automation_runs ?? []).filter((r) => r.id !== run.id);
    expect(created.map((r) => r.automation_id)).toEqual(['auto-otra']);
    expect(created[0]?.depth).toBe(1);
  });

  it('create_row crea la fila en otra tabla de la MISMA empresa', async () => {
    const extra = {
      trackers: [
        ...seed().trackers,
        {
          id: 't-a2',
          organization_id: A,
          slug: 'avisos',
          name: 'Avisos',
          description: '',
          fields: [{ key: 'texto', label: 'Texto', type: 'text', required: false }],
          duplicates: null,
          created_by: null,
          created_at: '2026-10-01T00:00:00Z',
          updated_at: '2026-10-01T00:00:00Z',
        },
      ],
    };
    const { a, tables } = setup(extra);
    const auto = (tables.custom_app_automations ?? []).find((r) => r.id === 'auto-a');
    if (!auto) throw new Error('sin regla');
    auto.actions = [
      { type: 'create_row', tracker: 'avisos', values: { texto: 'Guía {{numero_guia}}' } },
    ];
    const run = queuedRun('auto-a', 'app-a', A);
    (tables.custom_app_automation_runs ?? []).push(run);
    expect((await executeRun(a, run.id as string, A, deps().d)).status).toBe('succeeded');
    const rows = (tables.tracker_rows ?? []).filter((r) => r.tracker_id === 't-a2');
    expect(rows).toHaveLength(1);
    expect((rows[0]?.values as Record<string, unknown>).texto).toBe('Guía 045');
  });

  it('el tope diario de la app corta las corridas', async () => {
    const { a, tables } = setup();
    // El tope es de cada app (0212): esta lo baja a 500.
    const appRow = (tables.custom_apps ?? []).find((r) => r.id === 'app-a');
    if (appRow) appRow.automation_limits = { runsPerDay: 500 };
    for (let i = 0; i < 501; i++)
      (tables.custom_app_automation_runs ?? []).push(
        queuedRun('auto-a', 'app-a', A, { status: 'succeeded', next_attempt_at: null }),
      );
    const run = queuedRun('auto-a', 'app-a', A);
    (tables.custom_app_automation_runs ?? []).push(run);
    const { d, calls } = deps();
    expect((await executeRun(a, run.id as string, A, d)).status).toBe('skipped');
    expect(String(run.error)).toContain('tope');
    expect(calls.mail).toHaveLength(0);
  });

  it('ask_cortex: el tope diario por app', async () => {
    const { a, tables } = setup();
    const appRow = (tables.custom_apps ?? []).find((r) => r.id === 'app-a');
    if (appRow) appRow.automation_limits = { askCortexPerDay: 20 };
    const auto = (tables.custom_app_automations ?? []).find((r) => r.id === 'auto-a');
    if (!auto) throw new Error('sin regla');
    auto.actions = [{ type: 'ask_cortex', instruction: 'resume {{nombre}}' }];
    (tables.custom_app_automation_runs ?? []).push(
      queuedRun('auto-a', 'app-a', A, {
        status: 'succeeded',
        ask_cortex_calls: 20,
        next_attempt_at: null,
      }),
    );
    const run = queuedRun('auto-a', 'app-a', A);
    (tables.custom_app_automation_runs ?? []).push(run);
    const { d, calls } = deps();
    const out = await executeRun(a, run.id as string, A, d);
    expect(out.status).toBe('failed');
    expect(String(run.error)).toContain('tope');
    expect(calls.ask).toHaveLength(0);
  });
});

describe('botones y validación', () => {
  it('un botón encola una corrida y se deduplica por persona', async () => {
    const { a, tables } = setup();
    const row = {
      id: 'auto-btn',
      organization_id: A,
      app_id: 'app-a',
      name: 'Botón',
      enabled: true,
      trigger: { type: 'button', screen: 'tablero', id: 'enviar', label: 'Enviar' },
      conditions: [],
      actions: [{ type: 'email', to: ['g@a.co'], roles: [], subject: 's', body: 'b' }],
      tracker_id: null,
      trigger_kind: 'button',
    };
    (tables.custom_app_automations ?? []).push(row);
    const automation = adaptAutomation(row);
    const first = await fireButton(a, {
      automation,
      screen: 'tablero',
      actor: { kind: 'app_user', id: 'op-1' },
      now: NOW,
    });
    const again = await fireButton(a, {
      automation,
      screen: 'tablero',
      actor: { kind: 'app_user', id: 'op-1' },
      now: new Date(NOW.getTime() + 5000),
    });
    expect(first.queued).toBe(true);
    expect(again.queued).toBe(false);
    // otra pantalla: no
    expect(
      (
        await fireButton(a, {
          automation,
          screen: 'otra',
          actor: { kind: 'member', id: 'x' },
          now: NOW,
        })
      ).queued,
    ).toBe(false);
  });

  it('validateAutomation rechaza tablas, campos, pantallas y roles que no son de la app', async () => {
    const { a } = setup();
    await expect(
      validateAutomation(a, 'app-a', {
        name: 'x',
        trigger: { type: 'row_created', tracker: 'no_existe' },
        actions: [{ type: 'email', to: ['a@b.co'], subject: 's', body: 'b' }],
      }),
    ).rejects.toThrow(/no existe/);
    await expect(
      validateAutomation(a, 'app-a', {
        name: 'x',
        trigger: { type: 'row_updated', tracker: 'guias', field: 'inventado' },
        actions: [{ type: 'email', to: ['a@b.co'], subject: 's', body: 'b' }],
      }),
    ).rejects.toThrow(/inventado/);
    await expect(
      validateAutomation(a, 'app-a', {
        name: 'x',
        trigger: { type: 'row_created', tracker: 'guias' },
        actions: [{ type: 'notify_app_user', to: { role: 'fantasma' }, title: 't' }],
      }),
    ).rejects.toThrow(/fantasma/);
    const ok = await validateAutomation(a, 'app-a', {
      name: 'x',
      trigger: { type: 'row_created', tracker: 'guias' },
      actions: [{ type: 'email', to: ['a@b.co'], subject: 's', body: 'b' }],
    });
    expect(ok.trackerId).toBe('t-a');
  });
});
