import { ForbiddenError, type UUID, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { writeAuditEvent } from '../audit';
import { isCompanyManager } from '../directory/store';
import type { ModuleKey } from '../modules/catalog';
import { enabledModules } from '../modules/store';
import { type ClosePeriodRow, PERIOD_COLUMNS, getClosePeriod, recordCloseEvent } from './lock';
import {
  type AutoCheck,
  type CloseCheckData,
  type CloseStatus,
  type CloseTaskDef,
  type CloseTaskKey,
  PeriodLockedError,
  type TaskStatus,
  closeHeadline,
  defaultClosePeriod,
  evaluateCheck,
  isLocked,
  isPeriod,
  periodEnd,
  periodLabel,
  periodStart,
  progressOf,
  shiftDay,
  taskDef,
  taskReady,
  tasksFor,
} from './shape';
import { pendingWritebackCounts } from './writeback/store';

/**
 * EL CIERRE DEL MES: LA BASE (migración 0192).
 *
 * Dos lecturas distintas a propósito:
 *
 *   `computeClose`  mira los datos y arma la lista SIN escribir nada (la usa
 *                   el piloto de la mañana y `close.status`).
 *   `refreshClose`  lo mismo, y además crea el mes y sus tareas si no
 *                   existían y guarda la última revisión automática en cada
 *                   tarea (la usa la pantalla /cierre).
 *
 * Cada lectura de datos va en su propio try: una que falla deja su tarea en
 * «no pude revisar», nunca en «al día».
 */

const TASK_COLUMNS =
  'id, period_id, period, key, title, status, owner_id, evidence, evidence_url, auto_check, auto_checked_at, done_by, done_at, position';

interface CloseTaskRow {
  id: string;
  period_id: string;
  period: string;
  key: string;
  title: string;
  status: TaskStatus;
  owner_id: string | null;
  evidence: string | null;
  evidence_url: string | null;
  auto_check: AutoCheck | null;
  auto_checked_at: string | null;
  done_by: string | null;
  done_at: string | null;
  position: number;
}

export interface CloseTaskView {
  key: CloseTaskKey;
  title: string;
  help: string;
  status: TaskStatus;
  auto: AutoCheck;
  automatic: boolean;
  ready: boolean;
  ownerId: string | null;
  evidence: string | null;
  evidenceUrl: string | null;
  doneBy: string | null;
  doneAt: string | null;
  fix: CloseTaskDef['fix'];
}

export interface CloseView {
  period: string;
  label: string;
  status: CloseStatus;
  locked: boolean;
  closedAt: string | null;
  closedBy: string | null;
  overrideUntil: string | null;
  tasks: CloseTaskView[];
  progress: { done: number; total: number };
  pending: number;
  headline: string;
}

// ---------------------------------------------------------------------------
// Los datos del mes
// ---------------------------------------------------------------------------

async function attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

async function bankAccountsCoverage(
  db: SupabaseClient,
  period: string,
): Promise<Array<{ name: string; lastDate: string | null }>> {
  const { data, error } = await db
    .from('ledger_accounts')
    .select('id, name, balance_at, balance_source')
    .eq('source_kind', 'bank')
    .limit(50);
  if (error) throw error;
  const accounts = (data ?? []) as Array<{
    id: string;
    name: string;
    balance_at: string | null;
    balance_source: string;
  }>;
  const horizon = shiftDay(periodEnd(period), 20);
  const out: Array<{ name: string; lastDate: string | null }> = [];
  for (const a of accounts) {
    const last = await db
      .from('ledger_movements')
      .select('date')
      .eq('account_id', a.id)
      .eq('source_kind', 'bank')
      .lte('date', horizon)
      .order('date', { ascending: false })
      .limit(1);
    if (last.error) throw last.error;
    const moved = ((last.data ?? []) as Array<{ date: string }>)[0]?.date ?? null;
    const said =
      a.balance_source === 'bank' && a.balance_at && a.balance_at <= horizon ? a.balance_at : null;
    const lastDate =
      [moved, said]
        .filter((d): d is string => Boolean(d))
        .sort()
        .pop() ?? null;
    out.push({ name: a.name, lastDate });
  }
  return out;
}

async function bankUnmatched(db: SupabaseClient, period: string) {
  const { data, error } = await db
    .from('payment_reports')
    .select('payment_id')
    .like('source_system', 'extracto %')
    .gte('paid_on', periodStart(period))
    .lte('paid_on', periodEnd(period))
    .not('payment_id', 'is', null)
    .limit(3000);
  if (error) throw error;
  const ids = [
    ...new Set(((data ?? []) as Array<{ payment_id: string }>).map((r) => r.payment_id)),
  ];
  let count = 0;
  let amount = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const pays = await db
      .from('payments')
      .select('id, amount')
      .in('id', ids.slice(i, i + 200))
      .in('state', ['reported', 'confirmed'])
      .is('invoice_number', null);
    if (pays.error) throw pays.error;
    for (const p of (pays.data ?? []) as Array<{ amount: number | string }>) {
      count += 1;
      amount += Number(p.amount) || 0;
    }
  }
  return { count, amount };
}

