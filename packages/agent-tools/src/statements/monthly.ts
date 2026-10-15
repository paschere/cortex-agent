import { logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ProviderPnl } from '../accounting/providers/reports';
import { listAccountingConnections, openAccountingSession } from '../accounting/store';
import { monthlyPnl } from '../ledger/plans';
import { canSeePayrollDetail } from '../ledger/privacy';
import { moneyText } from '../ledger/shape';
import { providerName } from './balance';
import { incomeValues } from './income';
import { humanReportError } from './report-errors';
import { monthEnd, readCategoryClasses } from './store';

/**
 * EL ESTADO DE RESULTADOS MES A MES, DEL PROGRAMA CONTABLE.
 *
 * Una lectura por mes (el balance de prueba de ese mes, que es lo que Siigo
 * expone; Alegra y QuickBooks entregan su estado de resultados por rango), base
 * causación. Cada mes cerrado se guarda en `accounting_report_snapshots`
 * (kind `pnl`, llave `AAAA-MM-01..AAAA-MM-DD`) y no se vuelve a pedir; el mes en
 * curso se vuelve a leer si la copia tiene más de seis horas. Al lado va la
 * caja del libro de plata, cuando existe.
 */

const MAX_FETCH_PER_CALL = 12;
const TIME_BUDGET_MS = 55_000;
const OPEN_MONTH_TTL_MS = 6 * 60 * 60_000;

const MONTH_ABBR = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
export const monthLabel = (ym: string) => `${MONTH_ABBR[Number(ym.slice(5, 7)) - 1] ?? ym} ${ym.slice(0, 4)}`;

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface MonthlyRow {
  /** AAAA-MM. */
  month: string;
  revenue: number;
  costOfSales: number;
  grossProfit: number;
  operatingExpenses: number;
  operatingIncome: number;
  /** Otros ingresos − otros gastos (no operacionales). */
  nonOperating: number;
  incomeTax: number;
  netIncome: number;
  /** Caja del libro: lo que entró por ventas y la utilidad neta de caja. */
  cashRevenue: number | null;
  cashNet: number | null;
  /** El mes todavía no cierra. */
  inProgress: boolean;
  /** Salió de la copia guardada, no de una lectura nueva. */
  cached: boolean;
}

/** Un estado de resultados de un mes → la fila de la tabla. Puro. */
export function rowFromPnl(
  month: string,
  pnl: ProviderPnl,
  opts: { inProgress?: boolean; cached?: boolean; cash?: { revenue: number; net: number } | null } = {},
): MonthlyRow {
  const grossProfit = round2(pnl.revenue - pnl.costOfSales);
  const operatingIncome = round2(grossProfit - pnl.operatingExpenses);
  return {
    month,
    revenue: pnl.revenue,
    costOfSales: pnl.costOfSales,
    grossProfit,
    operatingExpenses: pnl.operatingExpenses,
    operatingIncome,
    nonOperating: round2(pnl.otherIncome - pnl.otherExpenses),
    incomeTax: pnl.incomeTax ?? 0,
    netIncome: pnl.netIncome,
    cashRevenue: opts.cash ? round2(opts.cash.revenue) : null,
    cashNet: opts.cash ? round2(opts.cash.net) : null,
    inProgress: opts.inProgress ?? false,
    cached: opts.cached ?? false,
  };
}

export function sumRows(rows: MonthlyRow[]): MonthlyRow {
  const add = (pick: (r: MonthlyRow) => number) => round2(rows.reduce((s, r) => s + pick(r), 0));
  const cash = rows.every((r) => r.cashRevenue !== null);
  return {
    month: 'Total',
    revenue: add((r) => r.revenue),
    costOfSales: add((r) => r.costOfSales),
    grossProfit: add((r) => r.grossProfit),
    operatingExpenses: add((r) => r.operatingExpenses),
    operatingIncome: add((r) => r.operatingIncome),
    nonOperating: add((r) => r.nonOperating),
    incomeTax: add((r) => r.incomeTax),
    netIncome: add((r) => r.netIncome),
    cashRevenue: cash && rows.length ? add((r) => r.cashRevenue ?? 0) : null,
    cashNet: cash && rows.length ? add((r) => r.cashNet ?? 0) : null,
    inProgress: false,
    cached: false,
  };
}

