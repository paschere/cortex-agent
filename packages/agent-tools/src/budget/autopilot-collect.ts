import type { PlanItem } from '../autopilot/types';
import { formatMoney } from '../ledger/forecast-shared';
import type { Overrun } from './shape';

/**
 * EL PILOTO MIRA EL PRESUPUESTO (0191) — la parte pura.
 *
 * Cada mañana: los gastos que se salieron del presupuesto aprobado (o del
 * borrador, si es lo único que hay) — el mes en curso que ya pasó el mes
 * entero presupuestado, o el acumulado del año más de 10 % arriba. Es un
 * AVISO (`tell`): no hay nada que Cortex pueda hacer solo con un gasto que ya
 * salió; la decisión es de la persona. La lectura está en ./autopilot.ts.
 */

export interface SnapshotBudget {
  budgetName: string;
  year: number;
  month: number;
  currency: string;
  overruns: Overrun[];
}

const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

/** Pura: una línea por categoría que se pasó (hasta cuatro, las más grandes). */
export function collectPresupuesto(s: SnapshotBudget | undefined): PlanItem[] {
  if (!s) return [];
  return s.overruns.slice(0, 4).map((o) => ({
    area: 'finanzas',
    title: `${o.label} se pasó del presupuesto`,
    why:
      o.scope === 'mes'
        ? `En ${MONTHS[o.month - 1]} van ${formatMoney(o.actual, s.currency)} y el presupuesto del mes entero era ${formatMoney(o.budget, s.currency)} (${formatMoney(o.over, s.currency)} arriba).`
        : `En lo que va del año van ${formatMoney(o.actual, s.currency)} contra ${formatMoney(o.budget, s.currency)} presupuestados (${Math.round((o.pct - 1) * 100)} % arriba).`,
    proposedAction: null,
    effect: null,
    risk: o.pct > 1.25 ? 'high' : 'medium',
    amount: o.over,
    currency: s.currency,
    dedupeKey: `presupuesto:${s.year}:${o.category}:${o.scope}:${o.scope === 'mes' ? o.month : 'ytd'}`,
    href: '/presupuesto',
  }));
}
