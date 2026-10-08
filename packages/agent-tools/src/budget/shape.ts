import type { PnlMonth } from '../ledger/plans';
import { PAYROLL_CONFIDENTIAL_KEY, PAYROLL_CONFIDENTIAL_LABEL } from '../ledger/privacy';
import { categoryLabel, round2 } from '../ledger/shape';

/**
 * EL PRESUPUESTO CONTRA LO REAL (0191). Puro.
 *
 * Un presupuesto son celdas: categoría × mes × monto. Las categorías son las
 * del libro de plata (ventas, otros ingresos, nómina, arriendo…), así que lo
 * real de cada celda sale de `monthlyPnl` sin ninguna tabla de equivalencias.
 *
 * El semáforo, por celda y por acumulado:
 *
 *   gasto    verde ≤ 100 % de lo presupuestado · amarillo hasta 110 % · rojo más.
 *   ingreso  verde ≥ 100 % · amarillo desde 90 % · rojo menos.
 *
 * El mes en curso se compara contra la parte del presupuesto que ya debió
 * pasar (días corridos ÷ días del mes), y se dice: comparar 10 días de gasto
 * contra el mes entero haría ver todo en verde hasta el día 30.
 */

export const BUDGET_STATUSES = ['borrador', 'aprobado', 'archivado'] as const;
export type BudgetStatus = (typeof BUDGET_STATUSES)[number];

export const BUDGET_STATUS_LABEL: Record<BudgetStatus, string> = {
  borrador: 'Borrador',
  aprobado: 'Aprobado',
  archivado: 'Archivado',
};

export const INCOME_CATEGORIES = ['ventas', 'otros_ingresos'] as const;

export type BudgetKind = 'ingreso' | 'gasto';

export function budgetKindOf(category: string): BudgetKind {
  return (INCOME_CATEGORIES as readonly string[]).includes(category) ? 'ingreso' : 'gasto';
}

export function budgetCategoryLabel(category: string): string {
  if (category === PAYROLL_CONFIDENTIAL_KEY) return PAYROLL_CONFIDENTIAL_LABEL;
  if (category === 'sin_categoria') return 'Sin categoría';
  return categoryLabel(category);
}

export interface BudgetCell {
  category: string;
  kind: BudgetKind;
  month: number;
  amount: number;
}

