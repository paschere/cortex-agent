import { addDays, isoWeekday, mondayOf } from '../ledger/forecast-shared';
import type { ForecastWeek } from '../ledger/types';
import { moneyCop, round2, shortDay } from './shape';

/**
 * CUÁNDO PAGAR CADA FACTURA APROBADA. Puro.
 *
 * La regla, en orden:
 *
 *   1. El día que vence (ni antes: la plata trabaja mejor en la cuenta; ni
 *      después: el proveedor es una relación). Si ya venció, hoy. Sábado y
 *      domingo se corren a un día hábil.
 *   2. NUNCA EN UNA SEMANA QUE QUEDE DEBAJO DE LA CAJA MÍNIMA. Contra la
 *      proyección de 13 semanas (sin estas facturas, para no contarlas dos
 *      veces): si pagar esa semana deja el cierre debajo del mínimo —o empuja
 *      debajo una semana siguiente que estaba bien—, se prueba la semana
 *      siguiente, y así. La sugerencia dice cuántos días se corre y por qué.
 *   3. Si ninguna semana aguanta, se sugiere el vencimiento igual y se avisa:
 *      hay que negociar plazo o mover otro pago. Cortex no decide eso solo.
 *
 * Varias facturas a la vez se reparten por vencimiento (la más vieja primero),
 * y cada una que se programa ya cuenta para las siguientes.
 */

export interface ScheduleCandidate {
  id: string;
  /** Lo que sale del banco (neto de retenciones). */
  amount: number;
  currency: string;
  /** Vencimiento efectivo (factura, o emisión + plazo). */
  dueDate: string;
  /** La fila del libro que la proyección usa para esta factura, si la hay. */
  movementId?: string | null;
  label?: string;
}

export interface ScheduleSuggestion {
  id: string;
  date: string;
  /** Lunes de la semana del pago. */
  weekStart: string | null;
  /** Días después del vencimiento (0 si a tiempo). */
  lateDays: number;
  /** Ninguna semana aguantaba: se sugiere igual, con aviso. */
  belowMinimum: boolean;
  /** Fuera de la proyección (otra moneda o más allá de 13 semanas). */
  unchecked: boolean;
  /** Cierre proyectado de esa semana ya con este pago. */
  closingAfter: number | null;
  reason: string;
}

export interface ScheduleInput {
  today: string;
  currency: string;
  weeks: readonly ForecastWeek[];
  minimumCash: number;
  candidates: readonly ScheduleCandidate[];
}

/** Sábado → viernes (si no es pasado), domingo → lunes. */
export function businessDay(day: string, today: string): string {
  const wd = isoWeekday(day);
  if (wd === 6) {
    const fri = addDays(day, -1);
    return fri >= today ? fri : addDays(day, 2);
  }
  if (wd === 7) return addDays(day, 1);
  return day;
}

function weekIndex(weeks: readonly ForecastWeek[], day: string): number {
  const monday = mondayOf(day);
  return weeks.findIndex((w) => w.start === monday);
}

