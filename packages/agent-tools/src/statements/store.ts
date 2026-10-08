import { ForbiddenError, logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ProviderBalance, ProviderPnl } from '../accounting/providers/reports';
import { listAccountingConnections, openAccountingSession } from '../accounting/store';
import { isCompanyManager } from '../directory/store';
import { loadInventoryOverview } from '../inventory/products';
import { type PnlMonth, monthlyPnl } from '../ledger/plans';
import { canSeePayrollDetail } from '../ledger/privacy';
import { addDays, round2 } from '../ledger/shape';
import { loadLedger } from '../ledger/store';
import type { LedgerMovement } from '../ledger/types';
import { withPayablesOverlay } from '../payables/overlay';
import {
  type BalanceSheet,
  approximateBalance,
  balanceFromProvider,
  providerName,
} from './balance';
import {
  type CategoryClasses,
  EXPENSE_CLASSES,
  type ExpenseClass,
  isExpenseClass,
  mergeClasses,
} from './classify';
import { type Headline, headline } from './headline';
import {
  INCOME_LINES,
  type IncomeStatement,
  type IncomeValues,
  addValues,
  emptyValues,
  expensesMissing,
  incomeStatement,
  incomeValues,
} from './income';
import { type Indicator, computeIndicators } from './indicators';
import { humanReportError } from './report-errors';

/**
 * LO QUE LOS ESTADOS FINANCIEROS LEEN Y GUARDAN (0191).
 *
 * `loadStatements` arma todo lo de /estados (y `statements.get`, y el informe
 * para socios) con una lectura aislada por fuente: si el inventario no está
 * (la 0183 sin aplicar) o el programa contable no contesta, el resto sale y
 * lo que faltó queda nombrado en `gaps`. Nunca «no pude leer» se pinta como
 * cero.
 */

export const COP = 'COP';

function isMissingTable(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === '42P01' || code === 'PGRST205';
}

// ---------------------------------------------------------------------------
// La clasificación de gastos
// ---------------------------------------------------------------------------

export async function readCategoryClasses(db: SupabaseClient): Promise<{
  classes: CategoryClasses;
  custom: Record<string, ExpenseClass>;
}> {
  const { data, error } = await db
    .from('statement_settings')
    .select('category_classes')
    .maybeSingle();
  if (error && !isMissingTable(error)) throw error;
  const saved = ((data as { category_classes?: Record<string, unknown> } | null)
    ?.category_classes ?? {}) as Record<string, unknown>;
  const custom: Record<string, ExpenseClass> = {};
  for (const [k, v] of Object.entries(saved)) if (isExpenseClass(v)) custom[k] = v;
  return { classes: mergeClasses(custom), custom };
}

/** Sólo quien administra o es dueño cambia cómo se clasifican los gastos. */
export async function saveCategoryClasses(
  db: SupabaseClient,
  input: Record<string, string>,
  opts: { userId: string },
): Promise<CategoryClasses> {
  if (!(await isCompanyManager(db, opts.userId)))
    throw new ForbiddenError(
      'Sólo quien administra la empresa cambia cómo se clasifican los gastos.',
    );
  const clean: Record<string, ExpenseClass> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!/^[a-z0-9_]{2,60}$/.test(k) || !isExpenseClass(v)) continue;
    clean[k] = v;
  }
  const { error } = await db.from('statement_settings').upsert(
    {
      category_classes: clean,
      updated_by: opts.userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'organization_id' },
  );
  if (error) throw error;
  return mergeClasses(clean);
}

// ---------------------------------------------------------------------------
// Lo que dijo el programa contable
// ---------------------------------------------------------------------------

export interface AccountingReports {
  provider: string | null;
  balance: { report: ProviderBalance; fetchedAt: string } | null;
  pnl: { report: ProviderPnl; fetchedAt: string } | null;
  pnlPrev: { report: ProviderPnl; fetchedAt: string } | null;
  /** Hay un programa contable conectado (aunque no haya copia todavía). */
  connected: boolean;
}

