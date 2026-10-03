import { z } from 'zod';
import { bogotaToday, plural } from '../commitments/shape';
import { registerTool } from '../index';
import { NOVELTY_KINDS, NOVELTY_LABEL, cop } from './co/engine';
import { LEAVE_KINDS, LEAVE_LABEL } from './co/leave';
import { COMP_SENSITIVITY_NOTE } from './sensitive';
import { LEAVE_STATUS_LABEL, PERIOD_STATUS_LABEL, type PayrollPeriod } from './shape';
import {
  addNovelty,
  approvePeriod,
  decideLeave,
  findEmployee,
  getEmployee,
  getPeriod,
  listLeaveRequests,
  listPayslips,
  listPeriods,
  loadPeriodLiquidations,
  payrollAccess,
  requestLeave,
  vacationBalanceFor,
} from './store';

/**
 * LAS HERRAMIENTAS DE LA NÓMINA PROPIA (0194). Conviven con las del servicio
 * aparte (payroll.team_overview, payroll.employee_profile…): ésas leen lo que
 * se pagó en el otro sistema; éstas, la nómina que se liquida en Cortex.
 *
 *   payroll.period_summary   lectura: el periodo (estado y totales). Quien
 *                            administra ve además el detalle por persona;
 *                            los demás, a lo sumo totales.
 *   payroll.register_novelty registra una novedad (horas extra, incapacidad…).
 *                            Confirmación; sólo quien administra.
 *   payroll.approve_period   aprueba la nómina liquidada. Confirmación; sólo
 *                            quien administra. No paga nada.
 *   payroll.payslip          lectura: el desprendible de quien pregunta (quien
 *                            administra puede pedir el de otro).
 *   payroll.leave_request    pedir vacaciones / permiso / licencia para sí.
 *   payroll.leave_status     lectura: saldo de vacaciones y solicitudes propias
 *                            (quien administra o aprueba: las pendientes).
 *   payroll.leave_decide     aprobar o rechazar. Confirmación; quien administra
 *                            o el jefe directo.
 *
 * La regla de quién ve qué vive en store.ts; aquí sólo se respeta.
 */

const NOTE_LOCAL =
  'FUENTE: la nómina que se liquida en Cortex (pantalla Nómina), con los parámetros legales colombianos vigentes.';

function periodLine(p: PayrollPeriod): string {
  return `${p.label}: ${PERIOD_STATUS_LABEL[p.status].toLowerCase()}`;
}

