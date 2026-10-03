import type { QuickBooksClient } from './quickbooks-client';
import {
  type ProviderBalance,
  type ProviderPnl,
  type ProviderReports,
  type ReportLine,
  parseAmount,
  round2,
} from './reports';

/**
 * LOS ESTADOS FINANCIEROS DE QUICKBOOKS ONLINE (0191).
 *
 * Reports API de Intuit (developer.intuit.com › Run reports):
 *
 *   GET /v3/company/{realm}/reports/BalanceSheet?start_date&end_date&accounting_method
 *   GET /v3/company/{realm}/reports/ProfitAndLoss?start_date&end_date&accounting_method
 *
 * La respuesta es `{ Header, Columns, Rows: { Row: [...] } }`: cada `Row` de
 * tipo `Section` trae `group` (TotalAssets, CurrentAssets, Income, COGS…),
 * sus filas y un `Summary` con el total. Con el resumen por `Total` la cifra
 * es la segunda columna. Es una LECTURA.
 */

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : null;

interface QbSection {
  group: string | null;
  title: string;
  total: number | null;
  rows: Array<{ name: string; amount: number }>;
}

function colValues(row: Raw | null, key: 'ColData'): Array<string | undefined> {
  const cols = Array.isArray(row?.[key]) ? (row?.[key] as Raw[]) : [];
  return cols.map((c) => (c.value === undefined || c.value === null ? undefined : String(c.value)));
}

/** Todas las secciones del reporte, a cualquier profundidad, con su total. */
export function quickbooksSections(report: unknown): QbSection[] {
  const out: QbSection[] = [];
  const walk = (rows: unknown) => {
    const list = Array.isArray(obj(rows)?.Row) ? (obj(rows)?.Row as Raw[]) : [];
    for (const r of list) {
      const header = colValues(obj(r.Header), 'ColData');
      const summary = colValues(obj(r.Summary), 'ColData');
      if (r.type === 'Section' || r.Rows || r.Summary) {
        const direct: Array<{ name: string; amount: number }> = [];
        const inner = Array.isArray(obj(r.Rows)?.Row) ? (obj(r.Rows)?.Row as Raw[]) : [];
        for (const d of inner) {
          if (d.type === 'Data' || d.ColData) {
            const v = colValues(d, 'ColData');
            const amount = parseAmount(v[v.length - 1]);
            if (v[0] && amount !== null) direct.push({ name: v[0], amount });
          } else if (d.Summary) {
            const s = colValues(obj(d.Summary), 'ColData');
            const amount = parseAmount(s[s.length - 1]);
            const name = colValues(obj(d.Header), 'ColData')[0] ?? s[0];
            if (name && amount !== null) direct.push({ name, amount });
          }
        }
        out.push({
          group: typeof r.group === 'string' ? r.group : null,
          title: header[0] ?? summary[0] ?? '',
          total: parseAmount(summary[summary.length - 1]),
          rows: direct,
        });
        walk(r.Rows);
      }
    }
  };
  walk(obj(report)?.Rows);
  return out;
}

const groupTotal = (sections: QbSection[], group: string) =>
  sections.find((s) => s.group === group)?.total ?? null;

function currencyOf(report: unknown, fallback: string): string {
  const c = obj(obj(report)?.Header)?.Currency;
  return typeof c === 'string' && /^[A-Z]{3}$/.test(c) ? c : fallback;
}

