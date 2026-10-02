import {
  type PlanView,
  type RunListEntry,
  type RunView,
  type SettingsView,
  buildPlanView,
  buildRunView,
  buildSettingsView,
  runListEntry,
} from '@/lib/autopilot/screen';
import { qualifiedToolLabel } from '@/lib/tool-taxonomy';
import {
  type AutopilotItemRow,
  type AutopilotRunRow,
  buildPlan,
  ownerMessage,
} from '@cortex/agent-tools';
import {
  FIXTURE_DAY,
  FIXTURE_NOW,
  fixtureSettings,
  fixtureSnapshot,
  fixtureTool,
} from '@cortex/agent-tools/src/autopilot/autopilot.fixtures';

/**
 * Transportes Andinos (autopilot/autopilot.fixtures.ts) pasada por el plan de
 * verdad (recolectores + política), y una corrida «de mentira» armada con ese
 * plan: lo de «hacer» quedó hecho (uno falló), lo de preguntar espera y lo
 * demás se contó.
 */

const label = (id: string) => qualifiedToolLabel(id);

const RESULT: Record<string, { summary: string; verification: AutopilotItemRow['verification'] }> =
  {
    conciliacion: {
      summary: 'Até el pago de $ 4.500.000 a la factura FV-77; el saldo de Nexa quedó en $ 0.',
      verification: 'verified',
    },
    finanzas: {
      summary:
        'Categoricé 12 (7 por regla, 3 por lo ya decidido y 2 con el modelo). Quedan 2 sin categoría.',
      verification: null,
    },
    vencimientos: {
      summary: 'Listo: le dejé el recordatorio a Laura Gómez en su campana.',
      verification: 'unverifiable',
    },
  };

export interface ShowcaseData {
  settings: SettingsView;
  plan: PlanView;
  today: RunView | null;
  history: RunListEntry[];
  waiting: number;
}

export function fixtureData(opts: { off: boolean; empty: boolean }): ShowcaseData {
  const settings = fixtureSettings({ enabled: !opts.off });
  const plan = buildPlan(fixtureSnapshot(), {
    settings,
    mandates: [],
    tool: fixtureTool,
    now: FIXTURE_NOW,
  });
  const runId = '0f0f0f0f-0000-4000-8000-000000000006';
  const at = (sec: number) => new Date(FIXTURE_NOW.getTime() + sec * 1000).toISOString();
  const rows: AutopilotItemRow[] = plan.items.map((i, n) => {
    const failed = i.area === 'procesos';
    const status =
      i.decision === 'do' ? (failed ? 'failed' : 'done') : i.decision === 'ask' ? 'asked' : 'told';
    const r = RESULT[i.area];
    return {
      id: `0e0e0e0e-0000-4000-8000-${String(n).padStart(12, '0')}`,
      run_id: runId,
      dedupe_key: i.dedupeKey,
      area: i.area,
      title: i.title,
      why: i.why,
      risk: i.risk,
      effect: i.effect,
      decision: i.decision,
      decision_reason: i.decisionReason,
      authority: i.authority,
      mandate_id: i.mandateId,
      tool_id: i.proposedAction?.toolId ?? null,
      tool_input: i.proposedAction?.input ?? null,
      amount: i.amount ?? null,
      currency: i.currency ?? null,
      counterparty: i.counterparty ?? null,
      href: i.href ?? null,
      undo: i.undo ?? null,
      status,
      result_summary: status === 'done' ? (r?.summary ?? 'Hecho.') : null,
      verification: status === 'done' ? (r?.verification ?? null) : null,
      verification_detail: null,
      error: failed ? 'Drive respondió 503 otra vez. Mañana lo vuelvo a intentar.' : null,
      action_id:
        i.area === 'cobro' && i.decision === 'ask' ? '0d0d0d0d-0000-4000-8000-000000000001' : null,
      decided_by: null,
      decided_at: null,
      executed_at: i.decision === 'do' ? at(n * 3) : null,
      created_at: at(0),
      updated_at: at(n * 3),
    };
  });
  const count = (s: string) => rows.filter((r) => r.status === s).length;
  const run: AutopilotRunRow = {
    id: runId,
    run_on: FIXTURE_DAY,
    status: 'done',
    actor_user_id: settings.actorUserId,
    done_count: count('done'),
    asked_count: count('asked'),
    told_count: count('told'),
    failed_count: count('failed'),
    skipped_count: 0,
    summary: ownerMessage({
      done: count('done'),
      asked: count('asked'),
      failed: count('failed'),
      stillWaiting: 0,
    }),
    source_errors: [],
    started_at: at(0),
    finished_at: at(260),
    notified_at: at(43),
  };
  const past: AutopilotRunRow[] = [
    ['2026-10-05', 5, 2, 'Hoy hice 5 cosas; necesito tu decisión en 2.'],
    ['2026-10-02', 3, 0, 'Hoy hice 3 cosas; no necesito ninguna decisión tuya.'],
    ['2026-10-01', 7, 1, 'Hoy hice 7 cosas; necesito tu decisión en 1. (1 no salió.)'],
  ].map(([day, done, asked, summary], n) => ({
    ...run,
    id: `0c0c0c0c-0000-4000-8000-00000000000${n}`,
    run_on: day as string,
    done_count: done as number,
    asked_count: asked as number,
    summary: summary as string,
  }));
  return {
    settings: buildSettingsView(settings, {
      today: FIXTURE_DAY,
      hourNow: opts.empty ? 6 : 8,
      actorLabel: 'Mateo Ángel',
    }),
    plan: buildPlanView(plan, settings, label),
    today: opts.empty || opts.off ? null : buildRunView(run, rows, label),
    history: past.map(runListEntry),
    waiting: opts.empty || opts.off ? 1 : count('asked'),
  };
}
