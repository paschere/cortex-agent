'use server';

import type { ActionResult, PayLineView } from '@/components/payroll/types';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  type LeaveKind,
  type NoveltyKind,
  type PayrollEmployeeInput,
  type TerminationReason,
  addNovelty,
  approvePayrollPeriod,
  bogotaToday,
  cancelLeave,
  decideLeave,
  ensurePayrollPeriod,
  getPayrollEmployee,
  liquidatePayrollPeriod,
  liquidateTermination,
  listPayrollPeriods,
  markPayrollPeriodPaid,
  payrollAccess,
  readPayrollSettings,
  requestLeave,
  retireEmployee,
  savePayrollEmployee,
  savePayrollSettings,
  vacationBalanceFor,
  voidPayrollNovelty,
  voidPayrollPeriod,
  writeAuditEvent,
} from '@cortex/agent-tools';
import type { UUID } from '@cortex/core';
import { revalidatePath } from 'next/cache';

/**
 * LO QUE SE DECIDE DESDE /nomina (0194).
 *
 * Cada export de un archivo 'use server' es un endpoint que cualquiera con
 * sesión puede llamar, así que la regla de quién puede vive en el almacén
 * (payroll/store.ts): todo lo que toca salarios exige administrar la empresa;
 * pedir y cancelar la propia ausencia, cualquiera; decidirla, quien
 * administra o el jefe directo. Ninguna acción mueve plata.
 */

const PATH = '/nomina';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f-]{36}$/i;