export const payrollPeriodSummary = registerTool({
  id: 'payroll.period_summary',
  description: `El periodo de nómina liquidado en Cortex: estado (borrador, liquidado, aprobado, pagado), día de pago y totales (devengado, deducciones, neto, aportes, provisiones, costo para la empresa). Úsala para «¿cómo va la nómina de este mes?», «¿cuánto cuesta la nómina?», «¿ya se aprobó la quincena?». Quien administra la empresa ve también el neto por persona; cualquier otra persona sólo totales. ${NOTE_LOCAL} ${COMP_SENSITIVITY_NOTE}`,
  inputSchema: z.object({
    periodId: z
      .string()
      .uuid()
      .nullish()
      .describe('Un periodo concreto; por defecto, el más reciente.'),
    detail: z
      .boolean()
      .default(false)
      .describe('Incluir el neto por persona (sólo si quien pregunta administra).'),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    period: z.any().nullable(),
    people: z.array(z.object({ name: z.string(), neto: z.number(), costoTotal: z.number() })),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const access = await payrollAccess(ctx.db, ctx.userId);
    const period = input.periodId
      ? await getPeriod(ctx.db, input.periodId)
      : ((await listPeriods(ctx.db, { limit: 1 }))[0] ?? null);
    if (!period)
      return {
        found: false,
        period: null,
        people: [],
        guidance:
          'Todavía no hay ninguna nómina liquidada en Cortex. Se arma en Nómina (menú Más): se registran las personas, se abre el periodo y se liquida. No inventes cifras.',
      };
    const t = period.totals;
    const people =
      access.manager && input.detail && period.status !== 'borrador'
        ? (
            await loadPeriodLiquidations(ctx.db, [period.id], { userId: ctx.userId })
          ).liquidations.map((l) => ({
            name: l.employeeName,
            neto: l.totals.neto,
            costoTotal: l.totals.costoTotal,
          }))
        : [];
    const lines = [
      `${periodLine(period)} (pago el ${period.payDate}).`,
      period.status === 'borrador'
        ? 'Está en borrador: falta liquidarla en Nómina.'
        : `${plural(t.employees, 'persona')}: devengado ${cop(t.devengado)}, deducciones ${cop(t.deducciones)}, neto a pagar ${cop(t.neto)}; aportes de la empresa ${cop(t.aportes)} y provisiones ${cop(t.provisiones)} → costo total ${cop(t.costoTotal)}.`,
      t.seguridadSocial
        ? `A la PILA van ${cop(t.seguridadSocial)} (empresa + lo descontado).`
        : null,
      access.manager
        ? input.detail
          ? null
          : 'Puedo dar el neto por persona si lo pide quien administra (detail=true).'
        : 'Los salarios por persona son confidenciales: sólo los ve quien administra y cada persona el suyo (payroll.payslip).',
      period.status === 'liquidado'
        ? 'Falta aprobarla (payroll.approve_period, con confirmación) después de revisarla en Nómina.'
        : null,
      'Cortex nunca paga la nómina: deja las instrucciones y lo pendiente en la caja proyectada.',
    ];
    return {
      found: true,
      period: {
        id: period.id,
        label: period.label,
        status: period.status,
        start: period.start,
        end: period.end,
        payDate: period.payDate,
        totals: period.totals,
      },
      people,
      guidance: lines.filter(Boolean).join('\n'),
    };
  },
});

export const payrollRegisterNovelty = registerTool({
  id: 'payroll.register_novelty',
  description:
    'Registrar una novedad de nómina de una persona: horas extra o recargos (en horas, con el día), incapacidades, licencias, vacaciones o ausencias (rango de días), comisiones, bonificaciones o una deducción autorizada (valor). Entra a la liquidación del periodo que contiene la fecha, con la tarifa vigente ese día. Sólo quien administra la empresa. Requiere confirmación. Para vacaciones o permisos que pide la persona, mejor payroll.leave_request.',
  inputSchema: z.object({
    person: z.string().min(2).describe('Nombre, documento o correo de la persona.'),
    kind: z.enum(NOVELTY_KINDS),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe('Día de la novedad, o primer día del rango.'),
    dateTo: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullish()
      .describe('Último día (incapacidades, licencias, vacaciones).'),
    hours: z.number().positive().max(400).nullish(),
    amount: z.number().min(0).nullish(),
    note: z.string().max(500).nullish(),
  }),
  outputSchema: z.object({ id: z.string().nullable(), guidance: z.string() }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const access = await payrollAccess(ctx.db, ctx.userId);
    if (!access.manager)
      return {
        id: null,
        guidance:
          'Las novedades de nómina las registra quien administra la empresa: los salarios son confidenciales.',
      };
    const { employee, candidates } = await findEmployee(ctx.db, input.person);
    if (!employee)
      return {
        id: null,
        guidance: candidates.length
          ? `Hay varias personas que coinciden: ${candidates.map((c) => c.name).join(', ')}. ¿Cuál?`
          : `No encuentro a «${input.person}» en la nómina.`,
      };
    const row = await addNovelty(
      ctx.db,
      {
        employeeId: employee.id,
        kind: input.kind,
        date: input.date,
        dateTo: input.dateTo,
        hours: input.hours,
        amount: input.amount,
        note: input.note,
      },
      { userId: ctx.userId, source: 'chat' },
    );
    return {
      id: row.id,
      guidance: `Registré ${NOVELTY_LABEL[input.kind].toLowerCase()} de ${employee.name} (${input.date}${input.dateTo ? ` a ${input.dateTo}` : ''}${input.hours ? `, ${input.hours} h` : ''}${input.amount ? `, ${cop(input.amount)}` : ''}). Entra en la próxima liquidación del periodo; si ya estaba liquidado, hay que volver a liquidarlo en Nómina.`,
    };
  },
});

export const payrollApprovePeriod = registerTool({
  id: 'payroll.approve_period',
  description:
    'Aprobar una nómina YA LIQUIDADA en Cortex: queda lista para pagar, su neto y la PILA entran a la caja proyectada (como «Nómina (confidencial)») y se crea el aviso del día de pago. NO paga nada: el pago lo hace una persona desde su banco con las instrucciones de Nómina. Sólo quien administra la empresa. Requiere confirmación.',
  inputSchema: z.object({
    periodId: z.string().uuid().nullish().describe('El periodo; por defecto, el último liquidado.'),
    label: z.string().max(80).nullish().describe('Cómo se llama el periodo, para la confirmación.'),
  }),
  outputSchema: z.object({ approved: z.boolean(), guidance: z.string() }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 5 },
  handler: async (input, ctx) => {
    const access = await payrollAccess(ctx.db, ctx.userId);
    if (!access.manager)
      return {
        approved: false,
        guidance: 'Aprobar la nómina es sólo para quien administra la empresa.',
      };
    let periodId = input.periodId ?? null;
    if (!periodId) {
      const last = (await listPeriods(ctx.db, { limit: 12 })).find((p) => p.status === 'liquidado');
      if (!last)
        return {
          approved: false,
          guidance: 'No hay ninguna nómina liquidada esperando aprobación.',
        };
      periodId = last.id;
    }
    const r = await approvePeriod(ctx.db, periodId, { userId: ctx.userId });
    return {
      approved: true,
      guidance: `Aprobé la nómina de ${r.period.label}: neto ${cop(r.period.totals.neto)} para ${plural(r.period.totals.employees, 'persona')}, a pagar el ${r.period.payDate}. La PILA (${cop(r.period.totals.seguridadSocial ?? 0)}) vence el ${r.pilaDue}${r.pilaByNit ? '' : ' (fecha estimada: configura el NIT en Impuestos para la exacta)'}. Las instrucciones de pago, la PILA y la nómina electrónica se descargan en Nómina. Cortex no mueve plata.`,
    };
  },
});

export const payrollPayslip = registerTool({
  id: 'payroll.payslip',
  description: `El desprendible de pago de quien pregunta: lo devengado, lo deducido y el neto de sus últimos periodos aprobados, línea por línea con la cuenta. Úsala para «¿cuánto me pagaron?», «mi desprendible», «¿por qué me descontaron…?». Quien administra puede pedir el de otra persona; nadie más. ${COMP_SENSITIVITY_NOTE}`,
  inputSchema: z.object({
    person: z.string().nullish().describe('Sólo quien administra: de quién. Vacío = el propio.'),
    periods: z.number().int().min(1).max(12).default(1),
  }),
  outputSchema: z.object({ found: z.boolean(), payslips: z.array(z.any()), guidance: z.string() }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const access = await payrollAccess(ctx.db, ctx.userId);
    let employeeId = access.employeeId;
    if (input.person) {
      if (!access.manager)
        return {
          found: false,
          payslips: [],
          guidance:
            'Cada persona ve sólo su propio desprendible. El de otra persona es confidencial.',
        };
      const { employee, candidates } = await findEmployee(ctx.db, input.person);
      if (!employee)
        return {
          found: false,
          payslips: [],
          guidance: candidates.length
            ? `¿Cuál de estas personas? ${candidates.map((c) => c.name).join(', ')}`
            : `No encuentro a «${input.person}» en la nómina.`,
        };
      employeeId = employee.id;
    }
    if (!employeeId)
      return {
        found: false,
        payslips: [],
        guidance:
          'No te encuentro en la nómina de la empresa con tu cuenta de Cortex. Quien administra te puede vincular en Nómina.',
      };
    const slips = (await listPayslips(ctx.db, { employeeId, viewerId: ctx.userId })).slice(
      0,
      input.periods ?? 1,
    );
    if (!slips.length)
      return { found: false, payslips: [], guidance: 'Todavía no hay desprendibles aprobados.' };
    return {
      found: true,
      payslips: slips.map((s) => ({
        period: s.period.label,
        status: s.period.status,
        payDate: s.period.payDate,
        devengado: s.liquidation.totals.devengado,
        deducciones: s.liquidation.totals.deducciones,
        neto: s.liquidation.totals.neto,
        lines: s.liquidation.lines
          .filter((l) => l.group === 'devengado' || l.group === 'deduccion')
          .map((l) => ({
            group: l.group,
            label: l.label,
            amount: l.amount,
            explanation: l.explanation,
          })),
      })),
      guidance: `${slips[0]?.employeeName}: ${slips
        .map((s) => `${s.period.label} — neto ${cop(s.liquidation.totals.neto)}`)
        .join('; ')}. Muestra sólo a quien pregunta; el desprendible completo está en Mi semana.`,
    };
  },
});

export const payrollLeaveRequest = registerTool({
  id: 'payroll.leave_request',
  description:
    'Pedir vacaciones, un permiso, una licencia (luto, calamidad, maternidad, paternidad, no remunerada) o reportar una incapacidad, PARA QUIEN PREGUNTA (quien administra puede pedirla a nombre de otra persona). Cuenta los días hábiles sin domingos ni festivos, revisa el saldo de vacaciones y que no se cruce con otra, y la deja pendiente de aprobación. No aprueba nada.',
  inputSchema: z.object({
    kind: z.enum(LEAVE_KINDS),
    start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    reason: z.string().max(1000).nullish(),
    person: z.string().nullish().describe('Sólo quien administra: para quién. Vacío = para sí.'),
    evidenceDocumentId: z
      .string()
      .uuid()
      .nullish()
      .describe('El soporte en el Cerebro (incapacidad, registro civil).'),
  }),
  outputSchema: z.object({ id: z.string().nullable(), guidance: z.string() }),
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    let employeeId: string | null = null;
    if (input.person) {
      const { employee, candidates } = await findEmployee(ctx.db, input.person);
      if (!employee)
        return {
          id: null,
          guidance: candidates.length
            ? `¿Cuál de estas personas? ${candidates.map((c) => c.name).join(', ')}`
            : `No encuentro a «${input.person}» en la nómina.`,
        };
      employeeId = employee.id;
    }
    const r = await requestLeave(
      ctx.db,
      {
        employeeId,
        kind: input.kind,
        start: input.start,
        end: input.end,
        reason: input.reason,
        evidenceDocumentId: input.evidenceDocumentId,
      },
      { userId: ctx.userId },
    );
    return {
      id: r.request.id,
      guidance: [
        `Quedó pedida: ${LEAVE_LABEL[r.request.kind].toLowerCase()} de ${r.employeeName} del ${r.request.start} al ${r.request.end} (${plural(r.request.businessDays, 'día hábil', 'días hábiles')}, ${plural(r.request.calendarDays, 'día calendario', 'días calendario')}). Espera la aprobación de quien administra o de su jefe directo.`,
        r.balance
          ? `Saldo de vacaciones antes de esta solicitud: ${r.balance.balance} días hábiles.`
          : null,
        ...r.warnings,
      ]
        .filter(Boolean)
        .join(' '),
    };
  },
});