export interface MonthlyResult {
  provider: string | null;
  year: number;
  rows: MonthlyRow[];
  /** Meses que no se pudieron leer (falta de tiempo o error). */
  missing: string[];
  errors: string[];
  fetchedMonths: number;
  cachedMonths: number;
}

export function monthlyMarkdown(r: MonthlyResult): string {
  const out: string[] = [];
  const name = r.provider ? providerName(r.provider) : 'el programa contable';
  const money = (n: number) => moneyText(n, 'COP');
  if (!r.rows.length) {
    out.push(`No pude armar el estado de resultados mes a mes de ${name}.`);
  } else {
    const first = r.rows[0]?.month ?? '';
    const last = r.rows[r.rows.length - 1]?.month ?? '';
    out.push(
      `### Estado de resultados mes a mes — ${monthLabel(first)} a ${monthLabel(last)} (contable, causación, ${name})`,
    );
    const withCash = r.rows.some((x) => x.cashRevenue !== null);
    out.push(
      `| Mes | Ventas | Costo | Utilidad bruta | Gastos operacionales | Utilidad operacional | No operacional (neto) | Impuesto de renta | Utilidad neta |${withCash ? ' Caja: ingresos | Caja: neto |' : ''}`,
      `|---|---:|---:|---:|---:|---:|---:|---:|---:|${withCash ? '---:|---:|' : ''}`,
    );
    const line = (x: MonthlyRow, bold = false) => {
      const b = (s: string) => (bold ? `**${s}**` : s);
      return `| ${b(x.month === 'Total' ? 'Total' : `${monthLabel(x.month)}${x.inProgress ? ' (en curso)' : ''}`)} | ${b(money(x.revenue))} | ${b(money(x.costOfSales))} | ${b(money(x.grossProfit))} | ${b(money(x.operatingExpenses))} | ${b(money(x.operatingIncome))} | ${b(money(x.nonOperating))} | ${b(money(x.incomeTax))} | ${b(money(x.netIncome))} |${withCash ? ` ${x.cashRevenue === null ? '—' : money(x.cashRevenue)} | ${x.cashNet === null ? '—' : money(x.cashNet)} |` : ''}`;
    };
    for (const x of r.rows) out.push(line(x));
    if (r.rows.length > 1) out.push(line(sumRows(r.rows), true));
    out.push(
      `De dónde sale: movimientos de cada mes en el balance de prueba de ${name} (ventas = clase 4 operacional; costo = clases 6 y 7; gastos operacionales = grupos 51 y 52; no operacional = otros ingresos − otros gastos). Base causación, no caja.${withCash ? ' La columna de caja es el libro de plata (lo que de verdad entró y salió); no tiene por qué coincidir.' : ''}`,
    );
  }
  if (r.missing.length)
    out.push(
      `Faltan ${r.missing.length} mes(es) por leer (${r.missing.map(monthLabel).join(', ')}). Vuelve a pedirlo y continúa desde ahí: los meses ya leídos quedan guardados.`,
    );
  for (const e of r.errors) out.push(e);
  return out.join('\n');
}

interface Snapshot {
  report: ProviderPnl;
  fetchedAt: string;
}