const pnlKey = (from: string, to: string) => `${from}..${to}`;

/** El último día de un mes («2026-09» → «2026-09-30»). */
export function monthEnd(year: number, month: number): string {
  const next =
    month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
  return addDays(next, -1);
}

function cutoff(year: number, throughMonth: number, today: string): string {
  const end = monthEnd(year, throughMonth);
  return end > today ? today : end;
}

/** El mismo día un año antes (29 de febrero → 28). */
function yearBefore(day: string): string {
  const y = Number(day.slice(0, 4)) - 1;
  const md = day.slice(5);
  return md === '02-29' ? `${y}-02-28` : `${y}-${md}`;
}

export async function readAccountingReports(
  db: SupabaseClient,
  opts: { year: number; throughMonth: number; today: string },
): Promise<AccountingReports> {
  const conns = (await listAccountingConnections(db)).filter((c) => c.enabled);
  const provider = conns[0]?.provider ?? null;
  const empty: AccountingReports = {
    provider,
    balance: null,
    pnl: null,
    pnlPrev: null,
    connected: conns.length > 0,
  };
  if (!provider) return empty;
  const { data, error } = await db
    .from('accounting_report_snapshots')
    .select('kind, period_key, payload, fetched_at')
    .eq('provider', provider)
    .order('fetched_at', { ascending: false })
    .limit(60);
  if (error) {
    if (isMissingTable(error)) return empty;
    throw error;
  }
  const rows = (data ?? []) as Array<{
    kind: 'balance' | 'pnl';
    period_key: string;
    payload: { report?: unknown };
    fetched_at: string;
  }>;
  const asOf = cutoff(opts.year, opts.throughMonth, opts.today);
  const from = `${opts.year}-01-01`;
  const find = <T>(kind: 'balance' | 'pnl', key: string) => {
    const r = rows.find((x) => x.kind === kind && x.period_key === key && x.payload?.report);
    return r ? { report: r.payload.report as T, fetchedAt: r.fetched_at } : null;
  };
  return {
    ...empty,
    balance: find<ProviderBalance>('balance', asOf),
    pnl: find<ProviderPnl>('pnl', pnlKey(from, asOf)),
    pnlPrev: find<ProviderPnl>('pnl', pnlKey(`${opts.year - 1}-01-01`, yearBefore(asOf))),
  };
}

export interface RefreshOutcome {
  provider: string | null;
  fetched: string[];
  errors: string[];
}

/**
 * Pide al programa contable el balance a la fecha de corte y el estado de
 * resultados del año (y del mismo tramo del año anterior), y guarda la copia.
 * Cada lectura en su propio try. Es sólo lectura del programa.
 */
