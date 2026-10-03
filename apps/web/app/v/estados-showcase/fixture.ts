import 'server-only';
import {
  EXPENSE_CLASSES,
  INCOME_LINE_META,
  type PnlMonth,
  type StatementsResult,
  approximateBalance,
  computeIndicators,
  incomeStatement,
  incomeValues,
  mergeExpenseClasses,
} from '@cortex/agent-tools';

/**
 * DATOS INVENTADOS PARA LOS SHOWCASES DE 0191 (sólo desarrollo): 24 meses del
 * libro de «Transportes Andinos» con diciembre fuerte, y lo que sale de ellos
 * con los MISMOS cálculos del producto (statements/, budget/, forecast/).
 */

export const TODAY = '2026-10-05';

const pad = (n: number) => String(n).padStart(2, '0');
const SEASON = [0.85, 0.9, 1, 0.95, 1, 1.02, 0.98, 1, 1.05, 1.08, 1.12, 1.35];

export function fixtureHistory(): PnlMonth[] {
  const out: PnlMonth[] = [];
  for (let i = 0; i < 25; i++) {
    const idx = 2024 * 12 + 9 + i; // oct 2024 → oct 2026
    const y = Math.floor(idx / 12);
    const m = (idx % 12) + 1;
    const growth = 1 + i * 0.012;
    const partial = y === 2026 && m === 10 ? 0.18 : 1;
    const sales = Math.round(182_000_000 * (SEASON[m - 1] ?? 1) * growth * partial);
    const byCategory: Record<string, number> = {
      proveedores: Math.round(sales * 0.46),
      transporte: Math.round(sales * 0.07),
      nomina: Math.round(38_500_000 * partial),
      arriendo: Math.round(9_200_000 * partial),
      servicios_publicos: Math.round(2_100_000 * partial),
      software: Math.round(1_600_000 * partial),
      mercadeo: Math.round(3_400_000 * partial * (m === 11 ? 1.8 : 1)),
      bancos_y_financieros: Math.round(1_150_000 * partial),
      impuestos: Math.round(sales * 0.035),
    };
    const expenses = Object.values(byCategory).reduce((s, v) => s + v, 0);
    const otherIncome = Math.round(650_000 * partial);
    out.push({
      month: `${y}-${pad(m)}`,
      sales,
      otherIncome,
      expenses,
      byCategory,
      margin: sales + otherIncome - expenses,
    });
  }
  return out;
}

export function fixtureStatements(
  opts: { year?: number; month?: number; contable?: boolean } = {},
): StatementsResult {
  const history = fixtureHistory();
  const classes = mergeExpenseClasses({ mercadeo: 'variable' });
  const year = opts.year ?? 2026;
  const throughMonth = opts.month ?? 10;
  const income = incomeStatement(history, {
    year,
    throughMonth,
    classes,
    currency: 'COP',
    today: TODAY,
  });
  const last12 = history.slice(-12);
  let ingresos = 0;
  const t = { costo: 0, variable: 0, fijo: 0, op: 0, neta: 0 };
  for (const m of last12) {
    const v = incomeValues(m, classes);
    ingresos += v.ingresos;
    t.costo += v.costo;
    t.variable += v.gastos_variables;
    t.fijo += v.gastos_fijos;
    t.op += v.utilidad_operacional;
    t.neta += v.utilidad_neta;
  }
  const working = {
    receivables: { total: 312_400_000, count: 38, overdue: 96_800_000 },
    payables: { total: 141_700_000, count: 22, overdue: 12_300_000 },
    cash: { total: 168_900_000, accounts: 3, oldestDays: 2 },
    inventory: { value: 54_300_000, products: 41 },
    invoiced12: 2_380_000_000,
    purchases12: 1_120_000_000,
  };
  const approx = approximateBalance({
    asOf: TODAY,
    currency: 'COP',
    cash: working.cash,
    receivables: working.receivables,
    inventory: working.inventory,
    payables: working.payables,
  });
  const balance = approx;
  const indicators = computeIndicators({
    currency: 'COP',
    periodLabel: 'últimos 12 meses',
    months: 12,
    pnlSource: 'Libro de plata, de caja.',
    revenue: ingresos,
    costOfSales: t.costo,
    variableExpenses: t.variable,
    fixedExpenses: t.fijo,
    operatingIncome: t.op,
    netIncome: t.neta,
    invoiced: working.invoiced12,
    purchases: working.purchases12,
    balance: {
      basis: balance.basis,
      source: 'Balance aproximado de Cortex.',
      currentAssets: balance.currentAssets,
      currentLiabilities: balance.currentLiabilities,
      totalAssets: balance.totalAssets,
      totalLiabilities: balance.totalLiabilities,
    },
    receivables: { amount: working.receivables.total, source: 'Facturas de venta por cobrar.' },
    inventory: { amount: working.inventory.value, source: 'Inventario.' },
    payables: { amount: working.payables.total, source: 'Facturas de proveedor por pagar.' },
  });
  return {
    today: TODAY,
    currency: 'COP',
    year,
    throughMonth,
    classes,
    customClasses: { mercadeo: 'variable' },
    income,
    trailing: { from: `${last12[0]?.month}-01`, to: TODAY, months: 12, values: income.ytd },
    balance,
    approxBalance: approx,
    indicators,
    accounting: {
      provider: opts.contable ? 'siigo' : null,
      balance: null,
      pnl: opts.contable
        ? {
            fetchedAt: '2026-10-04T13:00:00Z',
            report: {
              provider: 'siigo',
              from: '2026-01-01',
              to: '2026-09-30',
              currency: 'COP',
              revenue: 1_712_000_000,
              costOfSales: 801_000_000,
              operatingExpenses: 612_000_000,
              otherIncome: 6_100_000,
              otherExpenses: 14_000_000,
              incomeTax: 48_000_000,
              netIncome: 243_100_000,
              lines: [],
              notes: [],
            },
          }
        : null,
      pnlPrev: null,
      connected: Boolean(opts.contable),
    },
    history,
    working,
    canSeePayroll: true,
    gaps: [],
    refresh: null,
  };
}

export const LINES = [...INCOME_LINE_META];
export const CLASS_KEYS = [...EXPENSE_CLASSES];