export interface Budget {
  id: string;
  year: number;
  version: number;
  name: string;
  status: BudgetStatus;
  basis: 'ultimo_anio' | 'desde_cero' | 'copia';
  growthPct: number | null;
  currency: string;
  notes: string | null;
  createdBy: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Lo real de cada categoría en un mes del libro (ingresos y gastos). */
export function actualByCategory(m: PnlMonth | undefined): Record<string, number> {
  if (!m) return {};
  const out: Record<string, number> = { ventas: m.sales, otros_ingresos: m.otherIncome };
  for (const [k, v] of Object.entries(m.byCategory)) {
    // La nómina doblada de quien no administra se compara con la línea «nomina».
    const key = k === PAYROLL_CONFIDENTIAL_KEY ? 'nomina' : k;
    out[key] = (out[key] ?? 0) + v;
  }
  return out;
}

/** Redondeo amable para presupuestar: al millar en pesos. */
export function roundBudget(amount: number, currency = 'COP'): number {
  if (currency === 'COP') return Math.max(0, Math.round(amount / 1000) * 1000);
  return Math.max(0, Math.round(amount));
}

/**
 * Un presupuesto desde lo real del año anterior: cada categoría y mes, igual
 * que el año pasado ± `growthPct` (los ingresos con `incomeGrowthPct` si se
 * da). Un mes sin movimiento queda en cero; no se rellena con un promedio.
 */
export function budgetFromActuals(
  lastYear: PnlMonth[],
  opts: { year: number; growthPct: number; incomeGrowthPct?: number | null; currency?: string },
): BudgetCell[] {
  const byMonth = new Map(lastYear.map((m) => [m.month, m]));
  const cells: BudgetCell[] = [];
  for (let month = 1; month <= 12; month++) {
    const actual = actualByCategory(byMonth.get(`${opts.year - 1}-${pad(month)}`));
    for (const [category, value] of Object.entries(actual)) {
      if (value <= 0) continue;
      const kind = budgetKindOf(category);
      const g = kind === 'ingreso' ? (opts.incomeGrowthPct ?? opts.growthPct) : opts.growthPct;
      const amount = roundBudget(value * (1 + g / 100), opts.currency);
      if (amount > 0) cells.push({ category, kind, month, amount });
    }
  }
  return cells;
}

export type Light = 'verde' | 'amarillo' | 'rojo' | 'sin_presupuesto' | 'pendiente' | 'sin_datos';

export const LIGHT_LABEL: Record<Light, string> = {
  verde: 'Dentro de lo presupuestado',
  amarillo: 'Cerca del límite',
  rojo: 'Fuera de lo presupuestado',
  sin_presupuesto: 'Sin presupuesto',
  pendiente: 'Todavía no pasa',
  sin_datos: 'Sin datos reales',
};

export function lightFor(kind: BudgetKind, actual: number, budget: number): Light {
  if (budget <= 0.5) return actual > 0.5 ? 'sin_presupuesto' : 'verde';
  // Un gasto presupuestado con cero real casi siempre es un gasto que no se
  // cargó, no un ahorro: no se pinta verde, se dice que no hay datos.
  if (kind === 'gasto' && actual < 0.5) return 'sin_datos';
  const ratio = actual / budget;
  if (kind === 'gasto') return ratio <= 1 ? 'verde' : ratio <= 1.1 ? 'amarillo' : 'rojo';
  return ratio >= 1 ? 'verde' : ratio >= 0.9 ? 'amarillo' : 'rojo';
}

export interface VsCell {
  month: number;
  budget: number;
  /** Presupuesto contra el que se compara (prorrateado en el mes en curso). */
  budgetToDate: number;
  actual: number | null;
  variance: number | null;
  pct: number | null;
  light: Light;
}

export interface VsRow {
  category: string;
  label: string;
  kind: BudgetKind;
  months: VsCell[];
  ytd: { budget: number; actual: number; variance: number; pct: number | null; light: Light };
  yearBudget: number;
  /** Meses (1–12) de un gasto presupuestado sin ningún real: probablemente faltan por cargar. */
  missingMonths: number[];
}

export { missingExpensesNote } from './notes';

export interface BudgetVsActual {
  year: number;
  /** Último mes con datos que entra al acumulado (0 = el año no ha empezado). */
  throughMonth: number;
  /** Fracción del mes en curso que ya pasó (1 si el mes ya cerró). */
  currentFraction: number;
  rows: VsRow[];
  totals: {
    income: { budget: number; actual: number };
    expense: { budget: number; actual: number };
    margin: { budget: number; actual: number };
    /**
     * Hay ingresos reales y ningún gasto real: el margen real y el
     * «dentro de lo presupuestado» de los gastos no significan nada.
     */
    expensesMissing: boolean;
  };
  /** Categorías con gasto real que no están en el presupuesto. */
  unbudgeted: string[];
}

/**
 * Presupuesto contra lo real de `year`. `history` son los meses del libro
 * (`monthlyPnl`) que cubran el año. Lo que el presupuesto no tiene pero sí se
 * gastó sale como fila «sin presupuesto»: lo no presupuestado también es una
 * desviación.
 */
export function budgetVsActual(
  cells: BudgetCell[],
  history: PnlMonth[],
  opts: { year: number; today: string },
): BudgetVsActual {
  const thisYear = Number(opts.today.slice(0, 4));
  const thisMonth = Number(opts.today.slice(5, 7));
  const throughMonth = opts.year < thisYear ? 12 : opts.year > thisYear ? 0 : thisMonth;
  const dim = new Date(Date.UTC(opts.year, thisMonth, 0)).getUTCDate();
  const currentFraction =
    opts.year === thisYear ? Math.min(Number(opts.today.slice(8, 10)) / dim, 1) : 1;
  const byMonth = new Map(history.map((m) => [m.month, m]));
  const actual = new Map<number, Record<string, number>>();
  for (let m = 1; m <= 12; m++)
    actual.set(m, actualByCategory(byMonth.get(`${opts.year}-${pad(m)}`)));

  const plan = new Map<string, number[]>();
  const kinds = new Map<string, BudgetKind>();
  for (const c of cells) {
    const arr = plan.get(c.category) ?? Array<number>(12).fill(0);
    arr[c.month - 1] = (arr[c.month - 1] ?? 0) + c.amount;
    plan.set(c.category, arr);
    kinds.set(c.category, c.kind);
  }
  const unbudgeted: string[] = [];
  for (let m = 1; m <= throughMonth; m++)
    for (const [cat, v] of Object.entries(actual.get(m) ?? {}))
      if (v > 0.5 && !plan.has(cat)) {
        plan.set(cat, Array<number>(12).fill(0));
        kinds.set(cat, budgetKindOf(cat));
        unbudgeted.push(cat);
      }

  const rows: VsRow[] = [];
  for (const [category, budgets] of plan) {
    const kind = kinds.get(category) ?? budgetKindOf(category);
    const months: VsCell[] = budgets.map((budget, i) => {
      const month = i + 1;
      if (month > throughMonth)
        return {
          month,
          budget,
          budgetToDate: budget,
          actual: null,
          variance: null,
          pct: null,
          light: 'pendiente' as Light,
        };
      const isCurrent = opts.year === thisYear && month === thisMonth;
      const budgetToDate = round2(isCurrent ? budget * currentFraction : budget);
      const a = round2(actual.get(month)?.[category] ?? 0);
      return {
        month,
        budget,
        budgetToDate,
        actual: a,
        variance: round2(a - budgetToDate),
        pct: budgetToDate > 0.5 ? a / budgetToDate : null,
        light: lightFor(kind, a, budgetToDate),
      };
    });
    const ytdBudget = round2(months.slice(0, throughMonth).reduce((s, c) => s + c.budgetToDate, 0));
    const ytdActual = round2(
      months.slice(0, throughMonth).reduce((s, c) => s + (c.actual ?? 0), 0),
    );
    rows.push({
      category,
      label: budgetCategoryLabel(category),
      kind,
      months,
      ytd: {
        budget: ytdBudget,
        actual: ytdActual,
        variance: round2(ytdActual - ytdBudget),
        pct: ytdBudget > 0.5 ? ytdActual / ytdBudget : null,
        light: throughMonth === 0 ? 'pendiente' : lightFor(kind, ytdActual, ytdBudget),
      },
      yearBudget: round2(budgets.reduce((s, v) => s + v, 0)),
      missingMonths:
        kind === 'gasto' ? months.filter((c) => c.light === 'sin_datos').map((c) => c.month) : [],
    });
  }
  rows.sort((a, b) =>
    a.kind !== b.kind
      ? a.kind === 'ingreso'
        ? -1
        : 1
      : b.yearBudget - a.yearBudget || a.label.localeCompare(b.label),
  );
  const sum = (kind: BudgetKind, pick: (r: VsRow) => number) =>
    round2(rows.filter((r) => r.kind === kind).reduce((s, r) => s + pick(r), 0));
  const income = {
    budget: sum('ingreso', (r) => r.ytd.budget),
    actual: sum('ingreso', (r) => r.ytd.actual),
  };
  const expense = {
    budget: sum('gasto', (r) => r.ytd.budget),
    actual: sum('gasto', (r) => r.ytd.actual),
  };
  return {
    year: opts.year,
    throughMonth,
    currentFraction,
    rows,
    totals: {
      income,
      expense,
      margin: {
        budget: round2(income.budget - expense.budget),
        actual: round2(income.actual - expense.actual),
      },
      expensesMissing: income.actual > 0.5 && expense.actual < 0.5,
    },
    unbudgeted,
  };
}

export interface Overrun {
  category: string;
  label: string;
  /** El mes que se pasó (o el acumulado si `scope` es ytd). */
  month: number;
  scope: 'mes' | 'acumulado';
  budget: number;
  actual: number;
  over: number;
  pct: number;
}

/**
 * Los gastos que se salieron del presupuesto: el mes en curso que ya superó
 * el mes ENTERO presupuestado (no el prorrateo: eso sería alarmar el día 3
 * por una factura anual), o el acumulado del año más de 10 % arriba.
 */
export function budgetOverruns(vs: BudgetVsActual): Overrun[] {
  const out: Overrun[] = [];
  if (vs.throughMonth === 0) return out;
  for (const r of vs.rows) {
    if (r.kind !== 'gasto') continue;
    const cell = r.months[vs.throughMonth - 1];
    if (cell && cell.actual !== null && cell.budget > 0.5 && cell.actual > cell.budget) {
      out.push({
        category: r.category,
        label: r.label,
        month: vs.throughMonth,
        scope: 'mes',
        budget: cell.budget,
        actual: cell.actual,
        over: round2(cell.actual - cell.budget),
        pct: cell.actual / cell.budget,
      });
      continue;
    }
    if (r.ytd.budget > 0.5 && r.ytd.actual > r.ytd.budget * 1.1)
      out.push({
        category: r.category,
        label: r.label,
        month: vs.throughMonth,
        scope: 'acumulado',
        budget: r.ytd.budget,
        actual: r.ytd.actual,
        over: round2(r.ytd.actual - r.ytd.budget),
        pct: r.ytd.actual / r.ytd.budget,
      });
  }
  return out.sort((a, b) => b.over - a.over);
}
