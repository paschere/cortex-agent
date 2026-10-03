import { ForbiddenError, NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { bogotaToday } from '../commitments/shape';
import { createCommitment, isUniqueViolation, markMet } from '../commitments/store';
import { isCompanyManager } from '../directory/store';
import type { MovementDraft } from '../ledger/shape';
import { upsertMovements } from '../ledger/store';
import { nextMonth, nthBusinessDay } from '../tax/calendar-co';
import { pilaBusinessDay } from '../tax/engine';
import { lastTwoDigits } from '../tax/shape';
import { readTaxProfile } from '../tax/store';
import { days360, periodsOfMonth } from './co/dates';
import {
  AMOUNT_NOVELTIES,
  DAY_NOVELTIES,
  HOUR_NOVELTIES,
  type Liquidation,
  type Novelty,
  liquidate,
  sumLiquidations,
} from './co/engine';
import {
  LEAVE_NEEDS_EVIDENCE,
  LEAVE_TO_NOVELTY,
  type VacationBalance,
  checkLeaveRequest,
  leaveDays,
  vacationBalance,
} from './co/leave';
import {
  DEFAULT_PAYROLL_SETTINGS,
  EMPLOYEE_COLUMNS,
  type Employee,
  type EmployeeInput,
  type EmployeeRow,
  ITEM_COLUMNS,
  type ItemRow,
  LEAVE_COLUMNS,
  type LeaveInput,
  type LeaveRequest,
  type LeaveRow,
  NOVELTY_COLUMNS,
  type NoveltyInput,
  type NoveltyRow,
  PAYSLIP_COLUMNS,
  PERIOD_COLUMNS,
  PERIOD_STATUS_LABEL,
  type PayrollPeriod,
  type PayrollSettings,
  type PayslipRow,
  type PeriodRow,
  type PeriodTotals,
  adaptEmployee,
  adaptLeave,
  adaptPeriod,
  employeeForEngine,
  employeeInputSchema,
  last4,
  leaveInputSchema,
  liquidationFromRows,
  noveltyInputSchema,
} from './shape';

/**
 * LA NÓMINA PROPIA EN LA BASE (migración 0194).
 *
 * `db` es siempre el handle de la empresa (getOrgScopedClient en la app,
 * `ctx.db` en una herramienta): nada aquí filtra por organization_id a mano.
 *
 * LA REGLA DE QUIÉN VE QUÉ VIVE AQUÍ (`payrollAccess`), no en la pantalla ni
 * en la herramienta: los salarios, las novedades y las liquidaciones de los
 * demás los ve y los toca sólo quien administra la empresa o es su dueño
 * (`isCompanyManager`). Cada persona ve SUS desprendibles y SU saldo de
 * vacaciones, y pide sus propias vacaciones. Aprobar una solicitud de
 * ausencia lo puede también su jefe directo en Cortex (`users.manager_id`),
 * que no por eso ve el salario.
 *
 * Nada aquí mueve plata: aprobar una nómina deja lo que hay que pagar en el
 * libro de plata (una fila por periodo, categoría «nomina», sin nombres) y un
 * vencimiento; pagarla lo hace una persona desde su banco.
 */

export const PAYROLL_LEDGER_SYSTEM = 'nomina';
export const PAYROLL_COMMITMENT_SYSTEM = 'nomina';

// ---------------------------------------------------------------------------
// Quién mira
// ---------------------------------------------------------------------------

export interface PayrollAccess {
  manager: boolean;
  /** La fila de empleado de quien mira, si tiene. */
  employeeId: string | null;
  employeeName: string | null;
}

export async function payrollAccess(
  db: SupabaseClient,
  userId: string | null | undefined,
): Promise<PayrollAccess> {
  if (!userId) return { manager: false, employeeId: null, employeeName: null };
  const [manager, own] = await Promise.all([
    isCompanyManager(db, userId),
    db.from('employees').select('id, full_name').eq('user_id', userId).maybeSingle(),
  ]);
  // Sin poder leer su fila, no es nadie en la nómina (falla cerrado).
  const row = own.error ? null : (own.data as { id: string; full_name: string } | null);
  return { manager, employeeId: row?.id ?? null, employeeName: row?.full_name ?? null };
}

async function requireManager(db: SupabaseClient, userId: string, what: string): Promise<void> {
  if (!(await isCompanyManager(db, userId)))
    throw new ForbiddenError(
      `${what} es sólo para quien administra la empresa: los salarios son confidenciales.`,
    );
}

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

export async function readPayrollSettings(db: SupabaseClient): Promise<PayrollSettings> {
  const { data, error } = await db
    .from('payroll_settings')
    .select('frequency, exonerated_114_1, saturday_is_workday, responsible_user_id')
    .maybeSingle();
  if (error) throw error;
  if (!data) return { ...DEFAULT_PAYROLL_SETTINGS };
  const r = data as {
    frequency: 'mensual' | 'quincenal';
    exonerated_114_1: boolean;
    saturday_is_workday: boolean;
    responsible_user_id: string | null;
  };
  return {
    frequency: r.frequency,
    exonerated1141: r.exonerated_114_1,
    saturdayIsWorkday: r.saturday_is_workday,
    responsibleUserId: r.responsible_user_id,
    configured: true,
  };
}

export async function savePayrollSettings(
  db: SupabaseClient,
  input: Omit<PayrollSettings, 'configured'>,
  opts: { userId: string },
): Promise<PayrollSettings> {
  await requireManager(db, opts.userId, 'Configurar la nómina');
  const row = {
    frequency: input.frequency === 'quincenal' ? 'quincenal' : 'mensual',
    exonerated_114_1: Boolean(input.exonerated1141),
    saturday_is_workday: Boolean(input.saturdayIsWorkday),
    responsible_user_id: input.responsibleUserId ?? null,
    updated_by: opts.userId,
    updated_at: new Date().toISOString(),
  };
  const { error } = await db
    .from('payroll_settings')
    .upsert(row, { onConflict: 'organization_id' });
  if (error) throw error;
  return readPayrollSettings(db);
}

// ---------------------------------------------------------------------------
// Empleados
// ---------------------------------------------------------------------------

export async function listEmployees(
  db: SupabaseClient,
  opts: { includeRetired?: boolean } = {},
): Promise<Employee[]> {
  let q = db.from('employees').select(EMPLOYEE_COLUMNS).order('full_name').limit(2000);
  if (!opts.includeRetired) q = q.eq('status', 'activo');
  const { data, error } = await q;
  if (error) throw error;
  return ((data ?? []) as EmployeeRow[]).map(adaptEmployee);
}

export async function getEmployee(db: SupabaseClient, id: string): Promise<Employee | null> {
  const { data, error } = await db
    .from('employees')
    .select(EMPLOYEE_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data ? adaptEmployee(data as EmployeeRow) : null;
}

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

/** Busca a alguien por nombre, documento o correo. Ambiguo → lista de candidatos. */
export async function findEmployee(
  db: SupabaseClient,
  query: string,
): Promise<{ employee: Employee | null; candidates: Employee[] }> {
  const all = await listEmployees(db, { includeRetired: true });
  const q = normalize(query);
  const exact = all.filter(
    (e) =>
      e.documentNumber === query.trim() ||
      normalize(e.email ?? '') === q ||
      normalize(e.name) === q,
  );
  if (exact.length === 1) return { employee: exact[0] ?? null, candidates: [] };
  const words = q.split(/\s+/).filter(Boolean);
  const partial = all.filter((e) => words.every((w) => normalize(e.name).includes(w)));
  if (partial.length === 1) return { employee: partial[0] ?? null, candidates: [] };
  return { employee: null, candidates: (exact.length ? exact : partial).slice(0, 8) };
}

export async function saveEmployee(
  db: SupabaseClient,
  input: EmployeeInput,
  opts: { userId: string },
): Promise<Employee> {
  await requireManager(db, opts.userId, 'Registrar o cambiar a alguien en la nómina');
  const parsed = employeeInputSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `Hay un dato que no cuadra${first ? ` (${first.path.join('.')}: ${first.message})` : ''}.`,
    );
  }
  const p = parsed.data;
  if (p.endDate && p.endDate < p.startDate)
    throw new ValidationError('La fecha de retiro es anterior al ingreso.');
  if (p.integral && !['indefinido', 'fijo', 'obra'].includes(p.contractType))
    throw new ValidationError(
      'Sólo un contrato laboral (indefinido, fijo u obra) puede tener salario integral.',
    );
  if (p.contractType === 'fijo' && !p.endDate)
    throw new ValidationError('Un contrato a término fijo necesita su fecha de terminación.');
  const row: Record<string, unknown> = {
    full_name: p.name,
    document_type: p.documentType,
    document_number: p.documentNumber,
    email: p.email ?? null,
    job_title: p.jobTitle ?? null,
    contract_type: p.contractType,
    start_date: p.startDate,
    end_date: p.endDate ?? null,
    salary: p.salary,
    salary_integral: p.integral,
    apprentice_phase: p.contractType === 'aprendizaje' ? (p.apprenticePhase ?? 'lectiva') : null,
    arl_class: p.arlClass,
    eps: p.eps ?? null,
    afp: p.afp ?? null,
    ccf: p.ccf ?? null,
    arl: p.arl ?? null,
    cesantias_fund: p.cesantiasFund ?? null,
    bank_name: p.bankName ?? null,
    bank_account_type: p.bankAccountType ?? null,
    cost_center: p.costCenter ?? null,
    dependents: p.dependents,
    prepaid_health: p.prepaidHealth ?? null,
    vacation_opening_days: p.vacationOpeningDays,
    vacation_opening_as_of: p.vacationOpeningAsOf ?? null,
    user_id: p.userId ?? null,
    notes: p.notes ?? null,
    updated_at: new Date().toISOString(),
  };
  // Sólo los últimos 4 dígitos; si no llegó cuenta, no se toca la guardada.
  if (p.bankAccount !== undefined) row.bank_account_last4 = last4(p.bankAccount);
  if (p.id) {
    const { data, error } = await db
      .from('employees')
      .update(row)
      .eq('id', p.id)
      .select(EMPLOYEE_COLUMNS)
      .maybeSingle();
    if (error) throw friendlyEmployeeError(error);
    if (!data) throw new NotFoundError('Esa persona ya no está en la nómina.');
    return adaptEmployee(data as EmployeeRow);
  }
  const { data, error } = await db
    .from('employees')
    .insert({ ...row, status: 'activo', created_by: opts.userId })
    .select(EMPLOYEE_COLUMNS)
    .single();
  if (error) throw friendlyEmployeeError(error);
  return adaptEmployee(data as EmployeeRow);
}