export function quickbooksBalanceFrom(
  report: unknown,
  asOf: string,
  fallbackCurrency: string,
): ProviderBalance {
  const s = quickbooksSections(report);
  const totalAssets = groupTotal(s, 'TotalAssets') ?? 0;
  const currentAssets = groupTotal(s, 'CurrentAssets');
  const totalLiabilities = groupTotal(s, 'Liabilities') ?? 0;
  const currentLiabilities = groupTotal(s, 'CurrentLiabilities');
  const longTerm = groupTotal(s, 'LongTermLiabilities');
  const equity = groupTotal(s, 'Equity') ?? 0;
  const lines: ReportLine[] = [];
  const add = (section: string, group: string) => {
    const sec = s.find((x) => x.group === group);
    if (sec)
      for (const r of sec.rows) lines.push({ section, name: r.name, amount: round2(r.amount) });
  };
  add('activo_corriente', 'CurrentAssets');
  add('activo_no_corriente', 'FixedAssets');
  add('activo_no_corriente', 'OtherAssets');
  add('pasivo_corriente', 'CurrentLiabilities');
  add('pasivo_no_corriente', 'LongTermLiabilities');
  add('patrimonio', 'Equity');
  return {
    provider: 'quickbooks',
    asOf,
    currency: currencyOf(report, fallbackCurrency),
    totalAssets: round2(totalAssets),
    currentAssets: currentAssets === null ? null : round2(currentAssets),
    nonCurrentAssets: currentAssets === null ? null : round2(totalAssets - currentAssets),
    totalLiabilities: round2(totalLiabilities),
    currentLiabilities: currentLiabilities === null ? null : round2(currentLiabilities),
    nonCurrentLiabilities:
      longTerm !== null
        ? round2(longTerm)
        : currentLiabilities === null
          ? null
          : round2(totalLiabilities - currentLiabilities),
    equity: round2(equity),
    lines,
    notes: ['Fuente: Balance Sheet de QuickBooks Online (base causación).'],
  };
}

export function quickbooksPnlFrom(
  report: unknown,
  from: string,
  to: string,
  fallbackCurrency: string,
): ProviderPnl {
  const s = quickbooksSections(report);
  const revenue = groupTotal(s, 'Income') ?? 0;
  const cost = groupTotal(s, 'COGS') ?? 0;
  const opex = groupTotal(s, 'Expenses') ?? 0;
  const otherIncome = groupTotal(s, 'OtherIncome') ?? 0;
  const otherExpenses = groupTotal(s, 'OtherExpenses') ?? 0;
  const net = groupTotal(s, 'NetIncome');
  const lines: ReportLine[] = [];
  const add = (section: string, group: string) => {
    const sec = s.find((x) => x.group === group);
    if (sec)
      for (const r of sec.rows) lines.push({ section, name: r.name, amount: round2(r.amount) });
  };
  add('ingreso', 'Income');
  add('costo', 'COGS');
  add('gasto', 'Expenses');
  add('otro_ingreso', 'OtherIncome');
  add('otro_gasto', 'OtherExpenses');
  return {
    provider: 'quickbooks',
    from,
    to,
    currency: currencyOf(report, fallbackCurrency),
    revenue: round2(revenue),
    costOfSales: round2(cost),
    operatingExpenses: round2(opex),
    otherIncome: round2(otherIncome),
    otherExpenses: round2(otherExpenses),
    incomeTax: null,
    netIncome: round2(net ?? revenue + otherIncome - cost - opex - otherExpenses),
    lines,
    notes: ['Fuente: Profit and Loss de QuickBooks Online (base causación).'],
  };
}

export function quickbooksReports(
  client: () => QuickBooksClient,
  currency: () => Promise<string>,
): ProviderReports {
  return {
    async balanceSheet(asOf) {
      const report = await client().get<unknown>(
        '/reports/BalanceSheet',
        { start_date: `${asOf.slice(0, 4)}-01-01`, end_date: asOf, accounting_method: 'Accrual' },
        'BalanceSheet',
      );
      return quickbooksBalanceFrom(report, asOf, await currency());
    },
    async profitAndLoss(from, to) {
      const report = await client().get<unknown>(
        '/reports/ProfitAndLoss',
        { start_date: from, end_date: to, accounting_method: 'Accrual' },
        'ProfitAndLoss',
      );
      return quickbooksPnlFrom(report, from, to, await currency());
    },
  };
}
