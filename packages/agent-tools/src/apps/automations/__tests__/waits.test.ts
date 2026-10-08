import { describe, expect, it } from 'vitest';
import { createFakeSupabase } from '../../../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../../tenancy/scoped-client';
import { CONTROL_EN_PLANTA } from '../../templates';
import { forgetAutomationWatch } from '../emit';
import { type AutomationDeps, executeRun } from '../run';
import {
  MAX_WAITS_PER_ACTION,
  WAIT_TTL_MS,
  type WaitRow,
  WaitingForPersonError,
  judgeWait,
  latestResolvedWait,
  openWait,
  resumedPromptBlock,
  sweepWaits,
  waitFromRunFlow,
} from '../waits';

/**
 * Una automatización que pide un trámite del navegador y el portal se detiene
 * esperando a una persona: queda esperando, avisa, se reanuda al resolverse y
 * continúa con el resultado; si nadie lo atiende, queda sin resolver.
 */

const A = 'org-a';
const NOW = new Date('2026-10-07T15:00:00.000Z');
const fields = CONTROL_EN_PLANTA.trackers[0]?.fields ?? [];
type Table = Array<Record<string, unknown>>;

function seed() {
  return {
    trackers: [
      {
        id: 't-a',
        organization_id: A,
        slug: 'guias',
        name: 'Guías',
        description: '',
        fields,
        duplicates: null,
        created_by: null,
        created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-01T00:00:00Z',
      },
    ],
    custom_apps: [
      {
        id: 'app-a',
        organization_id: A,
        slug: 'planta',
        name: 'Control en planta',
        icon: '🏭',
        status: 'published',
        archived_at: null,
      },
    ],
    custom_app_automations: [
      {
        id: 'auto-a',
        organization_id: A,
        app_id: 'app-a',
        name: 'Validar guía',
        enabled: true,
        trigger: { type: 'row_flagged_duplicate', tracker: 'guias' },
        conditions: [],
        actions: [
          {
            type: 'ask_cortex',
            instruction: 'Consulta la guía con el trámite "Validar guía" y escribe result.estado',
          },
        ],
        tracker_id: 't-a',
        trigger_kind: 'row_flagged_duplicate',
        created_by: 'u-admin',
      },
    ],
    custom_app_automation_runs: [
      {
        id: 'run-1',
        organization_id: A,
        app_id: 'app-a',
        automation_id: 'auto-a',
        trigger_ref: 'row:row-1',
        status: 'queued',
        attempts: 0,
        next_attempt_at: NOW.toISOString(),
        event: {
          kind: 'row_flagged_duplicate',
          trackerId: 't-a',
          rowId: 'row-1',
          after: { numero_guia: '045' },
          label: '045',
          version: 'v1',
          actor: { kind: 'system' },
          chain: [],
          depth: 0,
        },
        result: [],
        error: null,
        ask_cortex_calls: 0,
        idempotency_key: 'k1',
        created_at: NOW.toISOString(),
      },
    ] as Table,
    custom_app_automation_waits: [] as Table,
    custom_app_users: [],
    custom_app_members: [],
    tracker_rows: [],
    users: [{ id: 'u-admin', organization_id: A, role: 'org_admin', email: 'admin@a.co' }],
    browser_flow_checkpoints: [] as Table,
    browser_flow_runs: [] as Table,
    browser_flows: [] as Table,
    browser_profiles: [] as Table,
  };
}

function setup() {
  const tables = seed() as unknown as Record<string, Table>;
  const fake = createFakeSupabase(tables);
  forgetAutomationWatch();
  return { tables, db: createOrgScopedClient(fake.client, A) };
}

const INFO = {
  kind: 'checkpoint' as const,
  flowSlug: 'validar-guia',
  flowName: 'Validar guía',
  checkpointId: 'cp-1',
  ask: 'Escribe el código que llegó al celular',
  profileOwnerId: null,
};

function checkpoint(over: Record<string, unknown> = {}) {
  return {
    id: 'cp-1',
    organization_id: A,
    flow_id: 'flow-1',
    run_id: 'bfr-1',
    session_id: 's_1',
    reason: 'input-needed',
    ask: INFO.ask,
    fills: 'codigo',
    from_index: 3,
    inputs: {},
    errand_id: null,
    errand_question_id: null,
    state: 'open',
    expires_at: new Date(NOW.getTime() + WAIT_TTL_MS).toISOString(),
    created_at: NOW.toISOString(),
    resolved_at: null,
    ...over,
  };
}

interface Seen {
  mail: Array<{ to: string; subject: string; text: string }>;
  bell: Array<{ users: string[]; title: string; href: string }>;
  prompts: string[];
}

function deps(now: () => Date, seen: Seen, askImpl: AutomationDeps['askCortex']): AutomationDeps {
  return {
    now,
    baseUrl: 'https://cortex.test',
    signingSecret: 's',
    sendEmail: async (m) => {
      seen.mail.push(m);
      return { sent: true };
    },
    notifyMembers: async (_db, users, n) => {
      seen.bell.push({ users, title: n.title, href: n.href });
      return users.length;
    },
    pushAppUsers: async () => [],
    askCortex: askImpl,
  };
}

