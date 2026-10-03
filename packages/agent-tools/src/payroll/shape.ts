import { z } from 'zod';
import {
  CONTRACT_TYPES,
  type ContractType,
  type EmployeeForPayroll,
  type LineGroup,
  type Liquidation,
  NOVELTY_KINDS,
  type NoveltyKind,
} from './co/engine';
import type { EmployeeForExport } from './co/exports';
import { LEAVE_KINDS, type LeaveKind } from './co/leave';

/**
 * LAS FORMAS DE LA NÓMINA PROPIA (migración 0194): filas, adaptadores y los
 * esquemas de lo que llega del chat o de la pantalla. Sin base de datos.
 */

export const DOCUMENT_TYPES = ['CC', 'CE', 'PA', 'TI', 'PEP', 'PPT'] as const;
export const PERIOD_STATUSES = ['borrador', 'liquidado', 'aprobado', 'pagado', 'anulado'] as const;
export type PeriodStatus = (typeof PERIOD_STATUSES)[number];
export const PERIOD_STATUS_LABEL: Record<PeriodStatus, string> = {
  borrador: 'Borrador',
  liquidado: 'Liquidado, por aprobar',
  aprobado: 'Aprobado, por pagar',
  pagado: 'Pagado',
  anulado: 'Anulado',
};
export const LEAVE_STATUSES = ['pendiente', 'aprobada', 'rechazada', 'cancelada'] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];
export const LEAVE_STATUS_LABEL: Record<LeaveStatus, string> = {
  pendiente: 'Pendiente',
  aprobada: 'Aprobada',
  rechazada: 'Rechazada',
  cancelada: 'Cancelada',
};

// ---------------------------------------------------------------------------
// Empleados
// ---------------------------------------------------------------------------

export const EMPLOYEE_COLUMNS =
  'id, user_id, full_name, document_type, document_number, email, job_title, contract_type, start_date, end_date, salary, salary_integral, apprentice_phase, arl_class, eps, afp, ccf, arl, cesantias_fund, bank_name, bank_account_type, bank_account_last4, cost_center, dependents, prepaid_health, vacation_opening_days, vacation_opening_as_of, status, termination_reason, notes, created_at, updated_at';