async function countRows(
  q: PromiseLike<{ count: number | null; error: unknown }>,
): Promise<number> {
  const { count, error } = await q;
  if (error) throw error;
  return count ?? 0;
}

async function uncategorizedOf(db: SupabaseClient, period: string) {
  const { data, error } = await db
    .from('ledger_movements')
    .select('amount')
    .gte('date', periodStart(period))
    .lte('date', periodEnd(period))
    .eq('status', 'settled')
    .in('kind', ['income', 'expense'])
    .is('duplicate_of', null)
    .is('excluded_reason', null)
    .is('category', null)
    .limit(5000);
  if (error) throw error;
  const rows = (data ?? []) as Array<{ amount: number | string }>;
  return { count: rows.length, amount: rows.reduce((s, r) => s + (Number(r.amount) || 0), 0) };
}

async function taxesOf(db: SupabaseClient, period: string) {
  const { data, error } = await db
    .from('tax_obligations')
    .select('title, due_date, status')
    .gte('due_date', periodStart(period))
    .lte('due_date', periodEnd(period))
    .neq('status', 'no_aplica')
    .order('due_date', { ascending: true })
    .limit(200);
  if (error) throw error;
  const rows = (data ?? []) as Array<{ title: string; due_date: string; status: string }>;
  return {
    due: rows.length,
    pending: rows
      .filter((r) => r.status === 'pendiente')
      .map((r) => ({ title: r.title, dueDate: r.due_date })),
  };
}

/** Lee todo lo que la lista necesita saber del mes. Nada aquí escribe. */
export async function loadCloseCheckData(
  db: SupabaseClient,
  period: string,
  modulesOn: ReadonlySet<ModuleKey>,
): Promise<CloseCheckData> {
  const start = periodStart(period);
  const end = periodEnd(period);
  const on = (m: ModuleKey) => modulesOn.has(m);
  const [bankAccounts, unmatched, awaiting, writebacks, uncategorized, payroll, taxes, inventory] =
    await Promise.all([
      attempt(() => bankAccountsCoverage(db, period)),
      attempt(() => bankUnmatched(db, period)),
      on('payables')
        ? attempt(() =>
            countRows(
              db
                .from('payable_invoices')
                .select('id', { count: 'exact', head: true })
                .gte('issue_date', start)
                .lte('issue_date', end)
                .in('status', ['recibida', 'por_aprobar']),
            ),
          )
        : Promise.resolve(0),
      attempt(() => pendingWritebackCounts(db, period)),
      on('finance') ? attempt(() => uncategorizedOf(db, period)) : Promise.resolve(undefined),
      on('payroll')
        ? attempt(
            async () =>
              (await countRows(
                db
                  .from('ledger_movements')
                  .select('id', { count: 'exact', head: true })
                  .gte('date', start)
                  .lte('date', end)
                  .eq('category', 'nomina')
                  .eq('direction', 'out')
                  .neq('status', 'cancelled')
                  .is('duplicate_of', null),
              )) > 0,
          )
        : Promise.resolve(undefined),
      on('taxes') ? attempt(() => taxesOf(db, period)) : Promise.resolve(undefined),
      on('inventory')
        ? attempt(
            async () =>
              (await countRows(
                db
                  .from('stock_movements')
                  .select('id', { count: 'exact', head: true })
                  .eq('reference_kind', 'conteo')
                  .gte('occurred_on', shiftDay(end, -7))
                  .lte('occurred_on', shiftDay(end, 10)),
              )) > 0,
          )
        : Promise.resolve(undefined),
    ]);
  return {
    bankAccounts,
    bankUnmatched: unmatched,
    payablesAwaiting: awaiting,
    purchasesToBook: writebacks === undefined ? undefined : (writebacks?.compra ?? null),
    receiptsToRegister: writebacks === undefined ? undefined : (writebacks?.recibo ?? null),
    supplierPaymentsToRegister:
      writebacks === undefined ? undefined : (writebacks?.pago_proveedor ?? null),
    uncategorized,
    payrollRecorded: payroll,
    taxPending: taxes?.pending,
    taxDue: taxes?.due,
    inventoryCounted: inventory,
  };
}