describe('judgeWait (puro)', () => {
  const wait = {
    kind: 'checkpoint' as const,
    expires_at: new Date(NOW.getTime() + 60_000).toISOString(),
  };
  const live = { state: 'open', live: true, resolvedAt: null };

  it('sigue esperando mientras la pestaña está abierta', () => {
    expect(judgeWait({ wait, now: NOW, checkpoint: live, flowRun: null }).kind).toBe('keep');
  });
  it('vence cuando pasa su hora, aunque la pestaña siga', () => {
    const later = new Date(NOW.getTime() + 61_000);
    expect(judgeWait({ wait, now: later, checkpoint: live, flowRun: null }).kind).toBe('expire');
  });
  it('vence si la pestaña del navegador se perdió antes de que la atendieran', () => {
    const v = judgeWait({
      wait,
      now: NOW,
      checkpoint: { state: 'open', live: false, resolvedAt: null },
      flowRun: null,
    });
    expect(v).toMatchObject({ kind: 'expire' });
  });
  it('retomado y terminado: se resuelve con el result del trámite', () => {
    const v = judgeWait({
      wait,
      now: NOW,
      checkpoint: { state: 'resumed', live: false, resolvedAt: NOW.toISOString() },
      flowRun: {
        status: 'succeeded',
        failure_kind: null,
        error: null,
        result: { estado: 'Entregado' },
      },
    });
    expect(v).toEqual({ kind: 'resolve', outcome: { ok: true, result: { estado: 'Entregado' } } });
  });
  it('retomado pero aún corriendo (needs-human sin cerrar): espera un poco, luego lo da por perdido', () => {
    const run = { status: 'failed', failure_kind: 'needs-human', error: 'x', result: null };
    const fresh = { state: 'resumed', live: false, resolvedAt: NOW.toISOString() };
    expect(judgeWait({ wait, now: NOW, checkpoint: fresh, flowRun: run }).kind).toBe('keep');
    const stale = { ...fresh, resolvedAt: new Date(NOW.getTime() - 20 * 60_000).toISOString() };
    const w = { ...wait, expires_at: new Date(NOW.getTime() + 3_600_000).toISOString() };
    expect(judgeWait({ wait: w, now: NOW, checkpoint: stale, flowRun: run })).toMatchObject({
      kind: 'resolve',
      outcome: { ok: false },
    });
  });
  it('volver a iniciar sesión sólo lo cierra la persona', () => {
    expect(
      judgeWait({ wait: { ...wait, kind: 'login' }, now: NOW, checkpoint: null, flowRun: null })
        .kind,
    ).toBe('keep');
  });
});

describe('waitFromRunFlow', () => {
  it('un trámite parado entrega la espera; uno que terminó o falló por otra causa, no', async () => {
    const { tables, db } = setup();
    tables.browser_flow_checkpoints?.push(checkpoint());
    tables.browser_flows?.push({
      id: 'flow-1',
      organization_id: A,
      slug: 'validar-guia',
      name: 'Validar guía',
      profile_id: null,
    });
    const info = await waitFromRunFlow(db, {
      ok: false,
      flow: 'validar-guia',
      pausedAt: 'cp-1',
      asks: 'Escribe el código',
    });
    expect(info).toMatchObject({
      kind: 'checkpoint',
      checkpointId: 'cp-1',
      flowSlug: 'validar-guia',
    });
    expect(
      await waitFromRunFlow(db, { ok: true, result: { estado: 'x' }, pausedAt: null }),
    ).toBeNull();
    expect(
      await waitFromRunFlow(db, { ok: false, failureKind: 'site-changed', pausedAt: null }),
    ).toBeNull();
  });
});