export interface EmployeeRow {
  id: string;
  user_id: string | null;
  full_name: string;
  document_type: string;
  document_number: string;
  email: string | null;
  job_title: string | null;
  contract_type: ContractType;
  start_date: string;
  end_date: string | null;
  salary: number | string;
  salary_integral: boolean;
  apprentice_phase: 'lectiva' | 'productiva' | null;
  arl_class: number;
  eps: string | null;
  afp: string | null;
  ccf: string | null;
  arl: string | null;
  cesantias_fund: string | null;
  bank_name: string | null;
  bank_account_type: string | null;
  bank_account_last4: string | null;
  cost_center: string | null;
  dependents: boolean;
  prepaid_health: number | string | null;
  vacation_opening_days: number | string;
  vacation_opening_as_of: string | null;
  status: 'activo' | 'retirado';
  termination_reason: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface Employee {
  id: string;
  userId: string | null;
  name: string;
  documentType: string;
  documentNumber: string;
  email: string | null;
  jobTitle: string | null;
  contractType: ContractType;
  startDate: string;
  endDate: string | null;
  salary: number;
  integral: boolean;
  apprenticePhase: 'lectiva' | 'productiva' | null;
  arlClass: 1 | 2 | 3 | 4 | 5;
  eps: string | null;
  afp: string | null;
  ccf: string | null;
  arl: string | null;
  cesantiasFund: string | null;
  bankName: string | null;
  bankAccountType: string | null;
  bankAccountLast4: string | null;
  costCenter: string | null;
  dependents: boolean;
  prepaidHealth: number | null;
  vacationOpeningDays: number;
  vacationOpeningAsOf: string | null;
  status: 'activo' | 'retirado';
  terminationReason: string | null;
  notes: string | null;
}

const n = (v: number | string | null | undefined): number => (v == null ? 0 : Number(v));

export function adaptEmployee(r: EmployeeRow): Employee {
  return {
    id: r.id,
    userId: r.user_id,
    name: r.full_name,
    documentType: r.document_type,
    documentNumber: r.document_number,
    email: r.email,
    jobTitle: r.job_title,
    contractType: r.contract_type,
    startDate: r.start_date,
    endDate: r.end_date,
    salary: n(r.salary),
    integral: r.salary_integral,
    apprenticePhase: r.apprentice_phase,
    arlClass: Math.min(5, Math.max(1, r.arl_class)) as 1 | 2 | 3 | 4 | 5,
    eps: r.eps,
    afp: r.afp,
    ccf: r.ccf,
    arl: r.arl,
    cesantiasFund: r.cesantias_fund,
    bankName: r.bank_name,
    bankAccountType: r.bank_account_type,
    bankAccountLast4: r.bank_account_last4,
    costCenter: r.cost_center,
    dependents: r.dependents,
    prepaidHealth: r.prepaid_health == null ? null : n(r.prepaid_health),
    vacationOpeningDays: n(r.vacation_opening_days),
    vacationOpeningAsOf: r.vacation_opening_as_of,
    status: r.status,
    terminationReason: r.termination_reason,
    notes: r.notes,
  };
}

export function employeeForEngine(e: Employee): EmployeeForPayroll {
  return {
    id: e.id,
    name: e.name,
    contractType: e.contractType,
    salary: e.salary,
    integral: e.integral,
    arlClass: e.arlClass,
    startDate: e.startDate,
    endDate: e.endDate,
    apprenticePhase: e.apprenticePhase,
    dependents: e.dependents,
    prepaidHealth: e.prepaidHealth,
  };
}

export function employeeForExport(e: Employee): EmployeeForExport {
  return {
    id: e.id,
    name: e.name,
    documentType: e.documentType,
    documentNumber: e.documentNumber,
    contractType: e.contractType,
    integral: e.integral,
    arlClass: e.arlClass,
    eps: e.eps,
    afp: e.afp,
    ccf: e.ccf,
    arl: e.arl,
    bankName: e.bankName,
    bankAccountType: e.bankAccountType,
    bankAccountLast4: e.bankAccountLast4,
    apprenticePhase: e.apprenticePhase,
    startDate: e.startDate,
    endDate: e.endDate,
    costCenter: e.costCenter,
  };
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha AAAA-MM-DD');
const optText = (max: number) => z.string().trim().max(max).nullish();

export const employeeInputSchema = z.object({
  id: z.string().uuid().nullish(),
  name: z.string().trim().min(2).max(160),
  documentType: z.enum(DOCUMENT_TYPES).default('CC'),
  documentNumber: z
    .string()
    .trim()
    .regex(/^[0-9A-Za-z-]{3,20}$/, 'Documento de 3 a 20 caracteres'),
  email: z.string().trim().email().max(200).nullish(),
  jobTitle: optText(120),
  contractType: z.enum(CONTRACT_TYPES),
  startDate: day,
  endDate: day.nullish(),
  salary: z.number().min(0).max(9_999_999_999),
  integral: z.boolean().default(false),
  apprenticePhase: z.enum(['lectiva', 'productiva']).nullish(),
  arlClass: z.number().int().min(1).max(5).default(1),
  eps: optText(80),
  afp: optText(80),
  ccf: optText(80),
  arl: optText(80),
  cesantiasFund: optText(80),
  bankName: optText(80),
  bankAccountType: z.enum(['ahorros', 'corriente', 'deposito']).nullish(),
  /** Se recibe el número (o sus últimos 4) y SÓLO se guardan los últimos 4. */
  bankAccount: z.string().trim().max(40).nullish(),
  costCenter: optText(80),
  dependents: z.boolean().default(false),
  prepaidHealth: z.number().min(0).max(100_000_000).nullish(),
  vacationOpeningDays: z.number().min(-60).max(400).default(0),
  vacationOpeningAsOf: day.nullish(),
  userId: z.string().uuid().nullish(),
  notes: optText(2000),
});
export type EmployeeInput = z.input<typeof employeeInputSchema>;

/** Los últimos cuatro dígitos de una cuenta; nunca más. */
export function last4(account: string | null | undefined): string | null {
  const digits = (account ?? '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

// ---------------------------------------------------------------------------
// Periodos, desprendibles, novedades, solicitudes
// ---------------------------------------------------------------------------

export const PERIOD_COLUMNS =
  'id, frequency, period_start, period_end, pay_date, status, params_version, totals, employees_count, liquidated_at, approved_at, approved_by, paid_at, commitment_id, notes, created_at, updated_at';

export interface PeriodTotals {
  devengado: number;
  deducciones: number;
  neto: number;
  aportes: number;
  provisiones: number;
  costoTotal: number;
  employees: number;
  /** Lo que se paga en la PILA: aportes del empleador + salud/pensión/FSP del empleado. */
  seguridadSocial?: number;
}

export interface PeriodRow {
  id: string;
  frequency: 'mensual' | 'quincenal';
  period_start: string;
  period_end: string;
  pay_date: string;
  status: PeriodStatus;
  params_version: string | null;
  totals: Partial<PeriodTotals> | null;
  employees_count: number;
  liquidated_at: string | null;
  approved_at: string | null;
  approved_by: string | null;
  paid_at: string | null;
  commitment_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface PayrollPeriod {
  id: string;
  frequency: 'mensual' | 'quincenal';
  start: string;
  end: string;
  payDate: string;
  status: PeriodStatus;
  paramsVersion: string | null;
  totals: PeriodTotals;
  employeesCount: number;
  liquidatedAt: string | null;
  approvedAt: string | null;
  paidAt: string | null;
  commitmentId: string | null;
  label: string;
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

export function periodLabel(
  start: string,
  end: string,
  frequency: 'mensual' | 'quincenal',
): string {
  const m = MONTHS[Number(start.slice(5, 7)) - 1] ?? start.slice(5, 7);
  const y = start.slice(0, 4);
  if (frequency === 'mensual') return `${m} ${y}`;
  return `${Number(start.slice(8, 10)) <= 15 && Number(end.slice(8, 10)) <= 15 ? '1.ª' : '2.ª'} quincena de ${m} ${y}`;
}

export function adaptPeriod(r: PeriodRow): PayrollPeriod {
  const t = r.totals ?? {};
  return {
    id: r.id,
    frequency: r.frequency,
    start: r.period_start,
    end: r.period_end,
    payDate: r.pay_date,
    status: r.status,
    paramsVersion: r.params_version,
    totals: {
      devengado: n(t.devengado),
      deducciones: n(t.deducciones),
      neto: n(t.neto),
      aportes: n(t.aportes),
      provisiones: n(t.provisiones),
      costoTotal: n(t.costoTotal),
      employees: n(t.employees),
      seguridadSocial: n(t.seguridadSocial),
    },
    employeesCount: r.employees_count,
    liquidatedAt: r.liquidated_at,
    approvedAt: r.approved_at,
    paidAt: r.paid_at,
    commitmentId: r.commitment_id,
    label: periodLabel(r.period_start, r.period_end, r.frequency),
  };
}

export const PAYSLIP_COLUMNS =
  'id, period_id, employee_id, days, ibc, devengado, deducciones, neto, aportes, provisiones, costo_total, warnings, estimates, params_version, created_at';

export interface PayslipRow {
  id: string;
  period_id: string;
  employee_id: string;
  days: Liquidation['days'];
  ibc: Liquidation['ibc'];
  devengado: number | string;
  deducciones: number | string;
  neto: number | string;
  aportes: number | string;
  provisiones: number | string;
  costo_total: number | string;
  warnings: string[] | null;
  estimates: string[] | null;
  params_version: string;
}

export const ITEM_COLUMNS =
  'period_id, employee_id, line_no, code, item_group, label, quantity, unit, base, rate, amount, explanation, is_estimate';

export interface ItemRow {
  period_id: string;
  employee_id: string;
  line_no: number;
  code: string;
  item_group: LineGroup;
  label: string;
  quantity: number | string | null;
  unit: 'dias' | 'horas' | null;
  base: number | string | null;
  rate: number | string | null;
  amount: number | string;
  explanation: string;
  is_estimate: boolean;
}

/** Rearma la liquidación guardada (para exportar o mostrar). */
export function liquidationFromRows(
  slip: PayslipRow,
  items: ItemRow[],
  employeeName: string,
  period: { start: string; end: string; frequency: 'mensual' | 'quincenal' },
): Liquidation {
  return {
    employeeId: slip.employee_id,
    employeeName,
    period,
    paramsVersion: slip.params_version,
    days: slip.days,
    ibc: slip.ibc,
    lines: items
      .filter((i) => i.employee_id === slip.employee_id && i.period_id === slip.period_id)
      .sort((a, b) => a.line_no - b.line_no)
      .map((i) => ({
        code: i.code,
        group: i.item_group,
        label: i.label,
        quantity: i.quantity == null ? null : Number(i.quantity),
        unit: i.unit,
        base: i.base == null ? null : Number(i.base),
        rate: i.rate == null ? null : Number(i.rate),
        amount: Number(i.amount),
        explanation: i.explanation,
        estimate: i.is_estimate,
      })),
    totals: {
      devengado: n(slip.devengado),
      deducciones: n(slip.deducciones),
      neto: n(slip.neto),
      aportes: n(slip.aportes),
      provisiones: n(slip.provisiones),
      costoTotal: n(slip.costo_total),
    },
    warnings: slip.warnings ?? [],
    estimates: slip.estimates ?? [],
    excluded: null,
  };
}

export const NOVELTY_COLUMNS =
  'id, employee_id, kind, date_from, date_to, hours, days, amount, note, source, leave_request_id, status, created_by, created_at';

export interface NoveltyRow {
  id: string;
  employee_id: string;
  kind: NoveltyKind;
  date_from: string;
  date_to: string | null;
  hours: number | string | null;
  days: number | string | null;
  amount: number | string | null;
  note: string | null;
  source: 'manual' | 'chat' | 'licencia';
  leave_request_id: string | null;
  status: 'activa' | 'anulada';
  created_by: string | null;
  created_at: string;
}

export const noveltyInputSchema = z.object({
  employeeId: z.string().uuid(),
  kind: z.enum(NOVELTY_KINDS),
  date: day,
  dateTo: day.nullish(),
  hours: z.number().positive().max(400).nullish(),
  amount: z.number().min(0).max(9_999_999_999).nullish(),
  note: z.string().trim().max(500).nullish(),
});
export type NoveltyInput = z.input<typeof noveltyInputSchema>;

export const LEAVE_COLUMNS =
  'id, employee_id, requested_by, kind, start_date, end_date, business_days, calendar_days, status, reason, decided_by, decided_at, decision_note, evidence_document_id, created_at, updated_at';

export interface LeaveRow {
  id: string;
  employee_id: string;
  requested_by: string | null;
  kind: LeaveKind;
  start_date: string;
  end_date: string;
  business_days: number | string;
  calendar_days: number;
  status: LeaveStatus;
  reason: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  evidence_document_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface LeaveRequest {
  id: string;
  employeeId: string;
  requestedBy: string | null;
  kind: LeaveKind;
  start: string;
  end: string;
  businessDays: number;
  calendarDays: number;
  status: LeaveStatus;
  reason: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  evidenceDocumentId: string | null;
  createdAt: string;
}

export function adaptLeave(r: LeaveRow): LeaveRequest {
  return {
    id: r.id,
    employeeId: r.employee_id,
    requestedBy: r.requested_by,
    kind: r.kind,
    start: r.start_date,
    end: r.end_date,
    businessDays: n(r.business_days),
    calendarDays: r.calendar_days,
    status: r.status,
    reason: r.reason,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
    decisionNote: r.decision_note,
    evidenceDocumentId: r.evidence_document_id,
    createdAt: r.created_at,
  };
}

export const leaveInputSchema = z.object({
  employeeId: z.string().uuid().nullish(),
  kind: z.enum(LEAVE_KINDS),
  start: day,
  end: day,
  reason: z.string().trim().max(1000).nullish(),
  evidenceDocumentId: z.string().uuid().nullish(),
});
export type LeaveInput = z.input<typeof leaveInputSchema>;

export interface PayrollSettings {
  frequency: 'mensual' | 'quincenal';
  exonerated1141: boolean;
  saturdayIsWorkday: boolean;
  responsibleUserId: string | null;
  configured: boolean;
}

export const DEFAULT_PAYROLL_SETTINGS: PayrollSettings = {
  frequency: 'mensual',
  exonerated1141: true,
  saturdayIsWorkday: true,
  responsibleUserId: null,
  configured: false,
};