export async function refreshAccountingReports(
  db: SupabaseClient,
  opts: {
    year: number;
    throughMonth: number;
    today: string;
    userId: string | null;
    open?: typeof openAccountingSession;
  },
): Promise<RefreshOutcome> {
  const conns = (await listAccountingConnections(db)).filter((c) => c.enabled);
  const conn = conns[0];
  if (!conn) return { provider: null, fetched: [], errors: [] };
  const name = providerName(conn.provider);
  let session: Awaited<ReturnType<typeof openAccountingSession>>;
  try {
    session = await (opts.open ?? openAccountingSession)(db, conn.id);
  } catch (err) {
    const h = humanReportError(err, 'los estados financieros', name);
    logger.warn({ err, provider: conn.provider }, 'statements: no abrió la sesión contable');
    return { provider: conn.provider, fetched: [], errors: [h.message] };
  }
  if (!session.reports)
    return {
      provider: conn.provider,
      fetched: [],
      errors: [`${name} no entrega estados financieros por API.`],
    };
  const reports = session.reports;
  const asOf = cutoff(opts.year, opts.throughMonth, opts.today);
  const prevTo = yearBefore(asOf);
  const jobs: Array<{
    kind: 'balance' | 'pnl';
    key: string;
    label: string;
    run: () => Promise<unknown>;
  }> = [
    {
      kind: 'balance',
      key: asOf,
      label: 'el balance general',
      run: () => reports.balanceSheet(asOf),
    },
    {
      kind: 'pnl',
      key: pnlKey(`${opts.year}-01-01`, asOf),
      label: 'el estado de resultados',
      run: () => reports.profitAndLoss(`${opts.year}-01-01`, asOf),
    },
    {
      kind: 'pnl',
      key: pnlKey(`${opts.year - 1}-01-01`, prevTo),
      label: 'el estado de resultados del año anterior',
      run: () => reports.profitAndLoss(`${opts.year - 1}-01-01`, prevTo),
    },
  ];
  const fetched: string[] = [];
  const errors: string[] = [];
  for (const job of jobs) {
    try {
      const report = await job.run();
      const { error } = await db.from('accounting_report_snapshots').upsert(
        {
          provider: conn.provider,
          kind: job.kind,
          period_key: job.key,
          payload: { report },
          fetched_at: new Date().toISOString(),
          fetched_by: opts.userId,
        },
        { onConflict: 'organization_id,provider,kind,period_key' },
      );
      if (error) throw error;
      fetched.push(job.label);
    } catch (err) {
      // El detalle técnico va al log; al dueño, una frase humana.
      const h = humanReportError(err, job.label, name);
      logger.warn(
        { err, provider: conn.provider, kind: job.kind, period: job.key },
        'statements: no pude leer el estado del programa contable',
      );
      errors.push(h.message);
    }
  }
  return { provider: conn.provider, fetched, errors };
}

// ---------------------------------------------------------------------------
// Todo junto
// ---------------------------------------------------------------------------

export interface StatementsResult {
  today: string;
  currency: string;
  year: number;
  throughMonth: number;
  classes: CategoryClasses;
  customClasses: Record<string, ExpenseClass>;
  income: IncomeStatement;
  /** Las cifras grandes con su fuente y sin inventar utilidad si faltan gastos. */
  headline: Headline;
  /** Últimos 12 meses de caja (contando el actual), para indicadores y pronóstico. */
  trailing: { from: string; to: string; months: number; values: IncomeValues };
  balance: BalanceSheet;
  /** El balance aproximado siempre (para comparar cuando hay uno contable). */
  approxBalance: BalanceSheet;
  indicators: Indicator[];
  accounting: AccountingReports;
  history: PnlMonth[];
  /** Cartera, cuentas por pagar y ventas/compras facturadas de 12 meses. */
  working: {
    receivables: { total: number; count: number; overdue: number } | null;
    payables: { total: number; count: number; overdue: number } | null;
    cash: { total: number; accounts: number; oldestDays: number | null } | null;
    inventory: { value: number; products: number } | null;
    invoiced12: number | null;
    purchases12: number | null;
  };
  canSeePayroll: boolean;
  gaps: string[];
  /** Lo que pasó al pedirle de nuevo los estados al programa contable. */
  refresh?: RefreshOutcome | null;
}

/**
 * Los meses que de verdad cubren los últimos 12 «con el actual»: el mes en
 * curso va a medias, así que cuenta por la fracción transcurrida. Dividir por
 * 12 enteros inflaba los días de cartera y achicaba el promedio mensual.
 */
export function effectiveMonths(months: number, today: string): number {
  if (months <= 0) return 1;
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const inMonth = Number(monthEnd(y, m).slice(8, 10));
  const elapsed = Math.min(Math.max(Number(today.slice(8, 10)) / inMonth, 1 / inMonth), 1);
  return Math.max(months - 1 + elapsed, 0.1);
}

