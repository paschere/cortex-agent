import type { PlanItem } from '../autopilot/types';
import { formatMoney } from './shape';

/**
 * EL PILOTO MIRA LOS PROYECTOS (migración 0196) — la parte pura.
 *
 * Cada mañana, dos cosas:
 *
 *   · Proyectos que se pasaron del presupuesto (o de las horas, o que ya
 *     pierden plata): SÓLO SE CUENTA. Recortar un proyecto es una decisión
 *     de gerencia, no algo que Cortex pueda proponer en un clic.
 *   · Trabajo terminado sin facturar: SE PREGUNTA. Aprobar deja el pedido y su
 *     factura en borrador en Ventas (`projects.invoice`); emitirla ante la DIAN
 *     sigue siendo otra aprobación.
 *
 * La lectura está en ./autopilot.ts.
 */

export interface SnapshotProject {
  id: string;
  code: string;
  title: string;
  client: string | null;
  currency: string;
  costTotal: number;
  budget: number | null;
  hoursUsed: number;
  budgetHours: number | null;
  margin: number | null;
  unbilled: number;
  status: string;
}

export interface SnapshotProjects {
  overBudget: SnapshotProject[];
  unbilled: SnapshotProject[];
}

export function collectProyectos(s: SnapshotProjects | undefined, _today: string): PlanItem[] {
  if (!s) return [];
  const items: PlanItem[] = [];
  for (const p of s.overBudget.slice(0, 10)) {
    const money = (n: number) => formatMoney(n, p.currency);
    const parts: string[] = [];
    if (p.budget !== null && p.costTotal > p.budget)
      parts.push(`lleva ${money(p.costTotal)} de costo contra ${money(p.budget)} presupuestados`);
    if (p.budgetHours !== null && p.hoursUsed > p.budgetHours)
      parts.push(`${Math.round(p.hoursUsed)} horas de ${Math.round(p.budgetHours)}`);
    if (p.margin !== null && p.margin < 0) parts.push(`con lo que va pierde ${money(-p.margin)}`);
    items.push({
      area: 'gerencia',
      title: `${p.code} ${p.title} se pasó del presupuesto`,
      why: `${p.client ? `${p.client}: ` : ''}${parts.join('; ')}. Revisa en el proyecto qué se está llevando el costo (horas, materiales o gastos).`,
      proposedAction: null,
      effect: null,
      risk: 'medium',
      amount: p.budget !== null ? Math.max(0, p.costTotal - p.budget) : null,
      currency: p.currency,
      counterparty: p.client,
      dedupeKey: `gerencia:proyecto:sobre-presupuesto:${p.id}`,
      href: `/proyectos/${p.id}`,
    });
  }
  for (const p of s.unbilled.slice(0, 10)) {
    items.push({
      area: 'cobro',
      title: `${p.code} ${p.title} está terminado y sin facturar`,
      why: `Faltan ${formatMoney(p.unbilled, p.currency)} por facturar${p.client ? ` a ${p.client}` : ''}. Aprobar deja el pedido y la factura en borrador en Ventas; emitirla es otro clic.`,
      proposedAction: { toolId: 'projects.invoice', input: { project: p.code } },
      effect: 'internal_write',
      risk: 'medium',
      amount: p.unbilled,
      currency: p.currency,
      counterparty: p.client,
      dedupeKey: `cobro:proyecto:sin-facturar:${p.id}`,
      href: `/proyectos/${p.id}`,
    });
  }
  return items;
}