export const payrollLeaveStatus = registerTool({
  id: 'payroll.leave_status',
  description:
    'El saldo de vacaciones (15 días hábiles por año, causados día a día) y las solicitudes de ausencia de quien pregunta. A quien administra o aprueba le muestra además las solicitudes pendientes de su equipo. Úsala para «¿cuántos días de vacaciones tengo?», «¿me aprobaron el permiso?», «¿qué solicitudes hay pendientes?». Sólo lectura.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    balance: z.number().nullable(),
    pending: z.array(z.any()),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (_input, ctx) => {
    const access = await payrollAccess(ctx.db, ctx.userId);
    const today = bogotaToday();
    const lines: string[] = [];
    let balance: number | null = null;
    if (access.employeeId) {
      const me = await getEmployee(ctx.db, access.employeeId);
      if (me) {
        const b = await vacationBalanceFor(ctx.db, me, today);
        balance = b.balance;
        lines.push(`Tu saldo de vacaciones hoy: ${b.balance} días hábiles (${b.explanation})`);
        if (b.pendingPeriods >= 2)
          lines.push(
            'Tienes dos periodos o más sin disfrutar: la ley permite acumular hasta dos (art. 190 CST); conviene programarlas.',
          );
        const mine = await listLeaveRequests(ctx.db, { employeeId: me.id, limit: 10 });
        for (const r of mine.slice(0, 5))
          lines.push(
            `- ${LEAVE_LABEL[r.kind]} ${r.start} a ${r.end}: ${LEAVE_STATUS_LABEL[r.status].toLowerCase()}${r.decisionNote ? ` («${r.decisionNote}»)` : ''}`,
          );
      }
    } else
      lines.push(
        'No estás vinculado a la nómina con tu cuenta de Cortex, así que no tengo tu saldo.',
      );
    let pending: Array<{
      id: string;
      person: string;
      kind: string;
      start: string;
      end: string;
      businessDays: number;
    }> = [];
    if (access.manager) {
      const list = await listLeaveRequests(ctx.db, { statuses: ['pendiente'], limit: 50 });
      const ids = [...new Set(list.map((r) => r.employeeId))];
      const names = new Map<string, string>();
      for (const id of ids) {
        const e = await getEmployee(ctx.db, id);
        if (e) names.set(id, e.name);
      }
      pending = list.map((r) => ({
        id: r.id,
        person: names.get(r.employeeId) ?? '—',
        kind: LEAVE_LABEL[r.kind],
        start: r.start,
        end: r.end,
        businessDays: r.businessDays,
      }));
      if (pending.length)
        lines.push(
          `${plural(pending.length, 'solicitud pendiente', 'solicitudes pendientes')} de aprobar (payroll.leave_decide).`,
        );
    }
    return { balance, pending, guidance: lines.join('\n') };
  },
});

