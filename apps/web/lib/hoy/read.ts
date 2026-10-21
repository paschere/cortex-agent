import 'server-only';

import { fetchUserNames } from '@/app/api/admin/_lib/audit-filters';
import { loadActivity, loadUndoneIds } from '@/lib/activity/load';
import { buildTimeline } from '@/lib/activity/timeline';
import { timeLabel, viewOfRow } from '@/lib/autopilot/screen';
import { buildCash, buildDue, formatDay, maskPayroll } from '@/lib/finance/dashboard-shape';
import { fullMoney } from '@/lib/finance/dashboard-shape';
import { companyModules } from '@/lib/modules/server';
import { ageDays, riskOfPilotItem, riskOfTool, waitingAge } from '@/lib/risk';
import { qualifiedToolLabel } from '@/lib/tool-taxonomy';
import { readWaitingIndex } from '@/lib/waiting';
import {
  bogotaHour,
  isCompanyManager,
  listAutopilotItems,
  listAutopilotRuns,
  listOpenAsks,
} from '@cortex/agent-tools';
import {
  effectiveMinimumCash,
  getLedgerSettings,
  runForecast,
} from '@cortex/agent-tools/src/ledger/plans';
import { maskPayrollForecast } from '@cortex/agent-tools/src/ledger/privacy';
import { listAccounts, loadLedger } from '@cortex/agent-tools/src/ledger/store';
import type { ForecastResult, LedgerMovement } from '@cortex/agent-tools/src/ledger/types';
import { withPayablesOverlay } from '@cortex/agent-tools/src/payables/overlay';
import type { SupabaseClient } from '@supabase/supabase-js';
import { hasInsights } from './insights';
import { activityRows, buildOps } from './ops';
import { readInsights } from './read-insights';
import { buildHoyMetrics, greetingFor, narrative } from './shape';
import { withoutSnoozed } from './snooze';
import { loadSnoozedKeys } from './snooze-store';
import type { DoneView, DuePartyView, HoyView, TodoView } from './view';

/**
 * «HOY», LEÍDO. Cada fuente se lee por su lado y la que falle deja su bloque
 * vacío sin tumbar la página: la plata (si el módulo de finanzas está prendido),
 * el piloto (si el suyo lo está) y las colas de «Te espera». Las cifras salen
 * de las mismas funciones que Finanzas, así que no pueden dar distinto.
 */

const MAX_TODOS = 5;

async function safe<T>(work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch {
    return null;
  }
}

export interface ReadHoyInput {
  db: SupabaseClient;
  organizationId: string;
  userId: string;
  name: string | null;
  email: string;
  isAdmin: boolean;
  today: string;
}