// ---------------------------------------------------------------------------
// La lista armada
// ---------------------------------------------------------------------------

async function tasksOf(db: SupabaseClient, periodId: string): Promise<CloseTaskRow[]> {
  const { data, error } = await db
    .from('close_tasks')
    .select(TASK_COLUMNS)
    .eq('period_id', periodId)
    .order('position', { ascending: true })
    .limit(100);
  if (error) throw error;
  return (data ?? []) as CloseTaskRow[];
}

function buildView(
  period: string,
  row: ClosePeriodRow | null,
  defs: CloseTaskDef[],
  stored: CloseTaskRow[],
  checks: Map<string, AutoCheck>,
  now: Date,
): CloseView {
  const byKey = new Map(stored.map((t) => [t.key, t]));
  const tasks: CloseTaskView[] = defs.map((def) => {
    const t = byKey.get(def.key);
    const auto = checks.get(def.key) ??
      t?.auto_check ?? { state: 'error', detail: 'Sin revisar todavía.' };
    const status = t?.status ?? 'pendiente';
    return {
      key: def.key,
      title: def.title(period),
      help: def.help,
      status,
      auto,
      automatic: def.auto,
      ready: taskReady({ key: def.key, status, auto }),
      ownerId: t?.owner_id ?? null,
      evidence: t?.evidence ?? null,
      evidenceUrl: t?.evidence_url ?? null,
      doneBy: t?.done_by ?? null,
      doneAt: t?.done_at ?? null,
      fix: def.fix,
    };
  });
  const progress = progressOf(tasks);
  const pending = progress.total - progress.done;
  return {
    period,
    label: periodLabel(period),
    status: row?.status ?? 'abierto',
    locked: isLocked(row, now),
    closedAt: row?.closed_at ?? null,
    closedBy: row?.closed_by ?? null,
    overrideUntil: row?.override_until ?? null,
    tasks,
    progress,
    pending,
    headline: closeHeadline(period, pending),
  };
}

/**
 * La lista de un mes sin escribir nada. Un mes cerrado no se vuelve a revisar:
 * se muestra como quedó al cerrarlo.
 */
export async function computeClose(
  db: SupabaseClient,
  period: string,
  opts: { now?: Date; modulesOn?: ReadonlySet<ModuleKey> } = {},
): Promise<CloseView> {
  if (!isPeriod(period)) throw new ValidationError('El mes va como AAAA-MM, por ejemplo 2026-09.');
  const now = opts.now ?? new Date();
  const modulesOn = opts.modulesOn ?? (await enabledModules(db));
  const row = await getClosePeriod(db, period);
  const stored = row ? await tasksOf(db, row.id) : [];
  const defs = tasksFor(modulesOn);
  const checks = new Map<string, AutoCheck>();
  if (row?.status !== 'cerrado') {
    const data = await loadCloseCheckData(db, period, modulesOn);
    for (const d of defs) checks.set(d.key, evaluateCheck(d.key, data, period));
  }
  return buildView(period, row, defs, stored, checks, now);
}

