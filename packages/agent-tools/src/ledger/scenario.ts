/**
 * «¿Y SI NEXA PAGA UN MES TARDE?» — LOS ESCENARIOS.
 *
 * Un escenario es una lista de ajustes sobre la proyección base, y nada más:
 * no cambia el libro ni el comportamiento aprendido. El agente arma el objeto
 * `Scenario` con una herramienta; aquí se describe en palabras y se aplica a
 * las líneas en borrador antes de repartirlas por semana.
 *
 * CÓMO SE APLICA CADA AJUSTE (en el orden en que vienen):
 *
 *   - delay_counterparty: corre todas las líneas de esa contraparte (cobros y
 *     pagos) los días pedidos. Lo que se corra más allá del horizonte sale.
 *   - drop_counterparty: quita todas sus líneas. «Se pierde Nexa».
 *   - add_recurring: un gasto o ingreso nuevo, cada mes el mismo día que
 *     `start` (o cada semana el mismo día de la semana), desde `start`.
 *   - scale_category: multiplica las líneas de esa categoría (×1,1 = sube 10%).
 *   - one_off: un pago o cobro único. Si la fecha ya pasó, cae esta semana.
 *
 * La contraparte se busca por palabras: «Nexa» encuentra «Nexa Logística
 * S.A.S.». Un ajuste que no encuentra nada no falla: queda dicho en los
 * supuestos, para que nadie crea que se aplicó.
 */

import {
  type DraftItem,
  addDays,
  categoryKey,
  categoryLabel,
  dayNumber,
  dayOfMonth,
  formatDay,
  formatMoney,
  formatPct,
  isoWeekday,
  joinEs,
  monthIndex,
  nameMatches,
  toDay,
  weekdayName,
} from './forecast-shared';
import type { Scenario, ScenarioAdjustment } from './types';

/** Una cláusula para leer después de «Si …»: «Nexa paga 30 días más tarde». */
export function describeAdjustment(a: ScenarioAdjustment, currency = 'COP'): string {
  switch (a.kind) {
    case 'delay_counterparty': {
      const days = Math.round(a.days);
      if (days === 0) return `${a.counterpartyName} paga en las mismas fechas`;
      const n = Math.abs(days);
      return `${a.counterpartyName} paga ${n} ${n === 1 ? 'día' : 'días'} más ${days > 0 ? 'tarde' : 'temprano'}`;
    }
    case 'drop_counterparty':
      return `se pierde ${a.counterpartyName}`;
    case 'add_recurring': {
      const what = a.direction === 'out' ? 'un gasto nuevo' : 'un ingreso nuevo';
      const when =
        a.every === 'month'
          ? `cada mes el día ${Number(toDay(a.start).slice(8, 10))}`
          : `cada ${weekdayName(isoWeekday(toDay(a.start)))}`;
      return `${a.direction === 'out' ? 'sale' : 'entra'} ${what} de ${formatMoney(a.amount, currency)} ${when} desde el ${formatDay(toDay(a.start))} («${a.label}»)`;
    }
    case 'scale_category': {
      const name = categoryLabel(categoryKey(a.category) || a.category);
      if (a.factor <= 0) return `${name} desaparece`;
      if (a.factor === 1) return `${name} sigue igual`;
      const change = Math.abs(a.factor - 1);
      return `${name} ${a.factor > 1 ? 'sube' : 'baja'} ${formatPct(change)}`;
    }
    case 'one_off':
      return a.direction === 'out'
        ? `sale un pago único de ${formatMoney(a.amount, currency)} el ${formatDay(toDay(a.date))} («${a.label}»)`
        : `entra un cobro único de ${formatMoney(a.amount, currency)} el ${formatDay(toDay(a.date))} («${a.label}»)`;
  }
}

/** Las cláusulas juntas: «Nexa paga 30 días más tarde y Nómina sube 10%». */
export function scenarioConditions(
  scenario: Scenario | null | undefined,
  currency = 'COP',
): string {
  if (!scenario || scenario.adjustments.length === 0) return '';
  return joinEs(scenario.adjustments.map((a) => describeAdjustment(a, currency)));
}

/** El escenario en una frase: «Escenario «Nexa se atrasa»: Nexa paga 30 días más tarde.» */
export function describeScenario(scenario: Scenario | null | undefined, currency = 'COP'): string {
  if (!scenario) return 'Sin escenario: la proyección base.';
  const conditions = scenarioConditions(scenario, currency);
  if (!conditions) return `Escenario «${scenario.label}»: sin cambios sobre la base.`;
  return `Escenario «${scenario.label}»: ${conditions}.`;
}