export function suggestPayDates(input: ScheduleInput): ScheduleSuggestion[] {
  const { weeks, today } = input;
  const minimum = Math.max(0, input.minimumCash || 0);
  const ids = new Set(
    input.candidates.map((c) => c.movementId).filter((id): id is string => Boolean(id)),
  );
  // Cierre de cada semana SIN las facturas que se están programando.
  const base: number[] = [];
  let removed = 0;
  for (const w of weeks) {
    for (const item of w.items) {
      if (item.direction === 'out' && item.movementId && ids.has(item.movementId))
        removed += item.expectedAmount;
    }
    base.push(w.closing + removed);
  }

  const out: ScheduleSuggestion[] = [];
  const ordered = [...input.candidates].sort(
    (a, b) => a.dueDate.localeCompare(b.dueDate) || b.amount - a.amount || a.id.localeCompare(b.id),
  );
  for (const c of ordered) {
    const money = (n: number) => moneyCop(n, c.currency);
    const target = businessDay(c.dueDate < today ? today : c.dueDate, today);
    const w0 = weekIndex(weeks, target);
    if (c.currency !== input.currency || w0 < 0) {
      out.push({
        id: c.id,
        date: target,
        weekStart: w0 >= 0 ? (weeks[w0]?.start ?? null) : null,
        lateDays: Math.max(0, daysBetween(c.dueDate, target)),
        belowMinimum: false,
        unchecked: true,
        closingAfter: null,
        reason:
          c.currency !== input.currency
            ? `Vence el ${shortDay(c.dueDate)}; está en ${c.currency} y la proyección en ${input.currency}, así que no la crucé con la caja.`
            : `Vence el ${shortDay(c.dueDate)}, fuera de las 13 semanas proyectadas.`,
      });
      continue;
    }
    let chosen = -1;
    for (let w = w0; w < weeks.length; w++) {
      const after = (base[w] as number) - c.amount;
      if (after < minimum) continue;
      let hurtsLater = false;
      for (let j = w + 1; j < weeks.length; j++) {
        const b = base[j] as number;
        if (b >= minimum && b - c.amount < minimum) {
          hurtsLater = true;
          break;
        }
      }
      if (!hurtsLater) {
        chosen = w;
        break;
      }
    }
    const below = chosen < 0;
    const wi = below ? w0 : chosen;
    const date = wi === w0 ? target : businessDay((weeks[wi] as ForecastWeek).start, today);
    for (let j = wi; j < base.length; j++) base[j] = (base[j] as number) - c.amount;
    const closingAfter = round2(base[wi] as number);
    const late = Math.max(0, daysBetween(c.dueDate, date));
    let reason: string;
    if (below) {
      reason = `Vence el ${shortDay(c.dueDate)}, pero ninguna de las próximas semanas aguanta ${money(c.amount)} sin bajar de la caja mínima (${money(minimum)}): la semana del pago cerraría en ${money(closingAfter)}. Negocia plazo con el proveedor o mueve otro pago.`;
    } else if (wi === w0) {
      reason =
        c.dueDate < today
          ? `Ya venció (${shortDay(c.dueDate)}): pagar ya. La semana cierra en ${money(closingAfter)}, sobre el mínimo.`
          : `El día que vence. La semana cierra en ${money(closingAfter)}, sobre el mínimo.`;
    } else {
      reason = `Vence el ${shortDay(c.dueDate)}, pero pagarla esa semana dejaba la caja debajo del mínimo (${money(minimum)}); la corro al ${shortDay(date)} (${late} día${late === 1 ? '' : 's'} tarde), cuando la semana cierra en ${money(closingAfter)}.`;
    }
    out.push({
      id: c.id,
      date,
      weekStart: (weeks[wi] as ForecastWeek).start,
      lateDays: late,
      belowMinimum: below,
      unchecked: false,
      closingAfter,
      reason,
    });
  }
  return out;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

// ---------------------------------------------------------------------------
// El programa de pagos por semana
// ---------------------------------------------------------------------------

export interface PlanInvoice {
  id: string;
  supplierName: string;
  docNumber: string;
  amount: number;
  currency: string;
  date: string;
  status: string;
}

export interface PlanWeek {
  start: string;
  end: string;
  items: PlanInvoice[];
  total: number;
  /** De la proyección: con qué abre y cierra la semana (ya con estos pagos). */
  opening: number | null;
  closing: number | null;
  inflows: number | null;
  outflows: number | null;
  minimumCash: number;
  belowMinimum: boolean;
}

/**
 * Los pagos programados agrupados por semana, con la caja proyectada de cada
 * semana. Sólo semanas con pagos; las de otra moneda van sin caja.
 */
export function payPlanByWeek(input: {
  currency: string;
  weeks: readonly ForecastWeek[];
  minimumCash: number;
  invoices: readonly PlanInvoice[];
}): PlanWeek[] {
  const byWeek = new Map<string, PlanInvoice[]>();
  for (const inv of input.invoices) {
    const start = mondayOf(inv.date);
    const list = byWeek.get(start) ?? [];
    list.push(inv);
    byWeek.set(start, list);
  }
  const out: PlanWeek[] = [];
  for (const [start, items] of [...byWeek.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    items.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
    const w = input.weeks.find((x) => x.start === start) ?? null;
    const total = round2(
      items.filter((i) => i.currency === input.currency).reduce((s, i) => s + i.amount, 0),
    );
    const closing = w ? round2(w.closing) : null;
    out.push({
      start,
      end: addDays(start, 6),
      items,
      total,
      opening: w ? round2(w.opening) : null,
      closing,
      inflows: w ? round2(w.inflows) : null,
      outflows: w ? round2(w.outflows) : null,
      minimumCash: input.minimumCash,
      belowMinimum: closing != null && closing < input.minimumCash,
    });
  }
  return out;
}
