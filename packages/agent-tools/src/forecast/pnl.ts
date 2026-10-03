import { categoryKey, formatMoney, normalizeName } from '../ledger/forecast-shared';
import type { PnlMonth } from '../ledger/plans';
import { PAYROLL_CONFIDENTIAL_KEY } from '../ledger/privacy';
import { round2 } from '../ledger/shape';
import type { ScenarioAdjustment } from '../ledger/types';

/**
 * EL PRONÓSTICO DE RESULTADOS A 12 MESES (0191). Puro.
 *
 * Por cada serie —ventas, otros ingresos y cada categoría de gasto— una de
 * dos formas, y se dice cuál:
 *
 *   estacional  con 12 meses completos o más de historia: el promedio de los
 *               últimos 12 meses × el índice del mes del año (cuánto suele
 *               pesar octubre frente al promedio) × la tendencia (los
 *               últimos 3 meses sin estacionalidad frente al promedio,
 *               acotada entre 0,6 y 1,6 para que un mes raro no dispare
 *               todo).
 *   ritmo       con menos historia: el promedio de los últimos 3 meses
 *               completos (o los que haya), igual para cada mes.
 *
 * Encima, lo que ya se sabe: los gastos que se repiten (declarados o
 * confirmados en Finanzas) son un piso de su categoría, y un escenario
 * (subir una categoría, perder un cliente, un ingreso o gasto puntual o
 * recurrente) se aplica después y se reporta aparte. El mes en curso no
 * cuenta como historia: va a medias.
 */

export type ForecastMethod = 'estacional' | 'ritmo' | 'sin_datos';

export interface RecurringHint {
  label: string;
  direction: 'in' | 'out';
  category: string | null;
  /** Equivalente mensual. */
  monthly: number;
}

export interface ClientRun {
  name: string;
  monthly: number;
  recurring: boolean;
}

export interface ForecastMonth {
  month: string;
  sales: number;
  otherIncome: number;
  expenses: number;
  byCategory: Record<string, number>;
  /** Lo que suma el escenario (entradas) y lo que resta (salidas). */
  scenarioIn: number;
  scenarioOut: number;
  margin: number;
}

