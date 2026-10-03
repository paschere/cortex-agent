import 'server-only';
import type {
  EmployeeView,
  LeaveView,
  NoveltyView,
  PayrollOptions,
  PayslipView,
  PeriodView,
} from '@/components/payroll/types';
import {
  AMOUNT_NOVELTIES,
  PAYROLL_CONTRACT_LABEL as CONTRACT_LABEL,
  PAYROLL_CONTRACT_TYPES as CONTRACT_TYPES,
  DAY_NOVELTIES,
  HOUR_NOVELTIES,
  LEAVE_KINDS,
  LEAVE_LABEL,
  LEAVE_STATUS_LABEL,
  type LeaveRequest,
  type Liquidation,
  NOVELTY_KINDS,
  NOVELTY_LABEL,
  type NoveltyRow,
  PAYROLL_PERIOD_STATUS_LABEL,
  type PayrollEmployee,
  type PayrollPeriod,
  TERMINATION_LABEL,
  TERMINATION_REASONS,
} from '@cortex/agent-tools';

/**
 * DE LA NÓMINA DEL PAQUETE A LO QUE PINTA /nomina (0194). Puro y del
 * servidor: aquí se ponen los rótulos en español y se arma lo que necesita
 * cada componente. Lo que sale de aquí ya pasó la regla de quién ve qué
 * (la pantalla sólo llama esto con datos que la persona puede ver).
 */

export function periodView(p: PayrollPeriod): PeriodView {
  return {
    id: p.id,
    label: p.label,
    start: p.start,
    end: p.end,
    payDate: p.payDate,
    status: p.status,
    statusLabel: PAYROLL_PERIOD_STATUS_LABEL[p.status],
    totals: p.totals,
    paramsVersion: p.paramsVersion,
  };
}

export function payslipView(period: PayrollPeriod, l: Liquidation): PayslipView {
  return {
    periodId: period.id,
    periodLabel: period.label,
    status: period.status,
    statusLabel: PAYROLL_PERIOD_STATUS_LABEL[period.status],
    payDate: period.payDate,
    employeeName: l.employeeName,
    devengado: l.totals.devengado,
    deducciones: l.totals.deducciones,
    neto: l.totals.neto,
    aportes: l.totals.aportes,
    provisiones: l.totals.provisiones,
    costoTotal: l.totals.costoTotal,
    days: l.days,
    ibc: l.ibc.salud,
    lines: l.lines.map((x) => ({
      code: x.code,
      group: x.group,
      label: x.label,
      amount: x.amount,
      explanation: x.explanation,
      estimate: x.estimate,
    })),
    warnings: l.warnings,
    estimates: l.estimates,
    paramsVersion: l.paramsVersion,
  };
}

/** Para quien no administra: sin aportes ni provisiones (son costo de la empresa). */
export function ownPayslipView(period: PayrollPeriod, l: Liquidation): PayslipView {
  const v = payslipView(period, l);
  return {
    ...v,
    aportes: 0,
    provisiones: 0,
    costoTotal: 0,
    lines: v.lines.filter((x) => x.group === 'devengado' || x.group === 'deduccion'),
  };
}

export function employeeView(e: PayrollEmployee, balance: number | null): EmployeeView {
  return {
    id: e.id,
    name: e.name,
    documentType: e.documentType,
    documentNumber: e.documentNumber,
    email: e.email,
    jobTitle: e.jobTitle,
    contractType: e.contractType,
    contractLabel: CONTRACT_LABEL[e.contractType],
    startDate: e.startDate,
    endDate: e.endDate,
    salary: e.salary,
    integral: e.integral,
    apprenticePhase: e.apprenticePhase,
    arlClass: e.arlClass,
    eps: e.eps,
    afp: e.afp,
    ccf: e.ccf,
    arl: e.arl,
    cesantiasFund: e.cesantiasFund,
    bankName: e.bankName,
    bankAccountType: e.bankAccountType,
    bankAccountLast4: e.bankAccountLast4,
    costCenter: e.costCenter,
    dependents: e.dependents,
    vacationOpeningDays: e.vacationOpeningDays,
    vacationOpeningAsOf: e.vacationOpeningAsOf,
    userId: e.userId,
    status: e.status,
    vacationBalance: balance,
  };
}

export function noveltyView(n: NoveltyRow, names: Map<string, string>): NoveltyView {
  return {
    id: n.id,
    employeeId: n.employee_id,
    employeeName: names.get(n.employee_id) ?? '—',
    kind: n.kind,
    kindLabel: NOVELTY_LABEL[n.kind],
    from: n.date_from,
    to: n.date_to,
    hours: n.hours == null ? null : Number(n.hours),
    amount: n.amount == null ? null : Number(n.amount),
    note: n.note,
    source: n.source,
  };
}

export function leaveView(
  r: LeaveRequest,
  names: Map<string, string>,
  opts: { canDecide: boolean; mine: boolean },
): LeaveView {
  return {
    id: r.id,
    employeeId: r.employeeId,
    employeeName: names.get(r.employeeId) ?? '—',
    kind: r.kind,
    kindLabel: LEAVE_LABEL[r.kind],
    start: r.start,
    end: r.end,
    businessDays: r.businessDays,
    calendarDays: r.calendarDays,
    status: r.status,
    statusLabel: LEAVE_STATUS_LABEL[r.status],
    reason: r.reason,
    decisionNote: r.decisionNote,
    canDecide: opts.canDecide && r.status === 'pendiente' && !opts.mine,
    mine: opts.mine,
  };
}

export function payrollOptions(team: Array<{ id: string; name: string }>): PayrollOptions {
  return {
    noveltyKinds: NOVELTY_KINDS.map((k) => ({ value: k, label: NOVELTY_LABEL[k] })),
    hourKinds: [...HOUR_NOVELTIES],
    dayKinds: [...DAY_NOVELTIES],
    amountKinds: [...AMOUNT_NOVELTIES],
    leaveKinds: LEAVE_KINDS.map((k) => ({ value: k, label: LEAVE_LABEL[k] })),
    contractTypes: CONTRACT_TYPES.map((k) => ({ value: k, label: CONTRACT_LABEL[k] })),
    terminationReasons: TERMINATION_REASONS.map((k) => ({ value: k, label: TERMINATION_LABEL[k] })),
    team: team.map((t) => ({ value: t.id, label: t.name })),
  };
}