/** Crea el mes y sus tareas si faltan (idempotente). */
export async function ensureClosePeriod(
  db: SupabaseClient,
  period: string,
  modulesOn: ReadonlySet<ModuleKey>,
): Promise<ClosePeriodRow> {
  let row = await getClosePeriod(db, period);
  if (!row) {
    const { error } = await db
      .from('close_periods')
      .upsert(
        { period, status: 'abierto' },
        { onConflict: 'organization_id,period', ignoreDuplicates: true },
      );
    if (error) throw error;
    row = await getClosePeriod(db, period);
    if (!row) throw new Error('No se pudo crear el mes del cierre.');
  }
  if (row.status !== 'cerrado') {
    const defs = tasksFor(modulesOn);
    const { error } = await db.from('close_tasks').upsert(
      defs.map((d, i) => ({
        period_id: row?.id,
        period,
        key: d.key,
        title: d.title(period).slice(0, 200),
        position: i,
      })),
      { onConflict: 'organization_id,period,key', ignoreDuplicates: true },
    );
    if (error) throw error;
  }
  return row;
}

/** La lista de un mes, creando lo que falte y guardando la revisión automática. */
export async function refreshClose(
  db: SupabaseClient,
  period: string,
  opts: { now?: Date } = {},
): Promise<CloseView> {
  const modulesOn = await enabledModules(db);
  const row = await ensureClosePeriod(db, period, modulesOn);
  const view = await computeClose(db, period, { now: opts.now, modulesOn });
  if (row.status === 'cerrado') return view;
  const at = new Date().toISOString();
  for (const t of view.tasks) {
    const { error } = await db
      .from('close_tasks')
      .update({ auto_check: t.auto, auto_checked_at: at })
      .eq('period_id', row.id)
      .eq('key', t.key);
    if (error) throw error;
  }
  return view;
}

/** El mes que toca cerrar hoy. */
export async function currentClosePeriod(db: SupabaseClient, today: string): Promise<string> {
  const { data, error } = await db
    .from('close_periods')
    .select('period, status')
    .order('period', { ascending: false })
    .limit(3);
  if (error) throw error;
  const status = new Map(
    ((data ?? []) as Array<{ period: string; status: CloseStatus }>).map((r) => [
      r.period,
      r.status,
    ]),
  );
  return defaultClosePeriod(today, (p) => status.get(p) ?? null);
}

export interface ClosePeriodSummary {
  period: string;
  label: string;
  status: CloseStatus;
  closedAt: string | null;
  closedBy: string | null;
  done: number;
  total: number;
}

