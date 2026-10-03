import type { SupabaseClient } from '@supabase/supabase-js';
import type { PlanItem } from '../autopilot/types';
import { daysBetween, plural } from '../commitments/shape';
import { LEAVE_LABEL, type LeaveKind } from './co/leave';
import { PERIOD_STATUS_LABEL, type PeriodStatus, periodLabel } from './shape';
import {
  currentPeriodFor,
  listEmployees,
  listLeaveRequests,
  listPeriods,
  readPayrollSettings,
} from './store';

/**
 * EL PILOTO MIRA LA NÓMINA (0194).
 *
 *   La nómina que vence   AVISO (tell): faltan ≤ 5 días para el fin del
 *                         periodo (o ya pasó) y no está aprobada. Cortex no
 *                         liquida ni aprueba solo: eso lo decide una persona.
 *   Ausencias pendientes  PREGUNTA (ask): cada solicitud pendiente propone
 *                         `payroll.leave_decide` aprobada; la persona dice sí
 *                         o no. Es escritura interna y no rutinaria, así que la
 *                         política nunca la hace sola.
 *
 * Ninguna línea lleva salarios: sólo nombres, fechas y estados. La lectura
 * (`loadPayrollSnapshot`) está abajo; los recolectores son puros.
 */

export interface SnapshotPayroll {
  employees: number;
  period: {
    start: string;
    end: string;
    frequency: 'mensual' | 'quincenal';
    label: string;
    status: PeriodStatus | null;
    id: string | null;
  };
  pendingLeave: Array<{
    id: string;
    person: string;
    kind: LeaveKind;
    start: string;
    end: string;
    businessDays: number;
    createdAt: string;
  }>;
}

export function collectNomina(s: SnapshotPayroll | undefined, today: string): PlanItem[] {
  if (!s || s.employees === 0) return [];
  const out: PlanItem[] = [];
  const left = daysBetween(today, s.period.end);
  const done = s.period.status === 'aprobado' || s.period.status === 'pagado';
  if (!done && left <= 5) {
    out.push({
      area: 'pagos',
      title: `La nómina de ${s.period.label} ${s.period.status ? `está ${PERIOD_STATUS_LABEL[s.period.status].toLowerCase()}` : 'no se ha abierto'}`,
      why: `${left < 0 ? `El periodo cerró hace ${plural(-left, 'día')}` : left === 0 ? 'El periodo cierra hoy' : `El periodo cierra en ${plural(left, 'día')}`} y la nómina de ${plural(s.employees, 'persona')} no está aprobada. Faltan las novedades, liquidarla y aprobarla en Nómina; después, pagar desde el banco.`,
      proposedAction: null,
      effect: null,
      risk: left < 0 ? 'high' : 'medium',
      dedupeKey: `nomina:periodo:${s.period.start}:${s.period.end}`,
      href: '/nomina',
    });
  }
  for (const r of s.pendingLeave.slice(0, 6)) {
    const waiting = Math.max(0, daysBetween(r.createdAt.slice(0, 10), today));
    out.push({
      area: 'equipo',
      title: `${r.person} pidió ${LEAVE_LABEL[r.kind].toLowerCase()}`,
      why: `Del ${r.start} al ${r.end} (${plural(r.businessDays, 'día hábil', 'días hábiles')}); lleva ${plural(waiting, 'día')} esperando respuesta${daysBetween(today, r.start) <= 3 ? ' y empieza pronto' : ''}.`,
      proposedAction: {
        toolId: 'payroll.leave_decide',
        input: { requestId: r.id, decision: 'aprobada', person: r.person },
      },
      effect: 'internal_write',
      risk: 'medium',
      counterparty: r.person,
      dedupeKey: `nomina:ausencia:${r.id}`,
      href: '/nomina?tab=ausencias',
    });
  }
  return out;
}

export async function loadPayrollSnapshot(
  db: SupabaseClient,
  today: string,
): Promise<SnapshotPayroll> {
  const [settings, employees, periods, pending] = await Promise.all([
    readPayrollSettings(db),
    listEmployees(db),
    listPeriods(db, { limit: 6 }),
    listLeaveRequests(db, { statuses: ['pendiente'], limit: 30 }),
  ]);
  const inPayroll = employees.filter((e) => e.contractType !== 'prestacion_servicios');
  const range = currentPeriodFor(today, settings.frequency);
  const found = periods.find((p) => p.start === range.start && p.end === range.end) ?? null;
  const names = new Map(employees.map((e) => [e.id, e.name]));
  return {
    employees: inPayroll.length,
    period: {
      ...range,
      frequency: settings.frequency,
      label: periodLabel(range.start, range.end, settings.frequency),
      status: found?.status ?? null,
      id: found?.id ?? null,
    },
    pendingLeave: pending.map((r) => ({
      id: r.id,
      person: names.get(r.employeeId) ?? 'Alguien del equipo',
      kind: r.kind,
      start: r.start,
      end: r.end,
      businessDays: r.businessDays,
      createdAt: r.createdAt,
    })),
  };
}