export async function readHoy(input: ReadHoyInput): Promise<HoyView> {
  const { db, today, isAdmin } = input;
  const modules = await companyModules(input.organizationId);
  const financeOn = modules.has('finance');
  const autopilotOn = modules.has('autopilot');

  // Lo que esta persona pospuso (0223): no se muestra hasta que pase la hora.
  const hiddenP = loadSnoozedKeys(db, input.userId);
  const [money, pilot, waiting, canDecide] = await Promise.all([
    financeOn ? safe(() => readMoney(db, today, isAdmin)) : Promise.resolve(null),
    autopilotOn ? safe(() => readPilot(db, today, hiddenP)) : Promise.resolve(null),
    safe(() => readWaitingIndex(input.organizationId, input.userId)),
    safe(() => isCompanyManager(db, input.userId)),
  ]);

  // Lo que se mira al empezar el día (cartera, estados, DIAN, operación): arranca ya y se
  // espera antes de armar la plata, porque la cartera manda sobre «lo vencido».
  const insightsP = safe(() =>
    readInsights({
      db,
      today,
      isAdmin,
      financeOn,
      currency: money?.currency ?? 'COP',
      money: money
        ? { movements: money.movements, forecast: money.forecast, minimumCash: money.minimumCash }
        : null,
    }),
  );

  // ---- Para ti, hoy -------------------------------------------------------
  const todos: TodoView[] = [];
  for (const v of pilot?.asks ?? []) {
    const decide =
      v.id && v.contentHash
        ? {
            itemId: v.id,
            contentHash: v.contentHash,
            approveLabel: v.preview ? 'Enviar' : 'Hacerlo',
          }
        : null;
    todos.push({
      id: v.id ?? v.title,
      title: v.title,
      detail: [v.amountLabel, clamp(v.why, 140)].filter(Boolean).join(' · ') || null,
      badge: null,
      preview: v.preview,
      decide,
      href: v.approvalsHref ?? v.href,
      hrefLabel: v.preview ? 'Editar' : 'Ver de dónde sale',
      ageLabel: waitingAge(v.createdAt),
      risk: v.toolId
        ? riskOfTool(v.toolId)
        : riskOfPilotItem({
            area: v.area,
            hasAmount: Boolean(v.amountLabel),
            hasPreview: Boolean(v.preview),
          }),
    });
  }
  let queueExtra = 0;
  const hidden = await hiddenP;
  let snoozedCount = pilot?.snoozed ?? 0;
  for (const q of waiting?.queues ?? []) {
    for (const it of q.items) {
      if (hidden.has(`${q.queue}-${it.id}`)) {
        snoozedCount += 1;
        continue;
      }
      if (todos.length < MAX_TODOS)
        todos.push({
          id: `${q.queue}-${it.id}`,
          title: it.title,
          detail: [it.detail, it.when].filter(Boolean).join(' · ') || null,
          badge: it.stale ? { label: 'Lleva días', tone: 'amber' } : null,
          preview: null,
          decide: null,
          href: q.href,
          hrefLabel: 'Abrir',
          ageLabel: it.when ? `espera: ${it.when}` : null,
          risk: null,
        });
      else queueExtra += 1;
    }
  }
  const shown = todos.slice(0, MAX_TODOS);
  const more = Math.max(0, todos.length - shown.length) + queueExtra + (pilot?.moreAsks ?? 0);

  // ---- Plata --------------------------------------------------------------
  const insights = await insightsP;
  let moneyView: HoyView['money'] = null;
  let dueView: HoyView['due'] = null;
  let overdueInfo: { total: number; biggest: string | null } | null = null;
  if (money) {
    const built = buildHoyMetrics({
      today,
      currency: money.currency,
      isAdmin,
      cashTotal: money.cashTotal,
      movements: money.movements,
      forecast: money.forecast,
      minimumCash: money.minimumCash,
      runs: pilot ? pilot.runs : null,
    });
    // «Te deben vencido» sale de la cartera (con el plazo por defecto de la empresa): la serie
    // del libro cuenta como vencida toda factura con «vence» el mismo día y daría otra cifra.
    const byCartera = !!insights?.receivable;
    moneyView = {
      currency: money.currency,
      metrics: built.metrics.filter((m) => !(byCartera && m.id === 'vencido')),
      kpis: built.kpis.filter((k) => !(byCartera && k.id === 'vencido')),
    };
    const r = money.due.receivable;
    overdueInfo = insights?.receivable
      ? { total: insights.receivable.overdue, biggest: insights.receivable.topOverdue }
      : { total: r.overdue, biggest: r.parties.find((p) => p.overdueDays)?.name ?? null };
    dueView = {
      total: fullMoney(r.total, money.currency),
      overdue: fullMoney(r.overdue, money.currency),
      href: '/finance#me-deben',
      parties: r.parties.map<DuePartyView>((p) => ({
        name: p.name,
        amount: fullMoney(p.amount, money.currency),
        count: p.count,
        late: !!p.overdueDays,
        status: p.overdueDays
          ? `${p.overdueDays} ${p.overdueDays === 1 ? 'día' : 'días'} vencida`
          : p.nextDue
            ? `vence ${formatDay(p.nextDue)}`
            : 'al día',
      })),
    };
  }

  const phrase = narrative({
    today,
    currency: money?.currency ?? 'COP',
    cash:
      money && money.cashTotal !== null
        ? { total: money.cashTotal, minimum: money.minimumCash }
        : null,
    forecast: money?.forecast ?? null,
    overdue: overdueInfo,
    waiting: Math.max(0, (waiting?.total ?? 0) + (pilot?.asks.length ?? 0) - snoozedCount),
    autopilotDone: pilot?.done.length ?? 0,
  });

  const firstName = (input.name?.trim() || input.email.split('@')[0] || '').split(/\s+/)[0] ?? '';
  const closing = pilot
    ? pilot.summary
      ? { text: pilot.summary, href: '/actividad', hrefLabel: 'Ver todo lo que hizo' }
      : {
          text: 'Todavía no he corrido hoy.',
          href: '/actividad',
          hrefLabel: 'Ver lo que hice antes',
        }
    : null;

  const approvalsQueue = waiting?.queues.find((q) => q.queue === 'approvals');
  const commitmentsQueue = waiting?.queues.find((q) => q.queue === 'commitments');
  const askAges = (pilot?.asks ?? [])
    .map((a) => ageDays(a.createdAt))
    .filter((n): n is number => n !== null);
  const approvalAges = [approvalsQueue?.oldestDays ?? null, ...askAges].filter(
    (n): n is number => n !== null,
  );
  const ops = buildOps({
    today,
    runs: pilot ? pilot.runs : null,
    approvals: waiting
      ? {
          count: (waiting.counts.approvals ?? 0) + (pilot?.asks.length ?? 0),
          oldestDays: approvalAges.length ? Math.max(...approvalAges) : null,
        }
      : null,
    commitments:
      waiting && commitmentsQueue
        ? {
            overdue: commitmentsQueue.overdue ?? 0,
            oldestDays: commitmentsQueue.oldestDays ?? null,
          }
        : null,
  });
  const activity = (await safe(() => readActivityRows(db, input, canDecide === true))) ?? [];

  return {
    today,
    dateLabel: new Intl.DateTimeFormat('es-CO', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      timeZone: 'America/Bogota',
    }).format(new Date()),
    greeting: greetingFor(bogotaHour(new Date())),
    firstName,
    narrative: phrase,
    money: moneyView,
    todos: shown,
    todosMore: more,
    snoozed: snoozedCount,
    todosMoreHref: autopilotOn ? '/piloto/panel' : null,
    canDecide: canDecide === true,
    done: pilot?.done ?? [],
    ops,
    activity,
    insights: hasInsights(insights) ? insights : undefined,
    due: dueView,
    closing,
    panelHref: autopilotOn ? '/piloto/panel' : null,
  };
}

