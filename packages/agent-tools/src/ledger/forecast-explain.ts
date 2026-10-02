/**
 * LA PROYECCIÓN, EXPLICADA: UNA SEMANA, O LA BASE CONTRA UN ESCENARIO.
 *
 * El dueño no lee tablas: pregunta «¿por qué la semana del 17 queda tan
 * apretada?» o «¿qué pasa si Nexa me paga un mes tarde?». Aquí se contesta en
 * una frase, con las líneas que más pesan primero.
 *
 * Puro: trabaja sobre `ForecastResult` ya calculados.
 */

import { formatDay, formatMoney, mondayOf, toDay } from './forecast-shared';
import { scenarioConditions } from './scenario';
import type { ForecastItem, ForecastResult, ForecastWeek } from './types';

export interface WeekExplanation {
  /** El lunes de la semana pedida. */
  weekStart: string;
  week: ForecastWeek | null;
  /** Las líneas, de la que más pesa a la que menos (por monto esperado). */
  items: ForecastItem[];
  summary: string;
}

function rank(items: readonly ForecastItem[]): ForecastItem[] {
  return [...items].sort(
    (a, b) =>
      b.expectedAmount - a.expectedAmount ||
      (a.direction === b.direction ? 0 : a.direction === 'out' ? -1 : 1) ||
      (a.label < b.label ? -1 : a.label > b.label ? 1 : 0),
  );
}

/** ¿Qué pasa esa semana? Cualquier día de la semana sirve para pedirla. */
export function explainWeek(result: ForecastResult, weekStart: string): WeekExplanation {
  const monday = mondayOf(toDay(weekStart));
  const fm = (n: number) => formatMoney(n, result.currency);
  const week = result.weeks.find((w) => w.start === monday) ?? null;
  if (!week) {
    const first = result.weeks[0]?.start;
    const last = result.weeks[result.weeks.length - 1]?.start;
    return {
      weekStart: monday,
      week: null,
      items: [],
      summary:
        first && last
          ? `La semana del ${formatDay(monday)} está fuera de la proyección (va de la semana del ${formatDay(first)} a la del ${formatDay(last)}).`
          : 'No hay proyección para esa semana.',
    };
  }

  const items = rank(week.items);
  const label = `La semana del ${formatDay(monday)}`;
  const closing = `${week.closing < 0 ? 'cierra en rojo, con' : 'cierra con'} ${fm(week.closing)}`;
  if (items.length === 0) {
    return {
      weekStart: monday,
      week,
      items,
      summary: `${label} no tiene cobros ni pagos esperados: abre y ${closing}.`,
    };
  }
  const flows: string[] = [];
  if (week.inflows > 0) flows.push(`entran ${fm(week.inflows)}`);
  if (week.outflows > 0) flows.push(`salen ${fm(week.outflows)}`);
  const top = items[0] as ForecastItem;
  const biggest = `lo que más pesa: ${top.label}, ${top.direction === 'in' ? 'entran' : 'salen'} ${fm(top.expectedAmount)}`;
  return {
    weekStart: monday,
    week,
    items,
    summary: `${label} abre con ${fm(week.opening)}, ${flows.join(' y ')} (${biggest}) y ${closing}.`,
  };
}

export interface WeekDelta {
  start: string;
  baseClosing: number;
  scenarioClosing: number;
  /** Escenario menos base. Negativo: el escenario deja menos caja. */
  delta: number;
}

export interface ScenarioComparison {
  weeks: WeekDelta[];
  lowest: {
    base: { week: string; closing: number };
    scenario: { week: string; closing: number };
    delta: number;
  };
  /** La primera semana en rojo de cada uno, si la hay. */
  firstNegative: { base: string | null; scenario: string | null };
  /** La semana donde más cambia la caja. */
  biggestChange: WeekDelta | null;
  summary: string;
}

/**
 * La base contra el escenario, semana a semana, y una frase: «Si Nexa paga 30
 * días más tarde, la caja más baja pasa de $ 12 M a $ 4,5 M en la semana del
 * 17 nov.»
 */