export interface PnlForecast {
  method: ForecastMethod;
  /** Meses completos de historia usados. */
  basisMonths: number;
  from: string;
  months: ForecastMonth[];
  totals: { sales: number; otherIncome: number; expenses: number; margin: number };
  /** Lo mismo sin el escenario (cuando hay uno). */
  baseTotals: { sales: number; expenses: number; margin: number } | null;
  assumptions: string[];
  seasonalIndex: Record<string, number[]> | null;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${pad((idx % 12) + 1)}`;
}

const moy = (month: string) => Number(month.slice(5, 7));
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
const clampN = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

const hasData = (m: PnlMonth) => m.sales !== 0 || m.otherIncome !== 0 || m.expenses !== 0;

function seriesOf(m: PnlMonth, key: string): number {
  if (key === 'ventas') return m.sales;
  if (key === 'otros_ingresos') return m.otherIncome;
  return m.byCategory[key] ?? 0;
}

/** El índice de cada mes del año (1–12) para una serie, sobre `window`. */
export function seasonalIndex(window: PnlMonth[], key: string): number[] {
  const all = window.map((m) => seriesOf(m, key));
  const avg = mean(all);
  const idx: number[] = [];
  for (let k = 1; k <= 12; k++) {
    const vals = window.filter((m) => moy(m.month) === k).map((m) => seriesOf(m, key));
    idx.push(avg > 0.5 && vals.length ? clampN(mean(vals) / avg, 0.25, 4) : 1);
  }
  return idx;
}

function project(
  complete: PnlMonth[],
  key: string,
  months: string[],
  method: ForecastMethod,
): { values: number[]; index: number[] | null } {
  if (method === 'sin_datos') return { values: months.map(() => 0), index: null };
  if (method === 'ritmo') {
    const level = Math.max(0, mean(complete.slice(-3).map((m) => seriesOf(m, key))));
    return { values: months.map(() => level), index: null };
  }
  const window = complete.slice(-24);
  const last12 = complete.slice(-12).map((m) => seriesOf(m, key));
  const avg12 = mean(last12);
  const index = seasonalIndex(window, key);
  const recent = complete.slice(-3).map((m) => seriesOf(m, key) / (index[moy(m.month) - 1] ?? 1));
  const trend = avg12 > 0.5 ? clampN(mean(recent) / avg12, 0.6, 1.6) : 1;
  return {
    values: months.map((month) => Math.max(0, avg12 * trend * (index[moy(month) - 1] ?? 1))),
    index,
  };
}

export function forecastPnl(input: {
  history: PnlMonth[];
  today: string;
  horizon?: number;
  recurring?: RecurringHint[];
  adjustments?: ScenarioAdjustment[];
  clients?: ClientRun[];
  currency?: string;
}): PnlForecast {
  const currency = input.currency ?? 'COP';
  const fm = (n: number) => formatMoney(n, currency);
  const current = input.today.slice(0, 7);
  const horizon = Math.min(Math.max(input.horizon ?? 12, 1), 24);
  const sorted = [...input.history].sort((a, b) => a.month.localeCompare(b.month));
  // Meses completos: antes del mes en curso, desde el primero con datos.
  const firstData = sorted.findIndex(hasData);
  const complete = (firstData < 0 ? [] : sorted.slice(firstData)).filter((m) => m.month < current);
  const method: ForecastMethod =
    complete.filter(hasData).length >= 12
      ? 'estacional'
      : complete.some(hasData)
        ? 'ritmo'
        : 'sin_datos';
  const months = Array.from({ length: horizon }, (_, i) => addMonths(current, i));
  const recent = complete.slice(-12);
  const expenseKeys = [
    ...new Set(
      recent.flatMap((m) => Object.keys(m.byCategory).filter((k) => (m.byCategory[k] ?? 0) !== 0)),
    ),
  ];

  const assumptions: string[] = [];
  if (method === 'estacional')
    assumptions.push(
      `Con ${complete.length} meses completos de historia: cada mes es el promedio de los últimos 12 × cuánto suele pesar ese mes del año × la tendencia de los últimos 3 meses (acotada entre 0,6 y 1,6).`,
    );
  else if (method === 'ritmo')
    assumptions.push(
      `Hay ${complete.length} ${complete.length === 1 ? 'mes completo' : 'meses completos'} de historia (hacen falta 12 para ver la estacionalidad): cada mes es el promedio de los últimos ${Math.min(3, complete.length)}.`,
    );
  else
    assumptions.push(
      'No hay meses completos con movimientos en el libro: no hay con qué pronosticar.',
    );
  assumptions.push(
    'Es de caja: lo que se espera que entre y salga, no lo que se facture o se cause.',
  );

  const sales = project(complete, 'ventas', months, method);
  const other = project(complete, 'otros_ingresos', months, method);
  const byCat = new Map<string, number[]>();
  for (const k of expenseKeys) byCat.set(k, project(complete, k, months, method).values);

  // Los recurrentes conocidos: piso de su categoría.
  const floors = new Map<string, { monthly: number; labels: string[] }>();
  for (const r of input.recurring ?? []) {
    if (r.direction !== 'out' || r.monthly <= 0) continue;
    const key = r.category ? categoryKey(r.category) || r.category : 'otros_gastos';
    const f = floors.get(key) ?? { monthly: 0, labels: [] };
    f.monthly += r.monthly;
    f.labels.push(r.label);
    floors.set(key, f);
  }
  const raised: string[] = [];
  for (const [key, f] of floors) {
    // La nómina confidencial (quien no administra) es la misma serie que «nomina».
    const target = byCat.has(key)
      ? key
      : key === 'nomina' && byCat.has(PAYROLL_CONFIDENTIAL_KEY)
        ? PAYROLL_CONFIDENTIAL_KEY
        : key;
    const vals = byCat.get(target) ?? months.map(() => 0);
    let lifted = false;
    byCat.set(
      target,
      vals.map((v) => {
        if (v + 0.5 < f.monthly) {
          lifted = true;
          return f.monthly;
        }
        return v;
      }),
    );
    if (lifted) raised.push(`${f.labels.slice(0, 2).join(', ')} (${fm(f.monthly)} al mes)`);
  }
  if (raised.length)
    assumptions.push(
      `Gastos que se repiten y que ninguna proyección puede dejar por debajo: ${raised.join('; ')}.`,
    );

  const base: ForecastMonth[] = months.map((month, i) => {
    const byCategory: Record<string, number> = {};
    for (const [k, vals] of byCat) byCategory[k] = round2(vals[i] ?? 0);
    const expenses = round2(Object.values(byCategory).reduce((s, v) => s + v, 0));
    const s = round2(sales.values[i] ?? 0);
    const o = round2(other.values[i] ?? 0);
    return {
      month,
      sales: s,
      otherIncome: o,
      expenses,
      byCategory,
      scenarioIn: 0,
      scenarioOut: 0,
      margin: round2(s + o - expenses),
    };
  });

  const adjusted = applyAdjustments(
    base,
    input.adjustments ?? [],
    input.clients ?? [],
    assumptions,
    fm,
  );
  const total = (ms: ForecastMonth[]) => ({
    sales: round2(ms.reduce((s, m) => s + m.sales, 0)),
    otherIncome: round2(ms.reduce((s, m) => s + m.otherIncome + m.scenarioIn, 0)),
    expenses: round2(ms.reduce((s, m) => s + m.expenses + m.scenarioOut, 0)),
    margin: round2(ms.reduce((s, m) => s + m.margin, 0)),
  });
  const hasScenario = (input.adjustments ?? []).length > 0;
  const bt = total(base);
  return {
    method,
    basisMonths: complete.length,
    from: months[0] ?? current,
    months: adjusted,
    totals: total(adjusted),
    baseTotals: hasScenario ? { sales: bt.sales, expenses: bt.expenses, margin: bt.margin } : null,
    assumptions,
    seasonalIndex: method === 'estacional' && sales.index ? { ventas: sales.index } : null,
  };
}

function applyAdjustments(
  base: ForecastMonth[],
  adjustments: ScenarioAdjustment[],
  clients: ClientRun[],
  assumptions: string[],
  fm: (n: number) => string,
): ForecastMonth[] {
  if (!adjustments.length) return base;
  const out = base.map((m) => ({ ...m, byCategory: { ...m.byCategory } }));
  for (const a of adjustments) {
    if (a.kind === 'scale_category') {
      const key = categoryKey(a.category) || a.category;
      for (const m of out) {
        if (key === 'ventas') m.sales = round2(m.sales * a.factor);
        else if (key === 'otros_ingresos') m.otherIncome = round2(m.otherIncome * a.factor);
        else if (m.byCategory[key] !== undefined)
          m.byCategory[key] = round2((m.byCategory[key] ?? 0) * a.factor);
      }
      assumptions.push(`Escenario: ${a.category} × ${String(a.factor).replace('.', ',')}.`);
    } else if (a.kind === 'drop_counterparty') {
      const target = normalizeName(a.counterpartyName);
      const client = clients.find(
        (c) => normalizeName(c.name) === target || normalizeName(c.name).includes(target),
      );
      if (client && client.monthly > 0) {
        for (const m of out) m.sales = round2(Math.max(0, m.sales - client.monthly));
        assumptions.push(
          `Escenario: sin ${client.name}, ${fm(client.monthly)} menos de ventas cada mes (lo que factura en promedio).`,
        );
      } else
        assumptions.push(
          `Escenario: no encontré a «${a.counterpartyName}» entre los clientes con ventas en los últimos 12 meses; no cambia nada.`,
        );
    } else if (a.kind === 'add_recurring') {
      const monthly = a.every === 'week' ? (a.amount * 52) / 12 : a.amount;
      const start = a.start.slice(0, 7);
      for (const m of out) {
        if (m.month < start) continue;
        if (a.direction === 'in') m.scenarioIn = round2(m.scenarioIn + monthly);
        else m.scenarioOut = round2(m.scenarioOut + monthly);
      }
      assumptions.push(
        `Escenario: ${a.label}, ${a.direction === 'in' ? 'entra' : 'sale'} ${fm(monthly)} al mes desde ${start}.`,
      );
    } else if (a.kind === 'one_off') {
      const month = a.date.slice(0, 7);
      const m = out.find((x) => x.month === month);
      if (m) {
        if (a.direction === 'in') m.scenarioIn = round2(m.scenarioIn + a.amount);
        else m.scenarioOut = round2(m.scenarioOut + a.amount);
      }
      assumptions.push(
        `Escenario: ${a.label}, ${a.direction === 'in' ? 'entra' : 'sale'} ${fm(a.amount)} en ${month}.`,
      );
    } else if (a.kind === 'delay_counterparty') {
      assumptions.push(
        `Escenario: que ${a.counterpartyName} pague ${a.days} días tarde no cambia los resultados, sólo la caja (míralo en Finanzas).`,
      );
    }
  }
  for (const m of out) {
    m.expenses = round2(Object.values(m.byCategory).reduce((s, v) => s + v, 0));
    m.margin = round2(m.sales + m.otherIncome + m.scenarioIn - m.expenses - m.scenarioOut);
  }
  return out;
}