function friendlyEmployeeError(error: unknown): Error {
  if (isUniqueViolation(error))
    return new ValidationError(
      'Ya hay alguien con ese documento (o esa cuenta de Cortex ya está asignada a otra persona).',
    );
  return error instanceof Error
    ? error
    : new Error(String((error as { message?: string })?.message ?? error));
}

/** Marca el retiro (no borra: la historia de pagos se queda). */
export async function retireEmployee(
  db: SupabaseClient,
  input: { id: string; endDate: string; reason: string | null },
  opts: { userId: string },
): Promise<void> {
  await requireManager(db, opts.userId, 'Registrar un retiro');
  const { error } = await db
    .from('employees')
    .update({
      status: 'retirado',
      end_date: input.endDate,
      termination_reason: input.reason,
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Novedades
// ---------------------------------------------------------------------------

export async function listNovelties(
  db: SupabaseClient,
  opts: { from?: string; to?: string; employeeId?: string; includeVoid?: boolean } = {},
): Promise<NoveltyRow[]> {
  let q = db
    .from('payroll_novelties')
    .select(NOVELTY_COLUMNS)
    .order('date_from', { ascending: false })
    .limit(3000);
  if (!opts.includeVoid) q = q.eq('status', 'activa');
  if (opts.employeeId) q = q.eq('employee_id', opts.employeeId);
  if (opts.to) q = q.lte('date_from', opts.to);
  // Un rango que empezó antes y sigue dentro también cuenta.
  if (opts.from) q = q.or(`date_from.gte.${opts.from},date_to.gte.${opts.from}`);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as NoveltyRow[];
}

export function noveltyFromRow(r: NoveltyRow): Novelty {
  return {
    id: r.id,
    kind: r.kind,
    date: r.date_from,
    dateTo: r.date_to,
    hours: r.hours == null ? null : Number(r.hours),
    days: r.days == null ? null : Number(r.days),
    amount: r.amount == null ? null : Number(r.amount),
    note: r.note,
  };
}

/** El periodo cerrado (aprobado o pagado) que contiene un día, si hay. */
async function closedPeriodOn(db: SupabaseClient, dayIso: string): Promise<PayrollPeriod | null> {
  const { data, error } = await db
    .from('payroll_periods')
    .select(PERIOD_COLUMNS)
    .in('status', ['aprobado', 'pagado'])
    .lte('period_start', dayIso)
    .gte('period_end', dayIso)
    .limit(1);
  if (error) throw error;
  const row = (data ?? [])[0] as PeriodRow | undefined;
  return row ? adaptPeriod(row) : null;
}

export async function addNovelty(
  db: SupabaseClient,
  input: NoveltyInput,
  opts: {
    userId: string;
    source?: 'manual' | 'chat' | 'licencia';
    leaveRequestId?: string | null;
    skipAccessCheck?: boolean;
  },
): Promise<NoveltyRow> {
  if (!opts.skipAccessCheck) await requireManager(db, opts.userId, 'Registrar novedades de nómina');
  const parsed = noveltyInputSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError('La novedad tiene un dato que no entiendo.');
  const p = parsed.data;
  const employee = await getEmployee(db, p.employeeId);
  if (!employee) throw new NotFoundError('Esa persona no está en la nómina.');
  if (employee.contractType === 'prestacion_servicios')
    throw new ValidationError(
      'Un contrato de prestación de servicios no lleva novedades de nómina.',
    );
  if (HOUR_NOVELTIES.has(p.kind) && !p.hours)
    throw new ValidationError('Esa novedad se registra en horas: ¿cuántas?');
  if (AMOUNT_NOVELTIES.has(p.kind) && !p.amount)
    throw new ValidationError('Esa novedad es un valor: ¿de cuánto?');
  if (p.dateTo && p.dateTo < p.date)
    throw new ValidationError('La fecha final es anterior a la inicial.');
  if (p.date < employee.startDate)
    throw new ValidationError(`${employee.name} ingresó el ${employee.startDate}.`);
  const closed = await closedPeriodOn(db, p.date);
  if (closed)
    throw new ValidationError(
      `La nómina de ${closed.label} ya está ${PERIOD_STATUS_LABEL[closed.status].toLowerCase()}: la novedad va en el periodo siguiente.`,
    );
  const row = {
    employee_id: p.employeeId,
    kind: p.kind,
    date_from: p.date,
    date_to: DAY_NOVELTIES.has(p.kind) ? (p.dateTo ?? p.date) : null,
    hours: HOUR_NOVELTIES.has(p.kind) ? p.hours : null,
    amount: AMOUNT_NOVELTIES.has(p.kind) ? p.amount : null,
    note: p.note ?? null,
    source: opts.source ?? 'manual',
    leave_request_id: opts.leaveRequestId ?? null,
    created_by: opts.userId,
  };
  const { data, error } = await db
    .from('payroll_novelties')
    .insert(row)
    .select(NOVELTY_COLUMNS)
    .single();
  if (error) throw error;
  return data as NoveltyRow;
}

export async function voidNovelty(
  db: SupabaseClient,
  id: string,
  opts: { userId: string },
): Promise<void> {
  await requireManager(db, opts.userId, 'Anular una novedad');
  const { data, error } = await db
    .from('payroll_novelties')
    .select('date_from')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError('Esa novedad no existe.');
  const closed = await closedPeriodOn(db, (data as { date_from: string }).date_from);
  if (closed)
    throw new ValidationError(`La nómina de ${closed.label} ya está cerrada: no se puede anular.`);
  const upd = await db.from('payroll_novelties').update({ status: 'anulada' }).eq('id', id);
  if (upd.error) throw upd.error;
}

// ---------------------------------------------------------------------------
// Periodos
// ---------------------------------------------------------------------------

export async function listPeriods(
  db: SupabaseClient,
  opts: { limit?: number } = {},
): Promise<PayrollPeriod[]> {
  const { data, error } = await db
    .from('payroll_periods')
    .select(PERIOD_COLUMNS)
    .neq('status', 'anulado')
    .order('period_start', { ascending: false })
    .limit(opts.limit ?? 48);
  if (error) throw error;
  return ((data ?? []) as PeriodRow[]).map(adaptPeriod);
}

export async function getPeriod(db: SupabaseClient, id: string): Promise<PayrollPeriod | null> {
  const { data, error } = await db
    .from('payroll_periods')
    .select(PERIOD_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data ? adaptPeriod(data as PeriodRow) : null;
}

/** El periodo que contiene `day` según la frecuencia de la empresa. */
export function periodContaining(
  dayIso: string,
  frequency: 'mensual' | 'quincenal',
): { start: string; end: string } {
  const list = periodsOfMonth(dayIso.slice(0, 7), frequency);
  return (
    list.find((p) => dayIso >= p.start && dayIso <= p.end) ??
    (list[0] as { start: string; end: string })
  );
}

/** Crea el periodo (borrador) si no existe. Idempotente. */
export async function ensurePeriod(
  db: SupabaseClient,
  input: {
    start: string;
    end: string;
    frequency: 'mensual' | 'quincenal';
    payDate?: string | null;
  },
  opts: { userId: string },
): Promise<PayrollPeriod> {
  await requireManager(db, opts.userId, 'Abrir un periodo de nómina');
  const { data: existing, error } = await db
    .from('payroll_periods')
    .select(PERIOD_COLUMNS)
    .eq('period_start', input.start)
    .eq('period_end', input.end)
    .neq('status', 'anulado')
    .maybeSingle();
  if (error) throw error;
  if (existing) return adaptPeriod(existing as PeriodRow);
  const ins = await db
    .from('payroll_periods')
    .insert({
      frequency: input.frequency,
      period_start: input.start,
      period_end: input.end,
      pay_date: input.payDate ?? input.end,
      status: 'borrador',
      created_by: opts.userId,
    })
    .select(PERIOD_COLUMNS)
    .single();
  if (ins.error) {
    if (isUniqueViolation(ins.error)) return ensurePeriod(db, input, opts);
    throw ins.error;
  }
  return adaptPeriod(ins.data as PeriodRow);
}

export interface LiquidationResult {
  period: PayrollPeriod;
  liquidations: Liquidation[];
  excluded: Array<{ name: string; reason: string }>;
}

/**
 * Liquida el periodo: corre el motor por cada persona con contrato en el
 * rango, reemplaza las líneas y los desprendibles, y guarda los totales.
 * Se puede repetir mientras no esté aprobado.
 */
export async function liquidatePeriod(
  db: SupabaseClient,
  periodId: string,
  opts: { userId: string },
): Promise<LiquidationResult> {
  await requireManager(db, opts.userId, 'Liquidar la nómina');
  const period = await getPeriod(db, periodId);
  if (!period) throw new NotFoundError('Ese periodo de nómina no existe.');
  if (period.status !== 'borrador' && period.status !== 'liquidado')
    throw new ValidationError(
      `La nómina de ${period.label} ya está ${PERIOD_STATUS_LABEL[period.status].toLowerCase()}: no se vuelve a liquidar.`,
    );
  const [settings, all, novRows] = await Promise.all([
    readPayrollSettings(db),
    listEmployees(db, { includeRetired: true }),
    listNovelties(db, { from: period.start, to: period.end }),
  ]);
  const inRange = all.filter(
    (e) => e.startDate <= period.end && (!e.endDate || e.endDate >= period.start),
  );
  const liquidations: Liquidation[] = [];
  const excluded: Array<{ name: string; reason: string }> = [];
  for (const e of inRange) {
    const l = liquidate({
      employee: employeeForEngine(e),
      company: { exonerated1141: settings.exonerated1141 },
      period: { start: period.start, end: period.end, frequency: period.frequency },
      novelties: novRows.filter((n) => n.employee_id === e.id).map(noveltyFromRow),
    });
    if (l.excluded) excluded.push({ name: e.name, reason: l.excluded });
    else liquidations.push(l);
  }

  // Reemplazar lo anterior del periodo.
  const delItems = await db.from('payroll_items').delete().eq('period_id', periodId);
  if (delItems.error) throw delItems.error;
  const delSlips = await db.from('payroll_payslips').delete().eq('period_id', periodId);
  if (delSlips.error) throw delSlips.error;

  const slips = liquidations.map((l) => ({
    period_id: periodId,
    employee_id: l.employeeId,
    days: l.days,
    ibc: l.ibc,
    devengado: l.totals.devengado,
    deducciones: l.totals.deducciones,
    neto: l.totals.neto,
    aportes: l.totals.aportes,
    provisiones: l.totals.provisiones,
    costo_total: l.totals.costoTotal,
    warnings: l.warnings,
    estimates: l.estimates,
    params_version: l.paramsVersion,
  }));
  for (let i = 0; i < slips.length; i += 200) {
    const { error } = await db.from('payroll_payslips').insert(slips.slice(i, i + 200));
    if (error) throw error;
  }
  const items = liquidations.flatMap((l) =>
    l.lines.map((line, i) => ({
      period_id: periodId,
      employee_id: l.employeeId,
      line_no: i + 1,
      code: line.code,
      item_group: line.group,
      label: line.label.slice(0, 200),
      quantity: line.quantity,
      unit: line.unit,
      base: line.base,
      rate: line.rate,
      amount: line.amount,
      explanation: line.explanation.slice(0, 1000),
      is_estimate: Boolean(line.estimate),
    })),
  );
  for (let i = 0; i < items.length; i += 500) {
    const { error } = await db.from('payroll_items').insert(items.slice(i, i + 500));
    if (error) throw error;
  }

  const sums = sumLiquidations(liquidations);
  const totals: PeriodTotals = { ...sums, seguridadSocial: socialSecurityTotal(liquidations) };
  const { data, error } = await db
    .from('payroll_periods')
    .update({
      status: 'liquidado',
      totals,
      employees_count: sums.employees,
      params_version: liquidations[0]?.paramsVersion ?? null,
      liquidated_at: new Date().toISOString(),
      liquidated_by: opts.userId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', periodId)
    .in('status', ['borrador', 'liquidado'])
    .select(PERIOD_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data)
    throw new ValidationError('El periodo cambió mientras se liquidaba. Vuelve a intentarlo.');
  return { period: adaptPeriod(data as PeriodRow), liquidations, excluded };
}

const PILA_CODES = new Set([
  'salud_empleado',
  'pension_empleado',
  'fondo_solidaridad',
  'salud_empleador',
  'pension_empleador',
  'pension_licencia',
  'arl',
  'caja',
  'icbf',
  'sena',
]);

/** Lo que se paga en la PILA: aportes del empleador + los descontados al empleado. */
export function socialSecurityTotal(list: Liquidation[]): number {
  return list.reduce(
    (s, l) => s + l.lines.filter((x) => PILA_CODES.has(x.code)).reduce((t, x) => t + x.amount, 0),
    0,
  );
}

/** El día de pago de la PILA del mes siguiente al periodo (por el NIT si hay perfil tributario). */
export async function pilaDueFor(
  db: SupabaseClient,
  periodEnd: string,
): Promise<{ date: string; byNit: boolean }> {
  const month = nextMonth(periodEnd.slice(0, 7));
  const profile = await readTaxProfile(db).catch(() => null);
  if (profile?.nit)
    return {
      date: nthBusinessDay(month, pilaBusinessDay(lastTwoDigits(profile.nit))),
      byNit: true,
    };
  return { date: nthBusinessDay(month, 10), byNit: false };
}

/** Las filas del libro de plata de un periodo: neto y PILA, sin nombres. */
export function periodLedgerDrafts(
  period: PayrollPeriod,
  opts: { pilaDue: string; paidOn?: string | null; userId?: string | null },
): MovementDraft[] {
  const paid = Boolean(opts.paidOn);
  const base = {
    direction: 'out' as const,
    kind: 'payable' as const,
    currency: 'COP',
    date: period.end,
    counterpartyName: 'Nómina',
    counterpartyTaxId: null,
    category: 'nomina',
    categorySource: 'rule' as const,
    recordedBy: opts.userId ?? null,
  };
  const out: MovementDraft[] = [];
  if (period.totals.neto > 0)
    out.push({
      ...base,
      status: paid ? 'settled' : 'expected',
      amount: period.totals.neto,
      dueDate: period.payDate,
      settledAt: paid ? (opts.paidOn ?? null) : null,
      outstanding: paid ? 0 : period.totals.neto,
      description: `Nómina de ${period.label} — neto a pagar (${period.totals.employees} personas)`,
      docNumber: null,
      source: { kind: 'manual', system: PAYROLL_LEDGER_SYSTEM, ref: `nomina:${period.id}:neto` },
    });
  const ss = period.totals.seguridadSocial ?? 0;
  if (ss > 0)
    out.push({
      ...base,
      status: 'expected',
      amount: ss,
      dueDate: opts.pilaDue,
      settledAt: null,
      outstanding: ss,
      description: `Seguridad social y parafiscales (PILA) de ${period.label}`,
      docNumber: null,
      source: { kind: 'manual', system: PAYROLL_LEDGER_SYSTEM, ref: `nomina:${period.id}:pila` },
    });
  return out;
}

/**
 * Aprueba la nómina liquidada: queda lista para pagar. Escribe el neto y la
 * PILA en el libro de plata (para la caja proyectada) y un vencimiento «pagar
 * la nómina» el día de pago. No paga nada.
 */
export async function approvePeriod(
  db: SupabaseClient,
  periodId: string,
  opts: { userId: string },
): Promise<{ period: PayrollPeriod; pilaDue: string; pilaByNit: boolean }> {
  await requireManager(db, opts.userId, 'Aprobar la nómina');
  const period = await getPeriod(db, periodId);
  if (!period) throw new NotFoundError('Ese periodo de nómina no existe.');
  if (period.status !== 'liquidado')
    throw new ValidationError(
      period.status === 'borrador'
        ? `La nómina de ${period.label} todavía no está liquidada: liquídala y revísala en Nómina antes de aprobar.`
        : `La nómina de ${period.label} está ${PERIOD_STATUS_LABEL[period.status].toLowerCase()}.`,
    );
  const now = new Date().toISOString();
  const { data, error } = await db
    .from('payroll_periods')
    .update({ status: 'aprobado', approved_at: now, approved_by: opts.userId, updated_at: now })
    .eq('id', periodId)
    .eq('status', 'liquidado')
    .select(PERIOD_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data)
    throw new ValidationError('La nómina cambió mientras se aprobaba. Vuelve a intentarlo.');
  const approved = adaptPeriod(data as PeriodRow);
  const pila = await pilaDueFor(db, approved.end);
  await upsertMovements(
    db,
    periodLedgerDrafts(approved, { pilaDue: pila.date, userId: opts.userId }),
    {
      recordedBy: opts.userId,
      skipDedup: true,
    },
  );
  // El aviso de pago, si el día no pasó.
  if (approved.payDate >= bogotaToday() && !approved.commitmentId) {
    try {
      const settings = await readPayrollSettings(db);
      const c = await createCommitment(db, {
        title: `Pagar la nómina de ${approved.label}`,
        detail: `Neto a pagar a ${approved.totals.employees} personas. Las instrucciones de pago están en Nómina. Cortex no mueve plata.`,
        kind: 'payment',
        dueOn: approved.payDate,
        noticeDays: 2,
        counterparty: 'Nómina',
        ownerUserId: settings.responsibleUserId ?? opts.userId,
        source: { kind: 'system', system: PAYROLL_COMMITMENT_SYSTEM, readAt: now },
        createdBy: opts.userId,
      });
      const upd = await db
        .from('payroll_periods')
        .update({ commitment_id: c.id })
        .eq('id', approved.id);
      if (upd.error) throw upd.error;
      approved.commitmentId = c.id;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  return { period: approved, pilaDue: pila.date, pilaByNit: pila.byNit };
}

/** Marca la nómina pagada (lo hizo una persona desde su banco). */
export async function markPeriodPaid(
  db: SupabaseClient,
  periodId: string,
  opts: { userId: string; paidOn?: string },
): Promise<PayrollPeriod> {
  await requireManager(db, opts.userId, 'Marcar la nómina pagada');
  const period = await getPeriod(db, periodId);
  if (!period) throw new NotFoundError('Ese periodo de nómina no existe.');
  if (period.status !== 'aprobado')
    throw new ValidationError('Sólo una nómina aprobada se marca pagada.');
  const paidOn = opts.paidOn ?? bogotaToday();
  const now = new Date().toISOString();
  const { data, error } = await db
    .from('payroll_periods')
    .update({ status: 'pagado', paid_at: now, paid_by: opts.userId, updated_at: now })
    .eq('id', periodId)
    .eq('status', 'aprobado')
    .select(PERIOD_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data)
    throw new ValidationError('La nómina cambió mientras se marcaba. Vuelve a intentarlo.');
  const paid = adaptPeriod(data as PeriodRow);
  const pila = await pilaDueFor(db, paid.end);
  await upsertMovements(
    db,
    periodLedgerDrafts(paid, { pilaDue: pila.date, paidOn, userId: opts.userId }).filter((d) =>
      d.source.ref.endsWith(':neto'),
    ),
    { recordedBy: opts.userId, skipDedup: true },
  );
  if (paid.commitmentId)
    await markMet(db, { id: paid.commitmentId, userId: opts.userId, note: 'Nómina pagada.' });
  return paid;
}

/** Anula un periodo que no se aprobó (borrador o liquidado). */
export async function voidPeriod(
  db: SupabaseClient,
  periodId: string,
  opts: { userId: string },
): Promise<void> {
  await requireManager(db, opts.userId, 'Anular un periodo');
  const { data, error } = await db
    .from('payroll_periods')
    .update({ status: 'anulado', updated_at: new Date().toISOString() })
    .eq('id', periodId)
    .in('status', ['borrador', 'liquidado'])
    .select('id')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new ValidationError('Sólo se anula una nómina que no se ha aprobado.');
}

// ---------------------------------------------------------------------------
// Desprendibles
// ---------------------------------------------------------------------------

export interface Payslip {
  period: PayrollPeriod;
  employeeId: string;
  employeeName: string;
  liquidation: Liquidation;
}

/**
 * Los desprendibles de una persona. Quien no administra sólo pide los suyos;
 * pedir los de otro lanza.
 */
export async function listPayslips(
  db: SupabaseClient,
  opts: { employeeId: string; viewerId: string; limit?: number },
): Promise<Payslip[]> {
  const access = await payrollAccess(db, opts.viewerId);
  if (!access.manager && access.employeeId !== opts.employeeId)
    throw new ForbiddenError('Cada persona ve sólo sus propios desprendibles.');
  const employee = await getEmployee(db, opts.employeeId);
  if (!employee) throw new NotFoundError('Esa persona no está en la nómina.');
  const { data, error } = await db
    .from('payroll_payslips')
    .select(PAYSLIP_COLUMNS)
    .eq('employee_id', opts.employeeId)
    .order('created_at', { ascending: false })
    .limit(opts.limit ?? 24);
  if (error) throw error;
  const slips = (data ?? []) as PayslipRow[];
  if (!slips.length) return [];
  const periodIds = [...new Set(slips.map((s) => s.period_id))];
  const [periodsRead, itemsRead] = await Promise.all([
    db.from('payroll_periods').select(PERIOD_COLUMNS).in('id', periodIds),
    db
      .from('payroll_items')
      .select(ITEM_COLUMNS)
      .eq('employee_id', opts.employeeId)
      .in('period_id', periodIds),
  ]);
  if (periodsRead.error) throw periodsRead.error;
  if (itemsRead.error) throw itemsRead.error;
  const periods = new Map(
    ((periodsRead.data ?? []) as PeriodRow[]).map((r) => [r.id, adaptPeriod(r)]),
  );
  const items = (itemsRead.data ?? []) as ItemRow[];
  const out: Payslip[] = [];
  for (const s of slips) {
    const period = periods.get(s.period_id);
    // Quien no administra ve sus desprendibles sólo desde que se aprueban.
    if (!period || period.status === 'anulado') continue;
    if (!access.manager && period.status !== 'aprobado' && period.status !== 'pagado') continue;
    out.push({
      period,
      employeeId: employee.id,
      employeeName: employee.name,
      liquidation: liquidationFromRows(s, items, employee.name, {
        start: period.start,
        end: period.end,
        frequency: period.frequency,
      }),
    });
  }
  return out.sort((a, b) => (a.period.start < b.period.start ? 1 : -1));
}

/** Todas las liquidaciones guardadas de un periodo (sólo quien administra). */
export async function loadPeriodLiquidations(
  db: SupabaseClient,
  periodIds: string[],
  opts: { userId: string },
): Promise<{ periods: PayrollPeriod[]; employees: Employee[]; liquidations: Liquidation[] }> {
  await requireManager(db, opts.userId, 'Ver la liquidación de todos');
  if (!periodIds.length) return { periods: [], employees: [], liquidations: [] };
  const [periodsRead, slipsRead, itemsRead, employees] = await Promise.all([
    db.from('payroll_periods').select(PERIOD_COLUMNS).in('id', periodIds),
    db.from('payroll_payslips').select(PAYSLIP_COLUMNS).in('period_id', periodIds).limit(5000),
    db.from('payroll_items').select(ITEM_COLUMNS).in('period_id', periodIds).limit(50000),
    listEmployees(db, { includeRetired: true }),
  ]);
  if (periodsRead.error) throw periodsRead.error;
  if (slipsRead.error) throw slipsRead.error;
  if (itemsRead.error) throw itemsRead.error;
  const periods = ((periodsRead.data ?? []) as PeriodRow[]).map(adaptPeriod);
  const byPeriod = new Map(periods.map((p) => [p.id, p]));
  const names = new Map(employees.map((e) => [e.id, e.name]));
  const items = (itemsRead.data ?? []) as ItemRow[];
  const liquidations = ((slipsRead.data ?? []) as PayslipRow[]).flatMap((s) => {
    const p = byPeriod.get(s.period_id);
    if (!p) return [];
    return [
      liquidationFromRows(s, items, names.get(s.employee_id) ?? '—', {
        start: p.start,
        end: p.end,
        frequency: p.frequency,
      }),
    ];
  });
  return { periods, employees, liquidations };
}

// ---------------------------------------------------------------------------
// Vacaciones, permisos, licencias e incapacidades
// ---------------------------------------------------------------------------

export async function listLeaveRequests(
  db: SupabaseClient,
  opts: {
    employeeId?: string;
    statuses?: string[];
    from?: string;
    to?: string;
    limit?: number;
  } = {},
): Promise<LeaveRequest[]> {
  let q = db
    .from('leave_requests')
    .select(LEAVE_COLUMNS)
    .order('start_date', { ascending: false })
    .limit(opts.limit ?? 500);
  if (opts.employeeId) q = q.eq('employee_id', opts.employeeId);
  if (opts.statuses?.length) q = q.in('status', opts.statuses);
  if (opts.to) q = q.lte('start_date', opts.to);
  if (opts.from) q = q.gte('end_date', opts.from);
  const { data, error } = await q;
  if (error) throw error;
  return ((data ?? []) as LeaveRow[]).map(adaptLeave);
}

/** El saldo de vacaciones de alguien a una fecha. */
export async function vacationBalanceFor(
  db: SupabaseClient,
  employee: Employee,
  asOf: string = bogotaToday(),
): Promise<VacationBalance> {
  const from = employee.vacationOpeningAsOf ?? employee.startDate;
  const [requests, unpaid] = await Promise.all([
    listLeaveRequests(db, { employeeId: employee.id, statuses: ['aprobada'] }),
    listNovelties(db, { employeeId: employee.id, from }),
  ]);
  const taken = requests
    .filter((r) => r.kind === 'vacaciones' && r.end >= from)
    .reduce((s, r) => s + r.businessDays, 0);
  const unpaidDays = unpaid
    .filter((n) => n.kind === 'licencia_no_remunerada' || n.kind === 'ausencia')
    .reduce(
      (s, n) => s + days360(n.date_from < from ? from : n.date_from, n.date_to ?? n.date_from),
      0,
    );
  return vacationBalance({
    startDate: employee.startDate,
    endDate: employee.endDate,
    openingDays: employee.vacationOpeningDays,
    openingAsOf: employee.vacationOpeningAsOf,
    takenBusinessDays: taken,
    unpaidDays,
    asOf,
  });
}

export interface LeaveRequestResult {
  request: LeaveRequest;
  warnings: string[];
  balance: VacationBalance | null;
  employeeName: string;
}

/** Pedir una ausencia: cada quien para sí; quien administra, para cualquiera. */
export async function requestLeave(
  db: SupabaseClient,
  input: LeaveInput,
  opts: { userId: string },
): Promise<LeaveRequestResult> {
  const parsed = leaveInputSchema.safeParse(input);
  if (!parsed.success)
    throw new ValidationError('La solicitud tiene un dato que no entiendo (fechas AAAA-MM-DD).');
  const p = parsed.data;
  const access = await payrollAccess(db, opts.userId);
  const employeeId = p.employeeId ?? access.employeeId;
  if (!employeeId)
    throw new ValidationError(
      'No te encuentro en la nómina de la empresa: pídele a quien administra que te registre con tu cuenta de Cortex.',
    );
  if (employeeId !== access.employeeId && !access.manager)
    throw new ForbiddenError(
      'Cada persona pide sus propias ausencias; para otra persona, que lo haga ella o quien administra.',
    );
  const employee = await getEmployee(db, employeeId);
  if (!employee || employee.status !== 'activo')
    throw new NotFoundError('Esa persona no está activa en la nómina.');
  if (employee.contractType === 'prestacion_servicios')
    throw new ValidationError(
      'Un contratista de prestación de servicios no pide vacaciones ni licencias de nómina.',
    );
  const settings = await readPayrollSettings(db);
  const days = leaveDays(p.start, p.end, { saturdayIsWorkday: settings.saturdayIsWorkday });
  const overlapping = await listLeaveRequests(db, {
    employeeId,
    statuses: ['pendiente', 'aprobada'],
    from: p.start,
    to: p.end,
  });
  const balance = p.kind === 'vacaciones' ? await vacationBalanceFor(db, employee, p.start) : null;
  const check = checkLeaveRequest({
    kind: p.kind,
    start: p.start,
    end: p.end,
    businessDays: days.businessDays,
    balance: balance?.balance ?? null,
    overlaps: overlapping.length,
  });
  if (check.errors.length) throw new ValidationError(check.errors.join(' '));
  const warnings = [...check.warnings];
  if (LEAVE_NEEDS_EVIDENCE.has(p.kind) && !p.evidenceDocumentId)
    warnings.push(
      'Adjunta el soporte (la incapacidad de la EPS, el registro civil…) para que se pueda aprobar y cobrar.',
    );
  const { data, error } = await db
    .from('leave_requests')
    .insert({
      employee_id: employeeId,
      requested_by: opts.userId,
      kind: p.kind,
      start_date: p.start,
      end_date: p.end,
      business_days: days.businessDays,
      calendar_days: days.calendarDays,
      reason: p.reason ?? null,
      evidence_document_id: p.evidenceDocumentId ?? null,
      status: 'pendiente',
    })
    .select(LEAVE_COLUMNS)
    .single();
  if (error) throw error;
  return { request: adaptLeave(data as LeaveRow), warnings, balance, employeeName: employee.name };
}

/** ¿Puede esta persona decidir sobre la ausencia de ese empleado? */
export async function canDecideLeave(
  db: SupabaseClient,
  deciderId: string,
  employee: Employee,
): Promise<boolean> {
  if (await isCompanyManager(db, deciderId)) return true;
  if (!employee.userId || employee.userId === deciderId) return false;
  const { data, error } = await db
    .from('users')
    .select('manager_id')
    .eq('id', employee.userId)
    .maybeSingle();
  if (error) return false;
  return (data as { manager_id?: string | null } | null)?.manager_id === deciderId;
}

/**
 * Aprobar o rechazar. Aprobada → novedad de nómina del mismo rango (que la
 * liquidación lee) y, si es vacaciones, descuenta del saldo.
 */
export async function decideLeave(
  db: SupabaseClient,
  input: { id: string; decision: 'aprobada' | 'rechazada'; note?: string | null },
  opts: { userId: string },
): Promise<{ request: LeaveRequest; employeeName: string; noveltyId: string | null }> {
  const { data: row, error } = await db
    .from('leave_requests')
    .select(LEAVE_COLUMNS)
    .eq('id', input.id)
    .maybeSingle();
  if (error) throw error;
  if (!row) throw new NotFoundError('Esa solicitud no existe.');
  const req = adaptLeave(row as LeaveRow);
  if (req.status !== 'pendiente') throw new ValidationError(`Esa solicitud ya está ${req.status}.`);
  const employee = await getEmployee(db, req.employeeId);
  if (!employee) throw new NotFoundError('Esa persona ya no está en la nómina.');
  if (!(await canDecideLeave(db, opts.userId, employee)))
    throw new ForbiddenError(
      'Aprueba quien administra la empresa o el jefe directo de la persona, y nadie decide sus propias ausencias.',
    );
  if (input.decision === 'rechazada' && !input.note?.trim())
    throw new ValidationError('Escribe por qué no se aprueba: la persona lo va a leer.');
  const now = new Date().toISOString();
  const upd = await db
    .from('leave_requests')
    .update({
      status: input.decision,
      decided_by: opts.userId,
      decided_at: now,
      decision_note: input.note?.trim() || null,
      updated_at: now,
    })
    .eq('id', input.id)
    .eq('status', 'pendiente')
    .select(LEAVE_COLUMNS)
    .maybeSingle();
  if (upd.error) throw upd.error;
  if (!upd.data) throw new ValidationError('La solicitud cambió mientras se decidía.');
  let noveltyId: string | null = null;
  if (input.decision === 'aprobada') {
    const nov = await addNovelty(
      db,
      {
        employeeId: req.employeeId,
        kind: LEAVE_TO_NOVELTY[req.kind],
        date: req.start,
        dateTo: req.end,
        note: req.reason?.slice(0, 200) ?? null,
      },
      { userId: opts.userId, source: 'licencia', leaveRequestId: req.id, skipAccessCheck: true },
    ).catch((err) => {
      // Un periodo ya cerrado: la solicitud queda aprobada y la novedad la
      // registra quien administra en el periodo siguiente.
      if (err instanceof ValidationError) return null;
      throw err;
    });
    noveltyId = nov?.id ?? null;
  }
  return { request: adaptLeave(upd.data as LeaveRow), employeeName: employee.name, noveltyId };
}

/** La persona cancela su propia solicitud pendiente. */
export async function cancelLeave(
  db: SupabaseClient,
  id: string,
  opts: { userId: string },
): Promise<void> {
  const access = await payrollAccess(db, opts.userId);
  const { data, error } = await db
    .from('leave_requests')
    .select('employee_id, status')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  const row = data as { employee_id: string; status: string } | null;
  if (!row) throw new NotFoundError('Esa solicitud no existe.');
  if (row.employee_id !== access.employeeId && !access.manager)
    throw new ForbiddenError('Sólo quien la pidió la cancela.');
  if (row.status !== 'pendiente')
    throw new ValidationError('Sólo se cancela una solicitud pendiente.');
  const upd = await db
    .from('leave_requests')
    .update({ status: 'cancelada', updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'pendiente');
  if (upd.error) throw upd.error;
}

/** El próximo periodo que toca liquidar (para el piloto y la pantalla). */
export function currentPeriodFor(
  today: string,
  frequency: 'mensual' | 'quincenal',
): { start: string; end: string } {
  return periodContaining(today, frequency);
}