describe('automatización → pausa → aviso → reanudar → continuar', () => {
  it('queda esperando, avisa por campana y correo, se reanuda una sola vez y el modelo recibe el result', async () => {
    const { tables, db } = setup();
    const seen: Seen = { mail: [], bell: [], prompts: [] };
    let paused = true;
    const d = deps(
      () => NOW,
      seen,
      async (adb, args) => {
        if (paused) throw new WaitingForPersonError(INFO);
        const block = resumedPromptBlock(
          await latestResolvedWait(adb, args.run.id, args.actionIndex ?? -1),
        );
        seen.prompts.push(block ?? '');
        return { summary: 'Escribí estado', staged: 0 };
      },
    );

    const first = await executeRun(db, 'run-1', A, d);
    expect(first.status).toBe('waiting_person');
    const run = tables.custom_app_automation_runs?.[0] as Record<string, unknown>;
    expect(run.status).toBe('waiting_person');
    const waits = tables.custom_app_automation_waits ?? [];
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({
      state: 'waiting',
      kind: 'checkpoint',
      checkpoint_id: 'cp-1',
      notify_user_id: 'u-admin',
      action_index: 0,
    });
    // Aviso: campana con enlace a la pantalla de resolver, y correo.
    expect(seen.bell).toHaveLength(1);
    expect(seen.bell[0]?.href).toMatch(/^\/browser\/espera\//);
    expect(seen.mail).toHaveLength(1);
    expect(seen.mail[0]?.to).toBe('admin@a.co');
    expect(seen.mail[0]?.text).toContain('/browser/espera/');

    // Idempotente: reclamar otra vez no hace nada ni avisa de nuevo.
    expect((await executeRun(db, 'run-1', A, d)).status).toBe('not_claimable');
    expect(seen.mail).toHaveLength(1);

    // Mientras la pestaña esté abierta, el barrido no toca nada.
    tables.browser_flow_checkpoints?.push(checkpoint());
    expect(await sweepWaits(db, d, NOW)).toEqual({ resolved: 0, expired: 0 });
    expect(run.status).toBe('waiting_person');

    // La persona resuelve en su pantalla: el checkpoint se cierra y el trámite termina.
    const cp = tables.browser_flow_checkpoints?.[0] as Record<string, unknown>;
    cp.state = 'resumed';
    cp.resolved_at = NOW.toISOString();
    tables.browser_flow_runs?.push({
      id: 'bfr-1',
      organization_id: A,
      status: 'succeeded',
      failure_kind: null,
      error: null,
      result: { estado: 'Entregado' },
    });
    expect(await sweepWaits(db, d, NOW)).toEqual({ resolved: 1, expired: 0 });
    expect(run.status).toBe('queued');
    // Dos barridos seguidos no reencolan dos veces.
    expect(await sweepWaits(db, d, NOW)).toEqual({ resolved: 0, expired: 0 });

    // La automatización continúa y el modelo recibe lo que devolvió el trámite.
    paused = false;
    const second = await executeRun(db, 'run-1', A, d);
    expect(second.status).toBe('succeeded');
    expect(seen.prompts[0]).toContain('"estado":"Entregado"');
    expect(seen.prompts[0]).toContain('NO lo vuelvas a correr');
    expect(seen.mail).toHaveLength(1);
  });

  it('sin atender a tiempo: la corrida queda sin resolver, se avisa y no se reintenta', async () => {
    const { tables, db } = setup();
    const seen: Seen = { mail: [], bell: [], prompts: [] };
    const d = deps(
      () => NOW,
      seen,
      async () => {
        throw new WaitingForPersonError(INFO);
      },
    );
    await executeRun(db, 'run-1', A, d);
    tables.browser_flow_checkpoints?.push(checkpoint());
    const later = new Date(NOW.getTime() + WAIT_TTL_MS + 60_000);
    expect(await sweepWaits(db, d, later)).toEqual({ resolved: 0, expired: 1 });
    const run = tables.custom_app_automation_runs?.[0] as Record<string, unknown>;
    expect(run.status).toBe('unresolved');
    expect(String(run.error)).toMatch(/^Sin resolver/);
    expect(tables.custom_app_automation_waits?.[0]?.state).toBe('unresolved');
    expect((tables.browser_flow_checkpoints?.[0] as Record<string, unknown>).state).toBe('expired');
    // Un aviso al abrirse y otro al vencer.
    expect(seen.mail.map((m) => m.subject)).toEqual([
      expect.stringContaining('necesita una persona'),
      expect.stringContaining('sin resolver'),
    ]);
    // No vuelve a la cola.
    expect((await executeRun(db, 'run-1', A, d)).status).toBe('not_claimable');
  });

  it('si el usuario resuelve el login, la corrida vuelve a la cola con la nota', async () => {
    const { tables, db } = setup();
    const seen: Seen = { mail: [], bell: [], prompts: [] };
    const d = deps(
      () => NOW,
      seen,
      async () => {
        throw new WaitingForPersonError({ ...INFO, kind: 'login', checkpointId: null });
      },
    );
    await executeRun(db, 'run-1', A, d);
    const wait = tables.custom_app_automation_waits?.[0] as unknown as WaitRow;
    expect(wait.kind).toBe('login');
    const { resolveWait } = await import('../waits');
    expect(await resolveWait(db, wait, { ok: true, note: 'listo' }, NOW)).toBe(true);
    expect(await resolveWait(db, wait, { ok: true, note: 'listo' }, NOW)).toBe(false);
    expect((tables.custom_app_automation_runs?.[0] as Record<string, unknown>).status).toBe(
      'queued',
    );
    expect(resumedPromptBlock({ ...wait, state: 'resolved', outcome: { ok: true } })).toContain(
      'volver a iniciar sesión',
    );
  });

  it('una acción no queda esperando indefinidamente: tope de pausas seguidas', async () => {
    const { tables, db } = setup();
    for (let i = 0; i < MAX_WAITS_PER_ACTION; i++)
      tables.custom_app_automation_waits?.push({
        id: `w${i}`,
        organization_id: A,
        run_id: 'run-1',
        action_index: 0,
        state: 'resolved',
      });
    await expect(
      openWait(db, {
        organizationId: A,
        appId: 'app-a',
        automationId: 'auto-a',
        runId: 'run-1',
        actionIndex: 0,
        info: INFO,
        recipientId: 'u-admin',
        now: NOW,
      }),
    ).rejects.toThrow(/no insiste/);
  });
});