function sideTotals(movements: LedgerMovement[], kind: 'receivable' | 'payable', today: string) {
  let total = 0;
  let overdue = 0;
  let count = 0;
  for (const m of movements) {
    if (m.status !== 'expected' || m.kind !== kind) continue;
    const pending = m.outstanding ?? m.amount;
    if (pending <= 0.004) continue;
    total += pending;
    count += 1;
    if (m.dueDate && m.dueDate < today) overdue += pending;
  }
  return { total: round2(total), count, overdue: round2(overdue) };
}

function issuedSince(movements: LedgerMovement[], kind: 'receivable' | 'payable', since: string) {
  return round2(
    movements
      .filter((m) => m.kind === kind && m.status !== 'cancelled' && m.date >= since)
      .reduce((s, m) => s + m.amount, 0),
  );
}

export async function loadStatements(
  db: SupabaseClient,
  opts: {
    today: string;
    viewerId: string | null;
    year?: number;
    throughMonth?: number;
    refreshAccounting?: boolean;
  },
): Promise<StatementsResult> {
  const today = opts.today;
  const thisYear = Number(today.slice(0, 4));
  const thisMonth = Number(today.slice(5, 7));
  const year = Math.min(Math.max(opts.year ?? thisYear, thisYear - 2), thisYear);
  const throughMonth = Math.min(
    // Por defecto, hasta el último mes CERRADO: comparar un mes a medias contra
    // el mismo mes entero del año anterior haría ver todo peor. El mes en curso
    // se puede pedir (y se rotula «va en curso»).
    Math.max(opts.throughMonth ?? (year === thisYear ? Math.max(thisMonth - 1, 1) : 12), 1),
    year === thisYear ? thisMonth : 12,
  );
  const gaps: string[] = [];
  const attempt = async <T>(label: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      if (!isMissingTable(err)) gaps.push(label);
      return null;
    }
  };

  const canSeePayroll = await canSeePayrollDetail(db, opts.viewerId);
  const monthsBack = thisYear * 12 + thisMonth - ((year - 1) * 12 + 1) + 1;
  const refresh = opts.refreshAccounting
    ? await attempt('el programa contable', () =>
        refreshAccountingReports(db, { year, throughMonth, today, userId: opts.viewerId }),
      )
    : null;
  const [settings, history, ledger, inventory, accounting] = await Promise.all([
    attempt('la clasificación de gastos', () => readCategoryClasses(db)),
    monthlyPnl(db, {
      months: Math.min(Math.max(monthsBack, 24), 36),
      currency: COP,
      today,
      includePayroll: canSeePayroll,
    }),
    attempt('la cartera y las cuentas por pagar', async () => {
      const l = await loadLedger(db, { today, historyDays: 400, currency: COP });
      return { ...l, movements: await withPayablesOverlay(db, l.movements) };
    }),
    attempt('el inventario', () => loadInventoryOverview(db, { today })),
    attempt('el programa contable', () => readAccountingReports(db, { year, throughMonth, today })),
  ]);
  const classes = settings?.classes ?? mergeClasses(null);
  const income = incomeStatement(history, { year, throughMonth, classes, currency: COP, today });

  // Los últimos 12 meses (con el actual) para los indicadores.
  const last12 = history.slice(-12);
  let trailingValues = emptyValues();
  for (const m of last12) trailingValues = addValues(trailingValues, incomeValues(m, classes));
  const trailing = {
    from: `${last12[0]?.month ?? today.slice(0, 7)}-01`,
    to: today,
    months: last12.length,
    values: trailingValues,
  };

  const movements = ledger?.movements ?? [];
  const receivables = ledger ? sideTotals(movements, 'receivable', today) : null;
  const payables = ledger ? sideTotals(movements, 'payable', today) : null;
  const cashAccounts = ledger?.accounts ?? [];
  const cash = ledger
    ? cashAccounts.length
      ? {
          total: round2(cashAccounts.reduce((s, a) => s + a.balance, 0)),
          accounts: cashAccounts.length,
          oldestDays: Math.max(
            0,
            ...cashAccounts.map((a) =>
              Math.round(
                (Date.parse(`${today}T00:00:00Z`) -
                  Date.parse(`${a.balanceAt.slice(0, 10)}T00:00:00Z`)) /
                  86_400_000,
              ),
            ),
          ),
        }
      : null
    : null;
  const inventoryValue = inventory?.products.some((p) => (p.value ?? 0) > 0)
    ? {
        value: round2(
          inventory.products.reduce((s, p) => s + (p.currency === COP ? (p.value ?? 0) : 0), 0),
        ),
        products: inventory.products.filter((p) => (p.value ?? 0) > 0).length,
      }
    : null;
  const since12 = addDays(today, -365);
  const invoiced12 = ledger ? issuedSince(movements, 'receivable', since12) : null;
  const purchases12 = ledger ? issuedSince(movements, 'payable', since12) : null;

  const approxBalance = approximateBalance({
    asOf: today,
    currency: COP,
    cash,
    receivables: receivables ? { total: receivables.total, count: receivables.count } : null,
    inventory: inventoryValue,
    payables: payables ? { total: payables.total, count: payables.count } : null,
  });
  const acc: AccountingReports = accounting ?? {
    provider: null,
    balance: null,
    pnl: null,
    pnlPrev: null,
    connected: false,
  };
  const balance = acc.balance
    ? balanceFromProvider(acc.balance.report, acc.balance.fetchedAt)
    : approxBalance;

  const pnlSource = `Libro de plata, de caja, ${trailing.from.slice(0, 7)} a ${today.slice(0, 7)}.`;
  const indicators = computeIndicators({
    currency: COP,
    periodLabel: 'últimos 12 meses',
    months: effectiveMonths(trailing.months, today),
    pnlSource,
    revenue: trailingValues.ingresos,
    costOfSales: trailingValues.costo,
    variableExpenses: trailingValues.gastos_variables,
    fixedExpenses: trailingValues.gastos_fijos,
    operatingIncome: trailingValues.utilidad_operacional,
    netIncome: trailingValues.utilidad_neta,
    expensesMissing: expensesMissing(trailingValues),
    invoiced: invoiced12,
    purchases: purchases12,
    balance: {
      basis: balance.basis,
      source:
        balance.basis === 'contable'
          ? `Balance general de ${providerName(balance.provider)} al ${balance.asOf}.`
          : 'Balance aproximado de Cortex (caja, cartera, inventario y cuentas por pagar).',
      currentAssets: balance.currentAssets,
      currentLiabilities: balance.currentLiabilities,
      totalAssets: balance.totalAssets,
      totalLiabilities: balance.totalLiabilities,
    },
    receivables: receivables
      ? { amount: receivables.total, source: 'Facturas de venta por cobrar en el libro.' }
      : null,
    inventory: inventoryValue
      ? { amount: inventoryValue.value, source: 'Existencias × costo promedio en Inventario.' }
      : null,
    payables: payables
      ? { amount: payables.total, source: 'Facturas de proveedor por pagar en el libro.' }
      : null,
  });

  return {
    today,
    currency: COP,
    year,
    throughMonth,
    classes,
    customClasses: settings?.custom ?? {},
    income,
    headline: headline(
      income,
      { pnl: acc.pnl?.report ?? null, pnlPrev: acc.pnlPrev?.report ?? null },
      acc.provider ? providerName(acc.provider) : null,
    ),
    trailing,
    balance,
    approxBalance,
    indicators,
    accounting: acc,
    history,
    working: {
      receivables,
      payables,
      cash,
      inventory: inventoryValue,
      invoiced12,
      purchases12,
    },
    canSeePayroll,
    gaps,
    refresh,
  };
}

export { EXPENSE_CLASSES, INCOME_LINES };
