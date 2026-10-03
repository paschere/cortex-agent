import { addDaysIso, businessDaysBetween, calendarDays, days360, minDay } from './dates';

/**
 * VACACIONES, PERMISOS, LICENCIAS E INCAPACIDADES (0194) — la parte pura.
 *
 * Vacaciones (art. 186 CST): 15 días HÁBILES por año de servicio, que se
 * causan día a día: 15 × días trabajados ÷ 360. Una licencia no remunerada
 * suspende el contrato y esos días no causan vacaciones (art. 53 CST). El
 * saldo = saldo de apertura (lo que traía al empezar a usar Cortex) + lo
 * causado desde esa fecha − lo disfrutado aprobado.
 *
 * Una solicitud aprobada se vuelve una NOVEDAD de nómina del mismo rango
 * (store.ts), así que la liquidación y el saldo hablan de lo mismo.
 */

export const LEAVE_KINDS = [
  'vacaciones',
  'permiso',
  'licencia_remunerada',
  'licencia_no_remunerada',
  'licencia_luto',
  'calamidad',
  'licencia_maternidad',
  'licencia_paternidad',
  'incapacidad_general',
  'incapacidad_laboral',
] as const;
export type LeaveKind = (typeof LEAVE_KINDS)[number];

export const LEAVE_LABEL: Record<LeaveKind, string> = {
  vacaciones: 'Vacaciones',
  permiso: 'Permiso remunerado',
  licencia_remunerada: 'Licencia remunerada',
  licencia_no_remunerada: 'Licencia no remunerada',
  licencia_luto: 'Licencia de luto',
  calamidad: 'Calamidad doméstica',
  licencia_maternidad: 'Licencia de maternidad',
  licencia_paternidad: 'Licencia de paternidad',
  incapacidad_general: 'Incapacidad (enfermedad general)',
  incapacidad_laboral: 'Incapacidad (accidente o enfermedad laboral)',
};

/** La novedad de nómina que produce cada tipo de solicitud aprobada. */
export const LEAVE_TO_NOVELTY: Record<
  LeaveKind,
  | 'vacaciones'
  | 'licencia_remunerada'
  | 'licencia_no_remunerada'
  | 'licencia_maternidad'
  | 'licencia_paternidad'
  | 'incapacidad_general'
  | 'incapacidad_laboral'
> = {
  vacaciones: 'vacaciones',
  permiso: 'licencia_remunerada',
  licencia_remunerada: 'licencia_remunerada',
  licencia_no_remunerada: 'licencia_no_remunerada',
  licencia_luto: 'licencia_remunerada',
  calamidad: 'licencia_remunerada',
  licencia_maternidad: 'licencia_maternidad',
  licencia_paternidad: 'licencia_paternidad',
  incapacidad_general: 'incapacidad_general',
  incapacidad_laboral: 'incapacidad_laboral',
};

/** Las que soporta un documento (la incapacidad de la EPS, el registro civil…). */
export const LEAVE_NEEDS_EVIDENCE: ReadonlySet<LeaveKind> = new Set([
  'licencia_luto',
  'licencia_maternidad',
  'licencia_paternidad',
  'incapacidad_general',
  'incapacidad_laboral',
]);

export const VACATION_DAYS_PER_YEAR = 15;

export interface VacationBalanceInput {
  startDate: string;
  endDate?: string | null;
  /** Días que traía a la fecha de apertura. */
  openingDays: number;
  /** Desde cuándo se causa en Cortex (por defecto, el ingreso). */
  openingAsOf?: string | null;
  /** Días hábiles de vacaciones aprobadas (ya disfrutadas o por disfrutar). */
  takenBusinessDays: number;
  /** Días de licencia no remunerada desde la apertura (no causan). */
  unpaidDays: number;
  asOf: string;
}

export interface VacationBalance {
  accrued: number;
  taken: number;
  balance: number;
  /** Años completos de servicio a `asOf`. */
  serviceYears: number;
  /** Periodos completos (de 15 días) acumulados sin tomar: más de 2 es un riesgo legal. */
  pendingPeriods: number;
  explanation: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function vacationBalance(input: VacationBalanceInput): VacationBalance {
  const from =
    input.openingAsOf && input.openingAsOf > input.startDate ? input.openingAsOf : input.startDate;
  const to = minDay(input.asOf, input.endDate ?? input.asOf);
  const worked = Math.max(0, days360(from, to) - Math.max(0, input.unpaidDays));
  const accrued = r2((worked * VACATION_DAYS_PER_YEAR) / 360);
  const totalAccrued = r2(input.openingDays + accrued);
  const balance = r2(totalAccrued - input.takenBusinessDays);
  const serviceYears = Math.floor(days360(input.startDate, to) / 360);
  const pendingPeriods = Math.floor(Math.max(0, balance) / VACATION_DAYS_PER_YEAR);
  return {
    accrued: totalAccrued,
    taken: r2(input.takenBusinessDays),
    balance,
    serviceYears,
    pendingPeriods,
    explanation: `${worked} días trabajados desde ${from} × 15 ÷ 360 = ${accrued} días${input.openingDays ? ` + ${input.openingDays} de apertura` : ''} − ${r2(input.takenBusinessDays)} tomados = ${balance} días hábiles.`,
  };
}

export interface LeaveDays {
  calendarDays: number;
  businessDays: number;
}

/** Cuánto dura una solicitud: días calendario y hábiles. */
export function leaveDays(
  start: string,
  end: string,
  opts: { saturdayIsWorkday: boolean },
): LeaveDays {
  return {
    calendarDays: calendarDays(start, end),
    businessDays: businessDaysBetween(start, end, opts),
  };
}

/**
 * Revisa una solicitud antes de guardarla. Devuelve los problemas (vacío si
 * está bien) y avisos que no la impiden.
 */
export function checkLeaveRequest(input: {
  kind: LeaveKind;
  start: string;
  end: string;
  businessDays: number;
  balance: number | null;
  overlaps: number;
}): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (input.end < input.start) errors.push('La fecha final es anterior a la inicial.');
  if (input.overlaps > 0) errors.push('Ya hay otra solicitud aprobada o pendiente en esas fechas.');
  if (input.kind === 'vacaciones') {
    if (input.businessDays <= 0) errors.push('Ese rango no tiene ningún día hábil.');
    if (input.balance != null && input.businessDays > input.balance)
      warnings.push(
        `Pide ${input.businessDays} días hábiles y tiene ${input.balance} causados: serían vacaciones anticipadas, que la empresa puede conceder pero no está obligada.`,
      );
    if (input.businessDays < 6)
      warnings.push(
        'La ley pide disfrutar al menos 6 días hábiles continuos al año (art. 190 CST); el resto se puede fraccionar.',
      );
  }
  if (input.kind === 'licencia_luto' && input.businessDays > 5)
    warnings.push('La licencia de luto es de 5 días hábiles (Ley 1280 de 2009).');
  if (input.kind === 'licencia_paternidad' && calendarDays(input.start, input.end) > 14)
    warnings.push(
      'La licencia de paternidad es de 2 semanas (Ley 2114 de 2021), salvo ampliación.',
    );
  if (input.kind === 'licencia_maternidad' && calendarDays(input.start, input.end) > 126)
    warnings.push('La licencia de maternidad es de 18 semanas.');
  return { errors, warnings };
}

/** Los días de un rango que caen en un mes (para el calendario). */
export function daysInRange(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end && out.length < 400; d = addDaysIso(d, 1)) out.push(d);
  return out;
}
