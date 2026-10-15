import { round2 } from '../ledger/shape';
import type { BudgetVsActual } from './shape';

/**
 * ALERTAS DE PRESUPUESTO CON UMBRAL PROPIO (0228). Puro.
 *
 * Cada empresa decide cuándo avisar: por defecto a 90 % del presupuesto del
 * mes («Combustible va en 92 % del presupuesto del mes») y a 110 % («se
 * pasó»). Se compara el gasto real del mes contra el presupuesto del mes
 * ENTERO —no el prorrateo—, igual que `budgetOverruns`: alarmar el día 3 por
 * una factura anual sería cansar a quien lee. Los ingresos no alertan aquí.
 */

export const DEFAULT_WARN_PCT = 90;
export const DEFAULT_OVER_PCT = 110;

export interface AlertThresholds {
  enabled: boolean;
  /** Avisa desde este % del presupuesto del mes. */
  warnPct: number;
  /** «Se pasó» desde este %. */
  overPct: number;
}

export const DEFAULT_THRESHOLDS: AlertThresholds = {
  enabled: true,
  warnPct: DEFAULT_WARN_PCT,
  overPct: DEFAULT_OVER_PCT,
};

export type AlertLevel = 'aviso' | 'excedido';

export const ALERT_LEVEL_LABEL: Record<AlertLevel, string> = {
  aviso: 'Cerca del límite',
  excedido: 'Se pasó',
};

/** Valida y acomoda lo que escribió la persona; lanza un mensaje en español. */
export function parseThresholds(input: {
  enabled?: unknown;
  warnPct?: unknown;
  overPct?: unknown;
}): AlertThresholds {
  const warn = Number(input.warnPct ?? DEFAULT_WARN_PCT);
  const over = Number(input.overPct ?? DEFAULT_OVER_PCT);
  if (!Number.isFinite(warn) || warn < 50 || warn > 200)
    throw new Error('El umbral de aviso va entre 50 % y 200 %.');
  if (!Number.isFinite(over) || over < 80 || over > 300)
    throw new Error('El umbral de «se pasó» va entre 80 % y 300 %.');
  if (over <= warn) throw new Error('El umbral de «se pasó» tiene que ser mayor que el de aviso.');
  return {
    enabled: input.enabled === undefined ? true : Boolean(input.enabled),
    warnPct: Math.round(warn),
    overPct: Math.round(over),
  };
}

export interface BudgetAlert {
  category: string;
  label: string;
  year: number;
  month: number;
  level: AlertLevel;
  /** actual ÷ presupuesto del mes (1.12 = 112 %). */
  ratio: number;
  budget: number;
  actual: number;
  over: number;
  /** «Combustible va en 112 % del presupuesto del mes». */
  title: string;
}

export function levelFor(ratio: number, t: AlertThresholds): AlertLevel | null {
  if (ratio * 100 >= t.overPct) return 'excedido';
  if (ratio * 100 >= t.warnPct) return 'aviso';
  return null;
}

/** Los gastos del mes en curso que cruzaron un umbral, los más pasados primero. */
export function budgetAlerts(vs: BudgetVsActual, t: AlertThresholds): BudgetAlert[] {
  if (!t.enabled || vs.throughMonth === 0) return [];
  const out: BudgetAlert[] = [];
  for (const r of vs.rows) {
    if (r.kind !== 'gasto') continue;
    const cell = r.months[vs.throughMonth - 1];
    if (!cell || cell.actual === null || cell.budget <= 0.5) continue;
    const ratio = cell.actual / cell.budget;
    const level = levelFor(ratio, t);
    if (!level) continue;
    out.push({
      category: r.category,
      label: r.label,
      year: vs.year,
      month: vs.throughMonth,
      level,
      ratio,
      budget: cell.budget,
      actual: cell.actual,
      over: round2(cell.actual - cell.budget),
      title: alertTitle({ label: r.label, ratio }),
    });
  }
  return out.sort((a, b) => b.ratio - a.ratio);
}

export function alertPct(ratio: number): number {
  return Math.round(ratio * 100);
}

/** «Combustible va en 112 % del presupuesto del mes». */
export function alertTitle(a: Pick<BudgetAlert, 'label' | 'ratio'>): string {
  const label = a.label.charAt(0).toUpperCase() + a.label.slice(1);
  return `${label} va en ${alertPct(a.ratio)} % del presupuesto del mes`;
}

/**
 * El enlace al detalle de lo que pasó en esa categoría ese mes: la propia
 * pantalla de presupuesto, que lista los movimientos.
 */
export function alertHref(a: Pick<BudgetAlert, 'category' | 'year' | 'month'>): string {
  return `/presupuesto?anio=${a.year}&detalle=${encodeURIComponent(a.category)}&mes=${a.month}`;
}