function message(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

async function ctx() {
  const user = await requireSession();
  return { user, db: getOrgScopedClient(user.organization.id) };
}

async function audit(
  user: Awaited<ReturnType<typeof requireSession>>,
  toolId: string,
  input: Record<string, unknown>,
  started: number,
) {
  await writeAuditEvent({
    db: getOrgScopedClient(user.organization.id),
    userId: user.id as UUID,
    toolId,
    // Nunca el salario en el registro de auditoría: sólo ids y fechas.
    input,
    status: 'ok',
    latencyMs: Math.round(performance.now() - started),
    surface: 'web',
    decision: 'confirmed',
  });
}

export async function savePayrollSettingsAction(input: {
  frequency: 'mensual' | 'quincenal';
  exonerated1141: boolean;
  saturdayIsWorkday: boolean;
  responsibleUserId: string | null;
}): Promise<ActionResult> {
  try {
    const { user, db } = await ctx();
    await savePayrollSettings(
      db,
      {
        frequency: input.frequency === 'quincenal' ? 'quincenal' : 'mensual',
        exonerated1141: Boolean(input.exonerated1141),
        saturdayIsWorkday: Boolean(input.saturdayIsWorkday),
        responsibleUserId:
          input.responsibleUserId && UUID_RE.test(input.responsibleUserId)
            ? input.responsibleUserId
            : null,
      },
      { userId: user.id },
    );
    revalidatePath(PATH);
    return { ok: true, note: 'Guardé la configuración de la nómina.' };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo guardar.') };
  }
}

export async function saveEmployeeAction(
  raw: Record<string, unknown>,
): Promise<ActionResult & { id?: string }> {
  // El esquema del almacén valida cada campo; aquí sólo se le da forma.
  const input = raw as PayrollEmployeeInput;
  const started = performance.now();
  try {
    const { user, db } = await ctx();
    const e = await savePayrollEmployee(db, input, { userId: user.id });
    await audit(user, 'payroll.save_employee', { employeeId: e.id, created: !input.id }, started);
    revalidatePath(PATH);
    return {
      ok: true,
      note: input.id ? `Guardé los datos de ${e.name}.` : `${e.name} quedó en la nómina.`,
      id: e.id,
    };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo guardar la persona.') };
  }
}

export async function retireEmployeeAction(input: {
  id: string;
  endDate: string;
  reason: string | null;
}): Promise<ActionResult> {
  try {
    if (!UUID_RE.test(input.id) || !DAY.test(input.endDate))
      return { ok: false, error: 'Falta la fecha de retiro.' };
    const { user, db } = await ctx();
    await retireEmployee(db, input, { userId: user.id });
    revalidatePath(PATH);
    return {
      ok: true,
      note: 'Quedó registrado el retiro. Falta pagarle la liquidación del contrato.',
    };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo registrar el retiro.') };
  }
}

/** Abre el periodo que contiene `day` (o el siguiente al último). */
export async function openPeriodAction(input: {
  start: string;
  end: string;
  payDate?: string | null;
}): Promise<ActionResult & { id?: string }> {
  try {
    if (!DAY.test(input.start) || !DAY.test(input.end))
      return { ok: false, error: 'Fechas inválidas.' };
    const { user, db } = await ctx();
    const settings = await readPayrollSettings(db);
    const p = await ensurePayrollPeriod(
      db,
      {
        start: input.start,
        end: input.end,
        frequency: settings.frequency,
        payDate: input.payDate && DAY.test(input.payDate) ? input.payDate : null,
      },
      { userId: user.id },
    );
    revalidatePath(PATH);
    return { ok: true, note: `Abrí la nómina de ${p.label}.`, id: p.id };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo abrir el periodo.') };
  }
}

export async function liquidatePeriodAction(periodId: string): Promise<ActionResult> {
  const started = performance.now();
  try {
    if (!UUID_RE.test(periodId)) return { ok: false, error: 'Periodo inválido.' };
    const { user, db } = await ctx();
    const r = await liquidatePayrollPeriod(db, periodId, { userId: user.id });
    await audit(user, 'payroll.liquidate_period', { periodId }, started);
    revalidatePath(PATH);
    const warns = r.liquidations.reduce((s, l) => s + l.warnings.length, 0);
    return {
      ok: true,
      note: `Liquidé ${r.liquidations.length} ${r.liquidations.length === 1 ? 'persona' : 'personas'}${r.excluded.length ? ` (${r.excluded.length} por fuera: prestación de servicios o sin contrato en el periodo)` : ''}.${warns ? ` Hay ${warns} ${warns === 1 ? 'aviso' : 'avisos'} por revisar.` : ''}`,
    };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo liquidar.') };
  }
}

export async function approvePeriodAction(periodId: string): Promise<ActionResult> {
  const started = performance.now();
  try {
    if (!UUID_RE.test(periodId)) return { ok: false, error: 'Periodo inválido.' };
    const { user, db } = await ctx();
    const r = await approvePayrollPeriod(db, periodId, { userId: user.id });
    await audit(user, 'payroll.approve_period', { periodId }, started);
    revalidatePath(PATH);
    return {
      ok: true,
      note: `Aprobada. El neto y la PILA quedaron en la caja proyectada; la PILA vence el ${r.pilaDue}${r.pilaByNit ? '' : ' (estimada: configura el NIT en Impuestos)'}. Descarga las instrucciones de pago.`,
    };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo aprobar.') };
  }
}

export async function markPaidAction(periodId: string, paidOn: string): Promise<ActionResult> {
  const started = performance.now();
  try {
    if (!UUID_RE.test(periodId)) return { ok: false, error: 'Periodo inválido.' };
    const { user, db } = await ctx();
    await markPayrollPeriodPaid(db, periodId, {
      userId: user.id,
      paidOn: DAY.test(paidOn) ? paidOn : bogotaToday(),
    });
    await audit(user, 'payroll.mark_paid', { periodId }, started);
    revalidatePath(PATH);
    return { ok: true, note: 'Marcada como pagada.' };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo marcar.') };
  }
}

export async function voidPeriodAction(periodId: string): Promise<ActionResult> {
  try {
    if (!UUID_RE.test(periodId)) return { ok: false, error: 'Periodo inválido.' };
    const { user, db } = await ctx();
    await voidPayrollPeriod(db, periodId, { userId: user.id });
    revalidatePath(PATH);
    return { ok: true, note: 'Periodo anulado.' };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo anular.') };
  }
}

export async function addNoveltyAction(input: {
  employeeId: string;
  kind: string;
  date: string;
  dateTo?: string | null;
  hours?: number | null;
  amount?: number | null;
  note?: string | null;
}): Promise<ActionResult> {
  const started = performance.now();
  try {
    const { user, db } = await ctx();
    await addNovelty(
      db,
      {
        employeeId: input.employeeId,
        kind: input.kind as NoveltyKind,
        date: input.date,
        dateTo: input.dateTo || null,
        hours: input.hours ?? null,
        amount: input.amount ?? null,
        note: input.note ?? null,
      },
      { userId: user.id, source: 'manual' },
    );
    await audit(
      user,
      'payroll.register_novelty',
      { employeeId: input.employeeId, kind: input.kind, date: input.date },
      started,
    );
    revalidatePath(PATH);
    return {
      ok: true,
      note: 'Novedad registrada. Entra cuando se liquide (o se vuelva a liquidar) el periodo.',
    };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo registrar la novedad.') };
  }
}

export async function voidNoveltyAction(id: string): Promise<ActionResult> {
  try {
    if (!UUID_RE.test(id)) return { ok: false, error: 'Novedad inválida.' };
    const { user, db } = await ctx();
    await voidPayrollNovelty(db, id, { userId: user.id });
    revalidatePath(PATH);
    return { ok: true, note: 'Novedad anulada.' };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo anular.') };
  }
}

export async function requestLeaveAction(input: {
  employeeId?: string | null;
  kind: string;
  start: string;
  end: string;
  reason?: string | null;
  evidenceDocumentId?: string | null;
}): Promise<ActionResult> {
  try {
    const { user, db } = await ctx();
    const r = await requestLeave(
      db,
      {
        employeeId: input.employeeId || null,
        kind: input.kind as LeaveKind,
        start: input.start,
        end: input.end,
        reason: input.reason ?? null,
        evidenceDocumentId:
          input.evidenceDocumentId && UUID_RE.test(input.evidenceDocumentId)
            ? input.evidenceDocumentId
            : null,
      },
      { userId: user.id },
    );
    revalidatePath(PATH);
    revalidatePath('/team/yo');
    return {
      ok: true,
      note: `Solicitud enviada: ${r.request.businessDays} días hábiles.${r.warnings.length ? ` ${r.warnings.join(' ')}` : ''}`,
    };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo enviar la solicitud.') };
  }
}

export async function decideLeaveAction(input: {
  id: string;
  decision: 'aprobada' | 'rechazada';
  note?: string | null;
}): Promise<ActionResult> {
  const started = performance.now();
  try {
    if (!UUID_RE.test(input.id)) return { ok: false, error: 'Solicitud inválida.' };
    const { user, db } = await ctx();
    const r = await decideLeave(
      db,
      {
        id: input.id,
        decision: input.decision === 'rechazada' ? 'rechazada' : 'aprobada',
        note: input.note ?? null,
      },
      { userId: user.id },
    );
    await audit(
      user,
      'payroll.leave_decide',
      { requestId: input.id, decision: input.decision },
      started,
    );
    revalidatePath(PATH);
    return {
      ok: true,
      note:
        r.request.status === 'aprobada'
          ? `Aprobada la solicitud de ${r.employeeName}.${r.noveltyId ? ' Ya está en la nómina.' : ' Su periodo ya estaba cerrado: registra la novedad en el siguiente.'}`
          : `Rechazada la solicitud de ${r.employeeName}.`,
    };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo decidir.') };
  }
}

export async function cancelLeaveAction(id: string): Promise<ActionResult> {
  try {
    if (!UUID_RE.test(id)) return { ok: false, error: 'Solicitud inválida.' };
    const { user, db } = await ctx();
    await cancelLeave(db, id, { userId: user.id });
    revalidatePath(PATH);
    return { ok: true, note: 'Solicitud cancelada.' };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo cancelar.') };
  }
}

/** La liquidación del contrato, ESTIMADA, para una persona (sólo quien administra). */
export async function terminationEstimateAction(input: {
  employeeId: string;
  terminationDate: string;
  reason: string;
}): Promise<ActionResult & { lines?: PayLineView[]; total?: number; notes?: string[] }> {
  try {
    if (!UUID_RE.test(input.employeeId) || !DAY.test(input.terminationDate))
      return { ok: false, error: 'Faltan datos.' };
    const { user, db } = await ctx();
    const access = await payrollAccess(db, user.id);
    if (!access.manager)
      return {
        ok: false,
        error: 'La liquidación del contrato la ve sólo quien administra la empresa.',
      };
    const e = await getPayrollEmployee(db, input.employeeId);
    if (!e) return { ok: false, error: 'Esa persona no está en la nómina.' };
    const periods = await listPayrollPeriods(db, { limit: 24 });
    const lastPaid = periods.find((p) => p.status === 'aprobado' || p.status === 'pagado');
    const balance = await vacationBalanceFor(db, e, input.terminationDate);
    const r = liquidateTermination({
      name: e.name,
      contractType: e.contractType,
      salary: e.salary,
      integral: e.integral,
      startDate: e.startDate,
      terminationDate: input.terminationDate,
      reason: input.reason as TerminationReason,
      salaryPaidThrough: lastPaid?.end ?? e.startDate,
      contractEnd: e.endDate,
      vacationDaysPending: Math.max(0, balance.balance),
    });
    return {
      ok: true,
      note: `Estimación con salario pagado hasta ${lastPaid?.end ?? '(sin nóminas aprobadas)'} y ${Math.max(0, balance.balance)} días de vacaciones pendientes.`,
      lines: r.lines.map((l) => ({
        code: l.code,
        group: l.group,
        label: l.label,
        amount: l.amount,
        explanation: l.explanation,
        estimate: true,
      })),
      total: r.total,
      notes: r.notes,
    };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo estimar.') };
  }
}