export const payrollLeaveDecide = registerTool({
  id: 'payroll.leave_decide',
  description:
    'Aprobar o rechazar una solicitud de vacaciones, permiso, licencia o incapacidad. Aprobada, se vuelve novedad de la nómina del periodo y descuenta del saldo. Lo hace quien administra la empresa o el jefe directo de la persona (nunca la misma persona). Rechazar exige el motivo. Requiere confirmación.',
  inputSchema: z.object({
    requestId: z.string().uuid().describe('El id que devolvió payroll.leave_status.'),
    decision: z.enum(['aprobada', 'rechazada']),
    note: z.string().max(1000).nullish(),
    person: z.string().max(160).nullish().describe('De quién es, para la confirmación.'),
  }),
  outputSchema: z.object({ status: z.string(), guidance: z.string() }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const r = await decideLeave(
      ctx.db,
      { id: input.requestId, decision: input.decision, note: input.note },
      { userId: ctx.userId },
    );
    return {
      status: r.request.status,
      guidance:
        r.request.status === 'aprobada'
          ? `Aprobé ${LEAVE_LABEL[r.request.kind].toLowerCase()} de ${r.employeeName} del ${r.request.start} al ${r.request.end}.${r.noveltyId ? ' Ya quedó como novedad de la nómina.' : ' El periodo de esas fechas ya estaba cerrado: la novedad se registra en el siguiente.'}`
          : `Rechacé la solicitud de ${r.employeeName}: «${r.request.decisionNote}».`,
    };
  },
});