export interface ScenarioContext {
  asOf: string;
  horizonEnd: string;
  currency: string;
}

export interface AppliedScenario {
  items: DraftItem[];
  /** Ajustes que no encontraron nada, en palabras. */
  notes: string[];
}

function matchesCounterparty(item: DraftItem, name: string): boolean {
  return nameMatches(name, item.counterpartyName, item.counterpartyTaxId);
}

function occurrences(
  start: string,
  every: 'week' | 'month',
  asOf: string,
  horizonEnd: string,
): string[] {
  const out: string[] = [];
  if (every === 'week') {
    let d = start;
    if (d < asOf) d = addDays(d, Math.ceil((dayNumber(asOf) - dayNumber(d)) / 7) * 7);
    for (; d <= horizonEnd; d = addDays(d, 7)) out.push(d);
    return out;
  }
  const anchor = Number(start.slice(8, 10));
  for (let mi = monthIndex(start); mi <= monthIndex(horizonEnd); mi++) {
    const d = dayOfMonth(Math.floor(mi / 12), (mi % 12) + 1, anchor);
    if (d >= start && d >= asOf && d <= horizonEnd) out.push(d);
  }
  return out;
}

/** Aplica los ajustes, en orden, a las líneas en borrador. No muta la entrada. */
export function applyScenario(
  items: readonly DraftItem[],
  scenario: Scenario | null | undefined,
  ctx: ScenarioContext,
): AppliedScenario {
  let out = items.map((i) => ({ ...i }));
  const notes: string[] = [];
  if (!scenario) return { items: out, notes };

  scenario.adjustments.forEach((a, index) => {
    const tag = `Escenario: ${describeAdjustment(a, ctx.currency)}.`;
    switch (a.kind) {
      case 'delay_counterparty': {
        let hit = 0;
        const days = Math.round(a.days);
        out = out.map((i) => {
          if (!matchesCounterparty(i, a.counterpartyName)) return i;
          hit++;
          const moved = addDays(i.expectedDate, days);
          return {
            ...i,
            expectedDate: moved < ctx.asOf ? ctx.asOf : moved,
            reason: `${i.reason}. ${tag}`,
          };
        });
        if (!hit)
          notes.push(
            `El escenario corre a «${a.counterpartyName}», pero no hay nada suyo en la proyección.`,
          );
        return;
      }
      case 'drop_counterparty': {
        const before = out.length;
        out = out.filter((i) => !matchesCounterparty(i, a.counterpartyName));
        if (out.length === before) {
          notes.push(
            `El escenario quita a «${a.counterpartyName}», pero no hay nada suyo en la proyección.`,
          );
        }
        return;
      }
      case 'add_recurring': {
        const start = toDay(a.start);
        const dates = occurrences(start, a.every, ctx.asOf, ctx.horizonEnd);
        if (dates.length === 0) {
          notes.push(`«${a.label}» empieza después del horizonte: no cambia estas semanas.`);
        }
        for (const d of dates) {
          out.push({
            label: a.label,
            direction: a.direction,
            amount: Math.round(a.amount),
            probability: 1,
            expectedDate: d,
            reason: tag,
            from: 'scenario',
            recurringId: `scenario-${index}`,
          });
        }
        return;
      }
      case 'scale_category': {
        const target = categoryKey(a.category);
        let hit = 0;
        const factor = Math.max(0, a.factor);
        out = out
          .map((i) => {
            if (!target || categoryKey(i.category) !== target) return i;
            hit++;
            return { ...i, amount: Math.round(i.amount * factor), reason: `${i.reason}. ${tag}` };
          })
          .filter((i) => i.amount > 0);
        if (!hit)
          notes.push(`El escenario cambia «${a.category}», pero no hay líneas de esa categoría.`);
        return;
      }
      case 'one_off': {
        const date = toDay(a.date);
        if (date > ctx.horizonEnd) {
          notes.push(
            `«${a.label}» (${formatDay(date)}) cae después del horizonte: no cambia estas semanas.`,
          );
          return;
        }
        out.push({
          label: a.label,
          direction: a.direction,
          amount: Math.round(a.amount),
          probability: 1,
          expectedDate: date < ctx.asOf ? ctx.asOf : date,
          reason: date < ctx.asOf ? `${tag} La fecha ya pasó: se cuenta esta semana.` : tag,
          from: 'scenario',
          recurringId: null,
        });
        return;
      }
    }
  });

  return { items: out, notes };
}