export async function listClosePeriods(
  db: SupabaseClient,
  limit = 24,
): Promise<ClosePeriodSummary[]> {
  const { data, error } = await db
    .from('close_periods')
    .select(PERIOD_COLUMNS)
    .order('period', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as ClosePeriodRow[]).map((r) => {
    const s = (r.summary ?? {}) as { done?: number; total?: number };
    return {
      period: r.period,
      label: periodLabel(r.period),
      status: r.status,
      closedAt: r.closed_at,
      closedBy: r.closed_by,
      done: Number(s.done) || 0,
      total: Number(s.total) || 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Decisiones
// ---------------------------------------------------------------------------

export async function markCloseTask(
  db: SupabaseClient,
  input: {
    period: string;
    key: string;
    status: TaskStatus;
    evidence?: string | null;
    evidenceUrl?: string | null;
    ownerId?: string | null;
    userId: string;
    now?: Date;
  },
): Promise<CloseView> {
  if (!isPeriod(input.period)) throw new ValidationError('El mes va como AAAA-MM.');
  const def = taskDef(input.key);
  if (!def) throw new ValidationError(`No hay una tarea «${input.key}» en el cierre.`);
  const modulesOn = await enabledModules(db);
  const row = await ensureClosePeriod(db, input.period, modulesOn);
  if (isLocked(row, input.now ?? new Date())) {
    await recordCloseEvent(db, {
      period: input.period,
      kind: 'bloqueado',
      userId: input.userId,
      detail: `Se intentó marcar «${def.title(input.period)}».`,
    }).catch(() => undefined);
    throw new PeriodLockedError(input.period, 'cambiar la lista del cierre');
  }
  const evidence = input.evidence?.trim().slice(0, 2000) || null;
  if (input.status === 'hecha' && def.auto && !evidence) {
    // Una tarea automática que la revisión no ve al día sólo se da por hecha explicándola.
    const view = await computeClose(db, input.period, { modulesOn });
    const auto = view.tasks.find((t) => t.key === def.key)?.auto;
    if (auto && auto.state !== 'ok' && auto.state !== 'no_aplica')
      throw new ValidationError(
        `La revisión automática todavía ve pendiente «${def.title(input.period)}» (${auto.detail}). Para darla por hecha, explica por qué (evidencia).`,
      );
  }
  if (input.status === 'no_aplica' && !evidence)
    throw new ValidationError('Di por qué no aplica este mes.');
  const url = input.evidenceUrl?.trim() || null;
  if (url && !/^https?:\/\//.test(url))
    throw new ValidationError('El enlace de evidencia empieza por https://');
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    status: input.status,
    evidence,
    evidence_url: url,
    done_by: input.status === 'pendiente' ? null : input.userId,
    done_at: input.status === 'pendiente' ? null : now,
    updated_at: now,
  };
  if (input.ownerId !== undefined) patch.owner_id = input.ownerId;
  const { error } = await db
    .from('close_tasks')
    .update(patch)
    .eq('period_id', row.id)
    .eq('key', def.key);
  if (error) throw error;
  if (row.status === 'abierto') {
    const upd = await db
      .from('close_periods')
      .update({ status: 'en_cierre', started_by: input.userId, started_at: now, updated_at: now })
      .eq('id', row.id)
      .eq('status', 'abierto');
    if (upd.error) throw upd.error;
  }
  await recordCloseEvent(db, {
    period: input.period,
    kind: 'tarea',
    userId: input.userId,
    detail: `${def.title(input.period)} → ${input.status}${evidence ? `: ${evidence.slice(0, 300)}` : ''}`,
    metadata: { key: def.key, status: input.status },
  });
  return computeClose(db, input.period, { modulesOn });
}

/** Asignar responsable (no cambia el estado). */
export async function assignCloseTask(
  db: SupabaseClient,
  input: { period: string; key: string; ownerId: string | null; userId: string },
): Promise<void> {
  const def = taskDef(input.key);
  if (!def) throw new ValidationError(`No hay una tarea «${input.key}» en el cierre.`);
  const row = await ensureClosePeriod(db, input.period, await enabledModules(db));
  if (isLocked(row)) throw new PeriodLockedError(input.period, 'cambiar la lista del cierre');
  const { error } = await db
    .from('close_tasks')
    .update({ owner_id: input.ownerId, updated_at: new Date().toISOString() })
    .eq('period_id', row.id)
    .eq('key', def.key);
  if (error) throw error;
}

export interface CloseResult {
  view: CloseView;
  closed: boolean;
}

/**
 * Cerrar el mes: sólo un administrador o dueño, y sólo con la lista completa
 * (lo que no está al día, hecho con evidencia o marcado no aplica). Guarda la
 * foto del cierre (de ahí sale el PDF) y bloquea los cambios de ese mes.
 */
export async function closePeriod(
  db: SupabaseClient,
  input: { period: string; userId: string; note?: string | null; now?: Date },
): Promise<CloseResult> {
  if (!(await isCompanyManager(db, input.userId)))
    throw new ForbiddenError('Sólo un administrador o dueño cierra el mes.');
  const modulesOn = await enabledModules(db);
  const row = await ensureClosePeriod(db, input.period, modulesOn);
  if (row.status === 'cerrado')
    return { view: await computeClose(db, input.period, { modulesOn }), closed: false };
  const view = await refreshClose(db, input.period, { now: input.now });
  const missing = view.tasks.filter((t) => !t.ready);
  if (missing.length)
    throw new ValidationError(
      `Todavía no se puede cerrar ${view.label}: ${missing.length === 1 ? 'falta' : 'faltan'} ${missing
        .map((t) => `«${t.title}» (${t.auto.detail})`)
        .join('; ')}. Arréglalo, o márcalo hecho con evidencia o como no aplica.`,
    );
  const now = new Date().toISOString();
  const summary = {
    done: view.progress.done,
    total: view.progress.total,
    note: input.note?.trim().slice(0, 500) || null,
    tasks: view.tasks.map((t) => ({
      key: t.key,
      title: t.title,
      status: t.status,
      auto: t.auto,
      evidence: t.evidence,
      doneBy: t.doneBy,
      doneAt: t.doneAt,
    })),
  };
  const { error } = await db
    .from('close_periods')
    .update({
      status: 'cerrado',
      closed_by: input.userId,
      closed_at: now,
      override_until: null,
      override_by: null,
      override_reason: null,
      summary,
      updated_at: now,
    })
    .eq('id', row.id)
    .neq('status', 'cerrado');
  if (error) throw error;
  await recordCloseEvent(db, {
    period: input.period,
    kind: 'cerrado',
    userId: input.userId,
    detail: input.note ?? null,
    metadata: { done: view.progress.done, total: view.progress.total },
  });
  await writeAuditEvent({
    db,
    userId: input.userId as UUID,
    toolId: 'close.close_period',
    input: { period: input.period },
    status: 'ok',
    latencyMs: 0,
    decision: 'confirmed',
    metadata: { done: view.progress.done, total: view.progress.total },
  });
  return { view: await computeClose(db, input.period, { modulesOn }), closed: true };
}

export async function reopenPeriod(
  db: SupabaseClient,
  input: { period: string; userId: string; reason: string },
): Promise<CloseView> {
  if (!(await isCompanyManager(db, input.userId)))
    throw new ForbiddenError('Sólo un administrador o dueño reabre un mes cerrado.');
  const reason = input.reason.trim();
  if (reason.length < 5) throw new ValidationError('Di por qué se reabre el mes.');
  const row = await getClosePeriod(db, input.period);
  if (!row || row.status !== 'cerrado')
    throw new ValidationError(`${periodLabel(input.period)} no está cerrado.`);
  const now = new Date().toISOString();
  const { error } = await db
    .from('close_periods')
    .update({
      status: 'en_cierre',
      reopened_by: input.userId,
      reopened_at: now,
      reopen_reason: reason.slice(0, 500),
      override_until: null,
      override_by: null,
      override_reason: null,
      updated_at: now,
    })
    .eq('id', row.id)
    .eq('status', 'cerrado');
  if (error) throw error;
  await recordCloseEvent(db, {
    period: input.period,
    kind: 'reabierto',
    userId: input.userId,
    detail: reason,
  });
  await writeAuditEvent({
    db,
    userId: input.userId as UUID,
    toolId: 'close.reopen',
    input: { period: input.period, reason },
    status: 'ok',
    latencyMs: 0,
    decision: 'confirmed',
  });
  return computeClose(db, input.period);
}

export interface CloseEventView {
  kind: string;
  userId: string | null;
  detail: string | null;
  at: string;
}

export async function listCloseEvents(
  db: SupabaseClient,
  period: string,
  limit = 50,
): Promise<CloseEventView[]> {
  const { data, error } = await db
    .from('close_events')
    .select('kind, user_id, detail, created_at')
    .eq('period', period)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (
    (data ?? []) as Array<{
      kind: string;
      user_id: string | null;
      detail: string | null;
      created_at: string;
    }>
  ).map((e) => ({ kind: e.kind, userId: e.user_id, detail: e.detail, at: e.created_at }));
}