export async function readMonthlyPnl(
  db: SupabaseClient,
  opts: {
    year: number;
    fromMonth: number;
    throughMonth: number;
    today: string;
    viewerId: string | null;
    refresh?: boolean;
    open?: typeof openAccountingSession;
    nowMs?: () => number;
  },
): Promise<MonthlyResult> {
  const now = opts.nowMs ?? Date.now;
  const started = now();
  const conn = (await listAccountingConnections(db)).filter((c) => c.enabled)[0];
  const result: MonthlyResult = {
    provider: conn?.provider ?? null,
    year: opts.year,
    rows: [],
    missing: [],
    errors: [],
    fetchedMonths: 0,
    cachedMonths: 0,
  };
  if (!conn) {
    result.errors.push(
      'No hay programa contable conectado: sin él no hay estado de resultados contable por mes. Un administrador lo conecta en Integraciones.',
    );
    return result;
  }
  const name = providerName(conn.provider);
  const months: string[] = [];
  for (let m = opts.fromMonth; m <= opts.throughMonth; m++)
    months.push(`${opts.year}-${String(m).padStart(2, '0')}`);

  // Copias guardadas.
  const keyOf = (ym: string) => `${ym}-01..${monthEnd(opts.year, Number(ym.slice(5, 7)))}`;
  const saved = new Map<string, Snapshot>();
  const { data } = await db
    .from('accounting_report_snapshots')
    .select('period_key, payload, fetched_at')
    .eq('provider', conn.provider)
    .eq('kind', 'pnl')
    .in('period_key', months.map(keyOf));
  for (const r of (data ?? []) as Array<{ period_key: string; payload: { report?: ProviderPnl }; fetched_at: string }>)
    if (r.payload?.report) saved.set(r.period_key, { report: r.payload.report, fetchedAt: r.fetched_at });

  const isClosed = (ym: string) => monthEnd(opts.year, Number(ym.slice(5, 7))) < opts.today;
  const usable = (ym: string): Snapshot | null => {
    const s = saved.get(keyOf(ym));
    if (!s || opts.refresh) return null;
    if (isClosed(ym)) {
      // Una copia sacada ANTES de que el mes cerrara no sirve.
      return s.fetchedAt.slice(0, 10) > monthEnd(opts.year, Number(ym.slice(5, 7))) ? s : null;
    }
    return now() - Date.parse(s.fetchedAt) < OPEN_MONTH_TTL_MS ? s : null;
  };

  const pnls = new Map<string, { pnl: ProviderPnl; cached: boolean }>();
  const todo: string[] = [];
  for (const ym of months) {
    const s = usable(ym);
    if (s) {
      pnls.set(ym, { pnl: s.report, cached: true });
      result.cachedMonths += 1;
    } else todo.push(ym);
  }

  if (todo.length) {
    let session: Awaited<ReturnType<typeof openAccountingSession>> | null = null;
    try {
      session = await (opts.open ?? openAccountingSession)(db, conn.id);
    } catch (err) {
      logger.warn({ err, provider: conn.provider }, 'mensual: no abrió la sesión contable');
      result.errors.push(humanReportError(err, 'el estado de resultados mensual', name).message);
    }
    if (session && !session.reports)
      result.errors.push(`${name} no entrega estados financieros por API.`);
    else if (session?.reports) {
      const reports = session.reports;
      let fetched = 0;
      for (const ym of todo) {
        if (fetched >= MAX_FETCH_PER_CALL || now() - started > TIME_BUDGET_MS) break;
        const to = monthEnd(opts.year, Number(ym.slice(5, 7)));
        try {
          const pnl = await reports.profitAndLoss(`${ym}-01`, to);
          pnls.set(ym, { pnl, cached: false });
          fetched += 1;
          result.fetchedMonths += 1;
          await db.from('accounting_report_snapshots').upsert(
            {
              provider: conn.provider,
              kind: 'pnl',
              period_key: keyOf(ym),
              payload: { report: pnl },
              fetched_at: new Date().toISOString(),
              fetched_by: opts.viewerId,
            },
            { onConflict: 'organization_id,provider,kind,period_key' },
          );
        } catch (err) {
          logger.warn({ err, provider: conn.provider, month: ym }, 'mensual: no pude leer un mes');
          result.errors.push(humanReportError(err, `el mes de ${monthLabel(ym)}`, name).message);
          if (/\b429\b|l[ií]mite|ritmo/i.test(err instanceof Error ? err.message : String(err))) break;
        }
      }
    }
  }

  // La caja del libro, mes a mes, si existe.
  const cash = new Map<string, { revenue: number; net: number }>();
  try {
    const thisYear = Number(opts.today.slice(0, 4));
    const thisMonth = Number(opts.today.slice(5, 7));
    const monthsBack = (thisYear - opts.year) * 12 + thisMonth - opts.fromMonth + 1;
    const canSeePayroll = await canSeePayrollDetail(db, opts.viewerId);
    const [history, settings] = await Promise.all([
      monthlyPnl(db, {
        months: Math.min(Math.max(monthsBack, 1), 36),
        currency: 'COP',
        today: opts.today,
        includePayroll: canSeePayroll,
      }),
      readCategoryClasses(db),
    ]);
    for (const m of history) {
      const v = incomeValues(m, settings.classes);
      cash.set(m.month, { revenue: v.ingresos, net: v.utilidad_neta });
    }
  } catch {
    // Sin libro de plata: sólo la parte contable.
  }

  for (const ym of months) {
    const p = pnls.get(ym);
    if (!p) {
      result.missing.push(ym);
      continue;
    }
    result.rows.push(
      rowFromPnl(ym, p.pnl, { inProgress: !isClosed(ym), cached: p.cached, cash: cash.get(ym) ?? null }),
    );
  }
  return result;
}