export function compareScenarios(
  base: ForecastResult,
  scenario: ForecastResult,
): ScenarioComparison {
  const fm = (n: number) => formatMoney(n, scenario.currency);
  const byStart = new Map(base.weeks.map((w) => [w.start, w]));
  const weeks: WeekDelta[] = [];
  for (const w of scenario.weeks) {
    const b = byStart.get(w.start);
    if (!b) continue;
    weeks.push({
      start: w.start,
      baseClosing: b.closing,
      scenarioClosing: w.closing,
      delta: w.closing - b.closing,
    });
  }
  let biggest: WeekDelta | null = null;
  for (const w of weeks) {
    if (w.delta !== 0 && (!biggest || Math.abs(w.delta) > Math.abs(biggest.delta))) biggest = w;
  }
  const firstNegative = {
    base: base.weeks.find((w) => w.closing < 0)?.start ?? null,
    scenario: scenario.weeks.find((w) => w.closing < 0)?.start ?? null,
  };

  const conditions = scenarioConditions(scenario.scenario, scenario.currency);
  const prefix = conditions
    ? `Si ${conditions}`
    : scenario.scenario
      ? `Con el escenario «${scenario.scenario.label}»`
      : 'Con estos cambios';
  const bl = base.lowest;
  const sl = scenario.lowest;
  let summary: string;
  if (bl.closing === sl.closing && bl.week === sl.week) {
    summary = `${prefix}, la caja más baja no cambia: ${fm(sl.closing)} la semana del ${formatDay(sl.week)}`;
    if (biggest) {
      summary += `; donde más se nota es la semana del ${formatDay(biggest.start)} (${biggest.delta > 0 ? '+' : ''}${fm(biggest.delta)})`;
    }
  } else if (bl.week === sl.week) {
    summary = `${prefix}, la caja más baja pasa de ${fm(bl.closing)} a ${fm(sl.closing)} en la semana del ${formatDay(sl.week)}`;
  } else {
    summary = `${prefix}, la caja más baja pasa de ${fm(bl.closing)} (semana del ${formatDay(bl.week)}) a ${fm(sl.closing)} en la semana del ${formatDay(sl.week)}`;
  }
  if (firstNegative.scenario && !firstNegative.base) {
    summary += `, y queda en rojo desde la semana del ${formatDay(firstNegative.scenario)}`;
  } else if (firstNegative.base && !firstNegative.scenario) {
    summary += ', y ya no queda en rojo';
  } else if (
    firstNegative.base &&
    firstNegative.scenario &&
    firstNegative.base !== firstNegative.scenario
  ) {
    summary += `, y entra en rojo la semana del ${formatDay(firstNegative.scenario)} en vez de la del ${formatDay(firstNegative.base)}`;
  }
  summary += '.';

  return {
    weeks,
    lowest: { base: bl, scenario: sl, delta: sl.closing - bl.closing },
    firstNegative,
    biggestChange: biggest,
    summary,
  };
}

/**
 * Semanas de caja: cuántas semanas completas aguanta la caja antes de la
 * primera que cierra por debajo de la caja mínima (o en rojo, si no hay
 * mínima). 0 = ya esta semana se aprieta. `null` = no se aprieta en todo el
 * horizonte («13+»).
 */
export function cashRunwayWeeks(result: ForecastResult): number | null {
  const floor = result.minimumCash && result.minimumCash > 0 ? result.minimumCash : 0;
  const index = result.weeks.findIndex((w) => w.closing < floor);
  return index === -1 ? null : index;
}

/**
 * ¿Hay algo del libro detrás de esta proyección? Sin cuentas ni nada que
 * entre o salga, la caja «$ 0» no es una cifra: es que no hay datos.
 */
export function hasLedgerCash(result: ForecastResult): boolean {
  return (
    (result.accountCount ?? 0) > 0 ||
    result.startingCash !== 0 ||
    result.weeks.some((w) => w.items.length > 0)
  );
}