async function readActivityRows(db: SupabaseClient, input: ReadHoyInput, manager: boolean) {
  const viewer = { id: input.userId, isManager: input.isAdmin || manager };
  const page = await loadActivity(db, viewer, { filter: 'all', limit: 8 });
  const undone = await loadUndoneIds(
    db,
    page.events.map((e) => e.id),
  );
  const lines = buildTimeline(page.events, { undoneIds: undone });
  const names = viewer.isManager
    ? await fetchUserNames(
        db,
        lines.map((l) => l.userId),
      ).catch(() => ({}))
    : {};
  return activityRows(lines, { meId: input.userId, names });
}

function clamp(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

// ---------------------------------------------------------------------------

async function readMoney(db: SupabaseClient, today: string, isAdmin: boolean) {
  const [accounts, ledger, run, settings] = await Promise.all([
    safe(() => listAccounts(db)),
    safe(async () => {
      const l = await loadLedger(db, { today, historyDays: 760 });
      return await withPayablesOverlay(db, l.movements);
    }),
    safe(() => runForecast(db, { today, includeEstimatedSales: true })),
    safe(() => getLedgerSettings(db)),
  ]);
  const currency = run?.base.currency ?? 'COP';
  const cash = accounts
    ? buildCash(
        accounts.map((a) => ({
          id: a.id,
          name: a.name,
          currency: a.currency,
          balance: Number(a.balance) || 0,
          balanceAt: a.balance_at,
          balanceSource: a.balance_source,
          sourceSystem: a.source_system,
        })),
        today,
        currency,
      )
    : null;
  const movements: LedgerMovement[] = ledger ?? [];
  let forecast: ForecastResult | null = null;
  if (run) forecast = isAdmin ? run.base : maskPayroll(maskPayrollForecast(run.base));
  const minimumCash = settings ? effectiveMinimumCash(null, settings, currency) : null;
  // Sin cuentas ni movimientos no hay nada que graficar: el bloque no se pinta.
  if (!cash?.accounts.length && movements.length === 0) throw new Error('sin datos');
  return {
    currency,
    cashTotal: cash?.accounts.length ? cash.total : null,
    movements,
    forecast,
    minimumCash,
    due: buildDue(movements, today, { currency, isAdmin }),
  };
}

async function readPilot(db: SupabaseClient, today: string, hiddenP: Promise<Set<string>>) {
  const [runs, asks] = await Promise.all([
    listAutopilotRuns(db, { limit: 60 }),
    listOpenAsks(db, { limit: 50 }),
  ]);
  const label = (id: string) => qualifiedToolLabel(id);
  const todayRun = runs.find((r) => r.run_on === today) ?? null;
  const items = todayRun ? await listAutopilotItems(db, todayRun.id) : [];
  const done: DoneView[] = items
    .map((r) => viewOfRow(r, label))
    .filter((v) => v.status === 'done')
    .slice(0, 3)
    .map((v) => ({
      id: v.id ?? v.title,
      title: v.title,
      timeLabel: timeLabel(v.decidedAt),
      href: v.href,
    }));
  const hidden = await hiddenP;
  const { shown: askViews, hiddenCount } = withoutSnoozed(
    asks.map((r) => viewOfRow(r, label)),
    (v) => v.id ?? v.title,
    hidden,
  );
  return {
    snoozed: hiddenCount,
    asks: askViews.slice(0, MAX_TODOS),
    moreAsks: Math.max(0, askViews.length - MAX_TODOS),
    done,
    summary: todayRun?.summary ?? null,
    runs: runs.map((r) => ({ day: r.run_on, done: r.done_count, failed: r.failed_count })),
  };
}
