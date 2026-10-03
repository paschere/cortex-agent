import { addDaysIso, days360, isSundayOrHoliday, maxDay, minDay } from './dates';
import {
  ARL_RATES,
  type PayrollParams,
  RATES,
  RETENCION_LIMITS,
  RETENCION_TABLE,
  fspRate,
  paramsFor,
} from './params';

/**
 * EL MOTOR DE NÓMINA COLOMBIANA (0194). Puro: sin base de datos, sin reloj.
 *
 * Recibe una persona, su contrato, el periodo y sus novedades, y devuelve la
 * liquidación en LÍNEAS, cada una con su cuenta escrita en español
 * («30 días × $58.364 = $1.750.905»). La pantalla, el desprendible, la PILA y
 * el chat leen esas mismas líneas: no hay una segunda cuenta en ninguna parte.
 *
 * Qué liquida:
 *   devengados   salario de los días pagados, horas extra y recargos (con la
 *                tarifa del día de cada novedad), auxilio de transporte por
 *                días trabajados (≤ 2 SMMLV), vacaciones disfrutadas,
 *                incapacidades (2/3 con piso del mínimo; laboral al 100 %),
 *                licencias remuneradas, comisiones y bonificaciones.
 *   deducciones  salud 4 %, pensión 4 %, fondo de solidaridad (≥ 4 SMMLV),
 *                retención en la fuente procedimiento 1 (ESTIMADA) y otras.
 *   aportes      salud 8,5 % (con la exoneración del art. 114-1 ET), pensión
 *                12 %, ARL por clase, caja 4 %, ICBF 3 %, SENA 2 %.
 *   provisiones  cesantías 8,33 %, intereses 1 % mensual, prima 8,33 %,
 *                vacaciones 4,17 % (salario integral: sólo vacaciones).
 *
 * Lo que es estimado lo dice la línea (`estimate: true`) y `estimates`.
 * Redondeo: cada línea al peso. El operador de PILA redondea las
 * cotizaciones a la centena superior al pagar (pila.ts lo hace en su archivo).
 */

// ---------------------------------------------------------------------------
// Entradas
// ---------------------------------------------------------------------------

export const CONTRACT_TYPES = [
  'indefinido',
  'fijo',
  'obra',
  'aprendizaje',
  'prestacion_servicios',
] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];

export const CONTRACT_LABEL: Record<ContractType, string> = {
  indefinido: 'Término indefinido',
  fijo: 'Término fijo',
  obra: 'Obra o labor',
  aprendizaje: 'Aprendizaje',
  prestacion_servicios: 'Prestación de servicios (no va en nómina)',
};

export const NOVELTY_KINDS = [
  'hora_extra_diurna',
  'hora_extra_nocturna',
  'hora_extra_dominical_diurna',
  'hora_extra_dominical_nocturna',
  'recargo_nocturno',
  'recargo_dominical',
  'recargo_dominical_nocturno',
  'incapacidad_general',
  'incapacidad_laboral',
  'licencia_maternidad',
  'licencia_paternidad',
  'licencia_remunerada',
  'licencia_no_remunerada',
  'ausencia',
  'vacaciones',
  'comision',
  'bonificacion_salarial',
  'bonificacion_no_salarial',
  'deduccion',
] as const;
export type NoveltyKind = (typeof NOVELTY_KINDS)[number];

export const NOVELTY_LABEL: Record<NoveltyKind, string> = {
  hora_extra_diurna: 'Hora extra diurna',
  hora_extra_nocturna: 'Hora extra nocturna',
  hora_extra_dominical_diurna: 'Hora extra dominical/festiva diurna',
  hora_extra_dominical_nocturna: 'Hora extra dominical/festiva nocturna',
  recargo_nocturno: 'Recargo nocturno',
  recargo_dominical: 'Recargo dominical/festivo',
  recargo_dominical_nocturno: 'Recargo nocturno dominical/festivo',
  incapacidad_general: 'Incapacidad por enfermedad general',
  incapacidad_laboral: 'Incapacidad por accidente o enfermedad laboral',
  licencia_maternidad: 'Licencia de maternidad',
  licencia_paternidad: 'Licencia de paternidad',
  licencia_remunerada: 'Licencia o permiso remunerado',
  licencia_no_remunerada: 'Licencia no remunerada',
  ausencia: 'Ausencia injustificada',
  vacaciones: 'Vacaciones disfrutadas',
  comision: 'Comisión',
  bonificacion_salarial: 'Bonificación salarial',
  bonificacion_no_salarial: 'Bonificación no salarial',
  deduccion: 'Otra deducción (libranza, préstamo…)',
};

/** Las novedades que se miden en horas. */
export const HOUR_NOVELTIES: ReadonlySet<NoveltyKind> = new Set([
  'hora_extra_diurna',
  'hora_extra_nocturna',
  'hora_extra_dominical_diurna',
  'hora_extra_dominical_nocturna',
  'recargo_nocturno',
  'recargo_dominical',
  'recargo_dominical_nocturno',
]);
/** Las que son días fuera (descuentan días de salario). */
export const DAY_NOVELTIES: ReadonlySet<NoveltyKind> = new Set([
  'incapacidad_general',
  'incapacidad_laboral',
  'licencia_maternidad',
  'licencia_paternidad',
  'licencia_remunerada',
  'licencia_no_remunerada',
  'ausencia',
  'vacaciones',
]);
/** Las que son un valor. */
export const AMOUNT_NOVELTIES: ReadonlySet<NoveltyKind> = new Set([
  'comision',
  'bonificacion_salarial',
  'bonificacion_no_salarial',
  'deduccion',
]);

export interface EmployeeForPayroll {
  id: string;
  name: string;
  contractType: ContractType;
  /** Salario mensual pactado (o apoyo de sostenimiento si es aprendiz). */
  salary: number;
  integral: boolean;
  arlClass: 1 | 2 | 3 | 4 | 5;
  startDate: string;
  endDate?: string | null;
  apprenticePhase?: 'lectiva' | 'productiva' | null;
  /** Deducción por dependientes en la retención (art. 387 ET). */
  dependents?: boolean;
  /** Medicina prepagada mensual que certificó, para la retención. */
  prepaidHealth?: number | null;
}

export interface CompanyForPayroll {
  /**
   * Exonerada de salud empleador, SENA e ICBF por quienes ganan menos de 10
   * SMMLV (art. 114-1 ET): persona jurídica declarante de renta, o persona
   * natural con dos o más trabajadores.
   */
  exonerated1141: boolean;
}

export interface Novelty {
  id?: string;
  kind: NoveltyKind;
  /** Día de la novedad (o primer día si es un rango). */
  date: string;
  /** Último día, para las de días. */
  dateTo?: string | null;
  hours?: number | null;
  days?: number | null;
  amount?: number | null;
  note?: string | null;
}

export interface PeriodForPayroll {
  start: string;
  end: string;
  frequency: 'mensual' | 'quincenal';
}

// ---------------------------------------------------------------------------
// Salidas
// ---------------------------------------------------------------------------

export type LineGroup = 'devengado' | 'deduccion' | 'aporte_empleador' | 'provision';

export interface PayLine {
  code: string;
  group: LineGroup;
  label: string;
  quantity: number | null;
  unit: 'dias' | 'horas' | null;
  base: number | null;
  rate: number | null;
  amount: number;
  /** La cuenta, en español, con cifras. */
  explanation: string;
  estimate?: boolean;
}

export interface Liquidation {
  employeeId: string;
  employeeName: string;
  period: PeriodForPayroll;
  paramsVersion: string;
  /** Días del periodo que le tocan (30 un mes completo). */
  days: {
    contract: number;
    salary: number;
    worked: number;
    vacation: number;
    incapacity: number;
    paidLeave: number;
    unpaid: number;
  };
  ibc: { salud: number; pension: number; arl: number; parafiscales: number };
  lines: PayLine[];
  totals: {
    devengado: number;
    deducciones: number;
    neto: number;
    aportes: number;
    provisiones: number;
    /** Lo que le cuesta a la empresa: devengado + aportes + provisiones. */
    costoTotal: number;
  };
  /** Cosas que alguien tiene que mirar (no impiden liquidar). */
  warnings: string[];
  /** Qué partes son estimadas y por qué. */
  estimates: string[];
  /** Si la persona no va en nómina (prestación de servicios), por qué. */
  excluded: string | null;
}

// ---------------------------------------------------------------------------
// Ayudas
// ---------------------------------------------------------------------------

const round = (n: number) => Math.round(n);

export function cop(n: number): string {
  return `$${Math.round(n).toLocaleString('es-CO')}`;
}

function trimDecimals(text: string): string {
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

function pct(r: number): string {
  const v = Math.round(r * 100 * 10000) / 10000;
  return `${trimDecimals(v.toFixed(3))} %`.replace('.', ',');
}

function num(n: number): string {
  return trimDecimals((Math.round(n * 100) / 100).toFixed(2)).replace('.', ',');
}

/** Días de un rango de novedad que caen dentro del periodo (comerciales). */
function noveltyDaysInPeriod(n: Novelty, period: PeriodForPayroll): number {
  if (n.days != null && !n.dateTo) return Math.max(0, n.days);
  const from = maxDay(n.date, period.start);
  const to = minDay(n.dateTo ?? n.date, period.end);
  if (to < from) return 0;
  // Un rango que llega al fin de mes cuenta hasta el 30.
  return days360(from, to);
}

/** Factor de la hora según el tipo de novedad y el tramo vigente ese día. */
export function hourFactor(
  kind: NoveltyKind,
  p: PayrollParams,
): { factor: number; formula: string } {
  const dom = p.recargoDominicalFestivo;
  switch (kind) {
    case 'hora_extra_diurna':
      return { factor: 1 + p.extraDiurna, formula: `100 % + ${pct(p.extraDiurna)}` };
    case 'hora_extra_nocturna':
      return { factor: 1 + p.extraNocturna, formula: `100 % + ${pct(p.extraNocturna)}` };
    case 'hora_extra_dominical_diurna':
      return {
        factor: 1 + p.extraDiurna + dom,
        formula: `100 % + ${pct(p.extraDiurna)} extra + ${pct(dom)} dominical`,
      };
    case 'hora_extra_dominical_nocturna':
      return {
        factor: 1 + p.extraNocturna + dom,
        formula: `100 % + ${pct(p.extraNocturna)} extra nocturna + ${pct(dom)} dominical`,
      };
    case 'recargo_nocturno':
      return { factor: p.recargoNocturno, formula: `${pct(p.recargoNocturno)} de recargo` };
    case 'recargo_dominical':
      return { factor: dom, formula: `${pct(dom)} de recargo` };
    case 'recargo_dominical_nocturno':
      return {
        factor: dom + p.recargoNocturno,
        formula: `${pct(dom)} dominical + ${pct(p.recargoNocturno)} nocturno`,
      };
    default:
      return { factor: 0, formula: '' };
  }
}

/** Retención en la fuente, procedimiento 1, sobre una base MENSUAL (pesos). */
export function retencionProcedimiento1(input: {
  ingresosLaborales: number;
  aportesObligatorios: number;
  dependents: boolean;
  prepaidHealth: number;
  uvt: number;
}): { amount: number; baseUvt: number; explanation: string } {
  const { uvt } = input;
  const neto = Math.max(0, input.ingresosLaborales - input.aportesObligatorios);
  const dep = input.dependents
    ? Math.min(
        input.ingresosLaborales * RETENCION_LIMITS.dependientesPct,
        RETENCION_LIMITS.dependientesUvtMes * uvt,
      )
    : 0;
  const prep = Math.min(Math.max(0, input.prepaidHealth), RETENCION_LIMITS.prepagadaUvtMes * uvt);
  const deducciones = dep + prep;
  const exenta = Math.min((neto - deducciones) * 0.25, RETENCION_LIMITS.rentaExentaUvtMes * uvt);
  const tope = Math.min(
    neto * RETENCION_LIMITS.topeExentasPct,
    RETENCION_LIMITS.topeExentasUvtMes * uvt,
  );
  const beneficios = Math.max(0, Math.min(deducciones + Math.max(0, exenta), tope));
  const base = Math.max(0, neto - beneficios);
  const baseUvt = base / uvt;
  let retUvt = 0;
  for (const [from, to, rate, fixed] of RETENCION_TABLE) {
    if (baseUvt > from && baseUvt <= to) {
      retUvt = (baseUvt - from) * rate + fixed;
      break;
    }
  }
  // La DIAN redondea la retención al múltiplo de mil más cercano (art. 1.6.1.4.? DUR);
  // aquí se deja al peso: es una estimación.
  const amount = round(retUvt * uvt);
  return {
    amount,
    baseUvt,
    explanation:
      amount > 0
        ? `Base gravable ${cop(base)} (${num(Math.round(baseUvt * 100) / 100)} UVT de ${cop(uvt)}) tras restar aportes ${cop(input.aportesObligatorios)}, deducciones ${cop(deducciones)} y 25 % exento ${cop(Math.max(0, beneficios - deducciones))} → tabla del art. 383 ET.`
        : `Base gravable ${cop(base)} (${num(Math.round(baseUvt * 100) / 100)} UVT): por debajo de 95 UVT no hay retención.`,
  };
}

// ---------------------------------------------------------------------------
// La liquidación de un periodo
// ---------------------------------------------------------------------------

export function liquidate(input: {
  employee: EmployeeForPayroll;
  company: CompanyForPayroll;
  period: PeriodForPayroll;
  novelties?: Novelty[];
}): Liquidation {
  const { employee: e, company, period } = input;
  const p = paramsFor(period.end);
  const novelties = (input.novelties ?? []).filter(
    (n) =>
      (n.dateTo ?? n.date) >= period.start &&
      n.date <= period.end &&
      (n.hours == null || n.hours > 0) &&
      (n.amount == null || n.amount >= 0),
  );
  const lines: PayLine[] = [];
  const warnings: string[] = [];
  const estimates: string[] = [];
  const empty = (excluded: string | null): Liquidation => ({
    employeeId: e.id,
    employeeName: e.name,
    period,
    paramsVersion: p.version,
    days: {
      contract: 0,
      salary: 0,
      worked: 0,
      vacation: 0,
      incapacity: 0,
      paidLeave: 0,
      unpaid: 0,
    },
    ibc: { salud: 0, pension: 0, arl: 0, parafiscales: 0 },
    lines: [],
    totals: { devengado: 0, deducciones: 0, neto: 0, aportes: 0, provisiones: 0, costoTotal: 0 },
    warnings,
    estimates,
    excluded,
  });

  if (e.contractType === 'prestacion_servicios')
    return empty(
      'Contrato de prestación de servicios: no es un empleado y no va en la nómina. Se paga contra su cuenta de cobro o factura, y él cotiza su propia seguridad social.',
    );

  // Días del contrato dentro del periodo (ingreso o retiro a mitad).
  const from = maxDay(e.startDate, period.start);
  const to = minDay(e.endDate ?? period.end, period.end);
  if (to < from) return empty('No tenía contrato vigente en este periodo.');
  const contractDays = days360(from, to);
  if (e.startDate > period.start)
    warnings.push(
      `Ingresó el ${e.startDate}: se liquidan ${contractDays} días (novedad ING en la PILA).`,
    );
  if (e.endDate && e.endDate < period.end)
    warnings.push(
      `Se retira el ${e.endDate}: falta la liquidación del contrato (novedad RET en la PILA).`,
    );

  const salary = e.salary;
  const daily = salary / 30;
  const isApprentice = e.contractType === 'aprendizaje';
  const smmlvDaily = p.smmlv / 30;

  if (e.integral && salary < RATES.integralMinimoSmmlv * p.smmlv)
    warnings.push(
      `Un salario integral no puede ser menor a ${RATES.integralMinimoSmmlv} salarios mínimos (${cop(RATES.integralMinimoSmmlv * p.smmlv)}).`,
    );
  if (!e.integral && !isApprentice && salary < p.smmlv)
    warnings.push(
      `El salario (${cop(salary)}) está por debajo del mínimo de ${p.year} (${cop(p.smmlv)}).`,
    );

  // --- Días fuera ------------------------------------------------------------
  let vacationDays = 0;
  let incapacityDays = 0;
  let paidLeaveDays = 0;
  let unpaidDays = 0;
  for (const n of novelties) {
    if (!DAY_NOVELTIES.has(n.kind)) continue;
    const d = noveltyDaysInPeriod(n, period);
    if (n.kind === 'vacaciones') vacationDays += d;
    else if (n.kind.startsWith('incapacidad')) incapacityDays += d;
    else if (n.kind === 'licencia_no_remunerada' || n.kind === 'ausencia') unpaidDays += d;
    else paidLeaveDays += d;
  }
  const offDays = vacationDays + incapacityDays + paidLeaveDays + unpaidDays;
  if (offDays > contractDays) {
    warnings.push(
      `Las novedades suman ${offDays} días y el periodo tiene ${contractDays}: revisa las fechas.`,
    );
  }
  const salaryDays = Math.max(0, contractDays - offDays);
  const workedDays = salaryDays; // días efectivamente trabajados (auxilio, ARL)

  // --- Devengados ------------------------------------------------------------
  let salarial = 0; // lo que es salario (base de aportes y prestaciones)
  let noSalarial = 0;
  let incapacityPay = 0;

  if (isApprentice) {
    const phase = e.apprenticePhase ?? 'lectiva';
    const amount = round((salary / 30) * (salaryDays + vacationDays + paidLeaveDays));
    lines.push({
      code: 'apoyo_sostenimiento',
      group: 'devengado',
      label: `Apoyo de sostenimiento (etapa ${phase})`,
      quantity: salaryDays + vacationDays + paidLeaveDays,
      unit: 'dias',
      base: salary,
      rate: null,
      amount,
      explanation: `${salaryDays + vacationDays + paidLeaveDays} días × ${cop(salary / 30)} (${cop(salary)} al mes). En etapa lectiva el apoyo es al menos 75 % del mínimo; en productiva, el 100 % (Ley 2466 de 2025).`,
    });
    noSalarial += amount;
    const minimum = phase === 'lectiva' ? 0.75 * p.smmlv : p.smmlv;
    if (salary < minimum)
      warnings.push(
        `El apoyo de sostenimiento (${cop(salary)}) está por debajo de lo exigido en etapa ${phase} (${cop(minimum)}).`,
      );
    estimates.push(
      'Contrato de aprendizaje: la Ley 2466 de 2025 lo volvió contrato laboral especial; la afiliación y cotizaciones que aplica Cortex (salud y pensión a cargo de la empresa, ARL en etapa productiva) deben validarse con el contador.',
    );
  } else if (salaryDays > 0) {
    const amount = round(daily * salaryDays);
    lines.push({
      code: 'salario',
      group: 'devengado',
      label: e.integral ? 'Salario integral' : 'Salario',
      quantity: salaryDays,
      unit: 'dias',
      base: salary,
      rate: null,
      amount,
      explanation: `${salaryDays} días × ${cop(daily)} (${cop(salary)} ÷ 30)`,
    });
    salarial += amount;
  }

  // Horas extra y recargos, con la tarifa vigente el día de cada una.
  for (const n of novelties) {
    if (!HOUR_NOVELTIES.has(n.kind)) continue;
    if (isApprentice) {
      warnings.push(
        'Un aprendiz no debe trabajar horas extra ni en horario nocturno: revisa la novedad.',
      );
    }
    const pd = paramsFor(n.date);
    const hourValue = salary / pd.monthlyHours;
    const { factor, formula } = hourFactor(n.kind, pd);
    const hours = n.hours ?? 0;
    const amount = round(hours * hourValue * factor);
    if (
      (n.kind === 'recargo_dominical' || n.kind.includes('dominical')) &&
      !isSundayOrHoliday(n.date)
    )
      warnings.push(`${NOVELTY_LABEL[n.kind]} del ${n.date}: ese día no es domingo ni festivo.`);
    lines.push({
      code: n.kind,
      group: 'devengado',
      label: `${NOVELTY_LABEL[n.kind]} (${n.date})`,
      quantity: hours,
      unit: 'horas',
      base: round(hourValue),
      rate: factor,
      amount,
      explanation: `${num(hours)} h × ${cop(hourValue)} la hora (${cop(salary)} ÷ ${pd.monthlyHours} h, jornada de ${pd.weeklyHours} h) × ${num(Math.round(factor * 10000) / 10000)} (${formula})${n.kind.startsWith('recargo_dominical') ? '. Si el trabajo dominical es habitual, además corresponde descanso compensatorio.' : ''}`,
    });
    salarial += amount;
  }

  // Vacaciones disfrutadas: el salario de esos días (hábiles + descansos).
  if (vacationDays > 0 && !isApprentice) {
    const amount = round(daily * vacationDays);
    lines.push({
      code: 'vacaciones',
      group: 'devengado',
      label: 'Vacaciones disfrutadas',
      quantity: vacationDays,
      unit: 'dias',
      base: salary,
      rate: null,
      amount,
      explanation: `${vacationDays} días calendario de vacaciones × ${cop(daily)}. Con salario variable se liquidan con el promedio del último año: revísalo.`,
    });
    salarial += amount;
  }

  // Incapacidades y licencias.
  for (const n of novelties) {
    if (!DAY_NOVELTIES.has(n.kind) || n.kind === 'vacaciones') continue;
    const d = noveltyDaysInPeriod(n, period);
    if (d <= 0) continue;
    if (n.kind === 'incapacidad_general') {
      const perDay = Math.max(daily * RATES.incapacidadGeneral, smmlvDaily);
      const amount = round(perDay * d);
      const employerDays = Math.min(2, d);
      lines.push({
        code: 'incapacidad_general',
        group: 'devengado',
        label: `Incapacidad general (${n.date}${n.dateTo ? ` a ${n.dateTo}` : ''})`,
        quantity: d,
        unit: 'dias',
        base: round(perDay),
        rate: RATES.incapacidadGeneral,
        amount,
        explanation: `${d} días × ${cop(perDay)} (2/3 del salario diario, nunca menos del mínimo diario ${cop(smmlvDaily)}). Los primeros ${employerDays} días los paga la empresa; desde el tercero los reconoce la EPS (hay que cobrárselos). Del día 91 al 180 baja al 50 %.`,
      });
      incapacityPay += amount;
    } else if (n.kind === 'incapacidad_laboral') {
      const amount = round(daily * d);
      lines.push({
        code: 'incapacidad_laboral',
        group: 'devengado',
        label: `Incapacidad laboral (${n.date}${n.dateTo ? ` a ${n.dateTo}` : ''})`,
        quantity: d,
        unit: 'dias',
        base: salary,
        rate: 1,
        amount,
        explanation: `${d} días × ${cop(daily)} (100 %). El día del accidente lo paga la empresa; desde el siguiente lo reconoce la ARL.`,
      });
      incapacityPay += amount;
    } else if (n.kind === 'licencia_maternidad' || n.kind === 'licencia_paternidad') {
      const amount = round(daily * d);
      lines.push({
        code: n.kind,
        group: 'devengado',
        label: NOVELTY_LABEL[n.kind],
        quantity: d,
        unit: 'dias',
        base: salary,
        rate: 1,
        amount,
        explanation: `${d} días × ${cop(daily)} (100 %), los reconoce la EPS. Maternidad: 18 semanas; paternidad: 2 semanas (Ley 2114 de 2021).`,
      });
      incapacityPay += amount;
    } else if (n.kind === 'licencia_remunerada') {
      const amount = round(daily * d);
      lines.push({
        code: 'licencia_remunerada',
        group: 'devengado',
        label: `Licencia remunerada${n.note ? ` (${n.note.slice(0, 40)})` : ''}`,
        quantity: d,
        unit: 'dias',
        base: salary,
        rate: 1,
        amount,
        explanation: `${d} días × ${cop(daily)}. Incluye luto (5 días hábiles, Ley 1280 de 2009), calamidad doméstica y permisos pagados.`,
      });
      salarial += amount;
    } else {
      lines.push({
        code: n.kind,
        group: 'devengado',
        label: `${NOVELTY_LABEL[n.kind]} (${n.date}${n.dateTo ? ` a ${n.dateTo}` : ''})`,
        quantity: d,
        unit: 'dias',
        base: salary,
        rate: 0,
        amount: 0,
        explanation: `${d} días sin pago. ${n.kind === 'licencia_no_remunerada' ? 'Suspende el contrato: esos días no suman para prestaciones ni vacaciones; la empresa sigue cotizando pensión.' : 'Descuenta esos días del salario y del auxilio de transporte.'}`,
      });
    }
  }

  // Comisiones y bonificaciones.
  for (const n of novelties) {
    if (
      n.kind !== 'comision' &&
      n.kind !== 'bonificacion_salarial' &&
      n.kind !== 'bonificacion_no_salarial'
    )
      continue;
    const amount = round(n.amount ?? 0);
    if (amount <= 0) continue;
    const isSal = n.kind !== 'bonificacion_no_salarial';
    lines.push({
      code: n.kind,
      group: 'devengado',
      label: `${NOVELTY_LABEL[n.kind]}${n.note ? ` (${n.note.slice(0, 40)})` : ''}`,
      quantity: null,
      unit: null,
      base: null,
      rate: null,
      amount,
      explanation: isSal
        ? `${cop(amount)} que es salario: suma para aportes y prestaciones.`
        : `${cop(amount)} pactado como no salarial (art. 128 CST): no suma para prestaciones; si lo no salarial pasa del 40 % del total, el exceso sí cotiza (Ley 1393 de 2010).`,
    });
    if (isSal) salarial += amount;
    else noSalarial += amount;
  }

  // Auxilio de transporte: hasta 2 SMMLV, por días trabajados.
  const monthlySalarialRef = isApprentice ? 0 : salary;
  if (
    !isApprentice &&
    !e.integral &&
    monthlySalarialRef <= RATES.auxilioTopeSmmlv * p.smmlv &&
    workedDays > 0
  ) {
    const amount = round((p.auxilioTransporte / 30) * workedDays);
    lines.push({
      code: 'auxilio_transporte',
      group: 'devengado',
      label: 'Auxilio de transporte',
      quantity: workedDays,
      unit: 'dias',
      base: p.auxilioTransporte,
      rate: null,
      amount,
      explanation: `${workedDays} días trabajados × ${cop(p.auxilioTransporte / 30)} (${cop(p.auxilioTransporte)} de ${p.year}, para quien gana hasta 2 mínimos). No se paga en vacaciones, incapacidades ni licencias, y no es base de aportes.`,
    });
  }

  const devengado = lines.filter((l) => l.group === 'devengado').reduce((s, l) => s + l.amount, 0);

  // --- IBC ----------------------------------------------------------------------
  // Días que se reportan a cada subsistema en la PILA.
  const reportDays = Math.max(0, contractDays - unpaidDays);
  let ibcBase = salarial + incapacityPay;
  if (e.integral) ibcBase = round((salarial + incapacityPay) * RATES.integralFactorAportes);
  // Ley 1393: lo no salarial por encima del 40 % de la remuneración total.
  const totalRem = salarial + noSalarial;
  if (!isApprentice && totalRem > 0 && noSalarial > RATES.noSalarialTope * totalRem) {
    const excess = round(noSalarial - RATES.noSalarialTope * totalRem);
    ibcBase += excess;
    warnings.push(
      `Lo no salarial pasa del 40 % de la remuneración: ${cop(excess)} entran al IBC (Ley 1393 de 2010, art. 30).`,
    );
  }
  const ibcMin = round((p.smmlv / 30) * reportDays);
  const ibcMax = round(((RATES.ibcMaxSmmlv * p.smmlv) / 30) * reportDays);
  let ibc = Math.min(Math.max(ibcBase, ibcMin), ibcMax);
  if (isApprentice) ibc = round((p.smmlv / 30) * reportDays);
  if (reportDays === 0) ibc = 0;
  // ARL: sólo días trabajados (no vacaciones, incapacidades ni licencias):
  // el salario de esos días más lo variable, con piso del mínimo.
  const arlEarnings = lines
    .filter(
      (l) =>
        l.group === 'devengado' &&
        (l.code === 'salario' ||
          HOUR_NOVELTIES.has(l.code as NoveltyKind) ||
          l.code === 'comision' ||
          l.code === 'bonificacion_salarial'),
    )
    .reduce((s, l) => s + l.amount, 0);
  const ibcArl =
    workedDays === 0
      ? 0
      : Math.min(
          Math.max(
            round(e.integral ? arlEarnings * RATES.integralFactorAportes : arlEarnings),
            round((p.smmlv / 30) * workedDays),
          ),
          ibcMax,
        );
  // Parafiscales: salario + vacaciones, sin incapacidades.
  const parafBase = e.integral ? round(salarial * RATES.integralFactorAportes) : salarial;
  const ibcParaf = isApprentice ? 0 : Math.min(parafBase, ibcMax);

  // --- Deducciones -------------------------------------------------------------
  const smmlvMultiple = ibc / ((p.smmlv / 30) * Math.max(1, reportDays));
  let aportesEmpleado = 0;
  if (!isApprentice && ibc > 0) {
    const salud = round(ibc * RATES.saludEmpleado);
    const pension = round(ibc * RATES.pensionEmpleado);
    lines.push({
      code: 'salud_empleado',
      group: 'deduccion',
      label: 'Salud (4 %)',
      quantity: null,
      unit: null,
      base: ibc,
      rate: RATES.saludEmpleado,
      amount: salud,
      explanation: `4 % de un IBC de ${cop(ibc)}${e.integral ? ' (70 % del salario integral)' : ''}.`,
    });
    lines.push({
      code: 'pension_empleado',
      group: 'deduccion',
      label: 'Pensión (4 %)',
      quantity: null,
      unit: null,
      base: ibc,
      rate: RATES.pensionEmpleado,
      amount: pension,
      explanation: `4 % de un IBC de ${cop(ibc)}.`,
    });
    aportesEmpleado = salud + pension;
    const fsp = fspRate(smmlvMultiple);
    if (fsp > 0) {
      const amount = round(ibc * fsp);
      lines.push({
        code: 'fondo_solidaridad',
        group: 'deduccion',
        label: `Fondo de solidaridad pensional (${pct(fsp)})`,
        quantity: null,
        unit: null,
        base: ibc,
        rate: fsp,
        amount,
        explanation: `El IBC equivale a ${num(Math.round(smmlvMultiple * 100) / 100)} salarios mínimos (≥ 4): ${pct(fsp)} (Ley 797 de 2003, art. 8). La reforma pensional lo cambia desde abril de 2027.`,
      });
      aportesEmpleado += amount;
    }
  }

  // Retención en la fuente (estimada, procedimiento 1), sobre el mes.
  if (!isApprentice && contractDays > 0) {
    const scale = 30 / contractDays;
    const rf = retencionProcedimiento1({
      ingresosLaborales: devengado * scale,
      aportesObligatorios: aportesEmpleado * scale,
      dependents: e.dependents ?? false,
      prepaidHealth: e.prepaidHealth ?? 0,
      uvt: p.uvt,
    });
    const amount = round(rf.amount / scale);
    if (amount > 0) {
      lines.push({
        code: 'retencion_fuente',
        group: 'deduccion',
        label: 'Retención en la fuente (estimada)',
        quantity: null,
        unit: null,
        base: null,
        rate: null,
        amount,
        explanation: `Procedimiento 1, sobre el mes: ${rf.explanation}${contractDays !== 30 ? ` Proporcional a ${contractDays} días.` : ''}`,
        estimate: true,
      });
      estimates.push(
        'La retención en la fuente es una estimación del procedimiento 1 (sin intereses de vivienda, aportes voluntarios ni AFC): el contador la confirma con los certificados de la persona.',
      );
    }
  }

  for (const n of novelties) {
    if (n.kind !== 'deduccion') continue;
    const amount = round(n.amount ?? 0);
    if (amount <= 0) continue;
    lines.push({
      code: 'deduccion',
      group: 'deduccion',
      label: n.note ? n.note.slice(0, 60) : 'Otra deducción',
      quantity: null,
      unit: null,
      base: null,
      rate: null,
      amount,
      explanation: `${cop(amount)} autorizado por escrito por la persona (art. 149 CST).`,
    });
  }

  // --- Aportes del empleador --------------------------------------------------
  const exonerated =
    company.exonerated1141 &&
    !e.integral &&
    !isApprentice &&
    salarial + noSalarial < RATES.exoneracionTopeSmmlv * (p.smmlv / 30) * Math.max(1, contractDays);
  const aporte = (code: string, label: string, base: number, rate: number, explanation: string) => {
    if (base <= 0 || rate <= 0) return;
    lines.push({
      code,
      group: 'aporte_empleador',
      label,
      quantity: null,
      unit: null,
      base,
      rate,
      amount: round(base * rate),
      explanation,
    });
  };
  if (isApprentice) {
    aporte(
      'salud_empleador',
      'Salud aprendiz (12,5 %)',
      ibc,
      0.125,
      `12,5 % de ${cop(ibc)} (el mínimo), toda a cargo de la empresa.`,
    );
    if ((e.apprenticePhase ?? 'lectiva') === 'productiva') {
      aporte(
        'pension_empleador',
        'Pensión aprendiz (16 %)',
        ibc,
        0.16,
        `16 % de ${cop(ibc)} a cargo de la empresa (Ley 2466 de 2025). Validar con el contador.`,
      );
      aporte(
        'arl',
        `ARL clase ${e.arlClass}`,
        round((p.smmlv / 30) * workedDays),
        ARL_RATES[e.arlClass],
        `${pct(ARL_RATES[e.arlClass])} sobre el mínimo de los días en etapa productiva.`,
      );
    }
  } else {
    if (!exonerated)
      aporte(
        'salud_empleador',
        'Salud empleador (8,5 %)',
        ibc,
        RATES.saludEmpleador,
        `8,5 % de ${cop(ibc)}${company.exonerated1141 ? ' — no aplica la exoneración del art. 114-1 ET (gana 10 mínimos o más, o es integral)' : ''}.`,
      );
    aporte(
      'pension_empleador',
      'Pensión empleador (12 %)',
      ibc,
      RATES.pensionEmpleador,
      `12 % de ${cop(ibc)}.`,
    );
    aporte(
      'arl',
      `ARL clase ${e.arlClass} (${pct(ARL_RATES[e.arlClass])})`,
      ibcArl,
      ARL_RATES[e.arlClass],
      `${pct(ARL_RATES[e.arlClass])} sobre ${cop(ibcArl)} de ${workedDays} días trabajados (Decreto 1772 de 1994).`,
    );
    aporte(
      'caja',
      'Caja de compensación (4 %)',
      ibcParaf,
      RATES.caja,
      `4 % de ${cop(ibcParaf)} (salario y vacaciones, sin incapacidades).`,
    );
    if (!exonerated) {
      aporte('icbf', 'ICBF (3 %)', ibcParaf, RATES.icbf, `3 % de ${cop(ibcParaf)}.`);
      aporte('sena', 'SENA (2 %)', ibcParaf, RATES.sena, `2 % de ${cop(ibcParaf)}.`);
    }
  }
  if (exonerated)
    lines.push({
      code: 'exoneracion_1141',
      group: 'aporte_empleador',
      label: 'Exonerada de salud empleador, ICBF y SENA',
      quantity: null,
      unit: null,
      base: null,
      rate: null,
      amount: 0,
      explanation:
        'Art. 114-1 ET: la empresa está exonerada y la persona gana menos de 10 salarios mínimos.',
    });
  if (unpaidDays > 0 && !isApprentice) {
    const base = round(daily * unpaidDays);
    aporte(
      'pension_licencia',
      'Pensión de la licencia no remunerada (12 %)',
      base,
      RATES.pensionEmpleador,
      `Durante la licencia no remunerada la empresa sigue cotizando su parte de pensión sobre ${cop(base)} (${unpaidDays} días). Validar con el contador si también aplica salud.`,
    );
    estimates.push(
      'Los aportes de una licencia no remunerada o ausencia dependen del caso: el contador los confirma.',
    );
  }

  // --- Provisiones (prestaciones sociales) -------------------------------------
  if (!isApprentice) {
    const presDays = Math.max(0, contractDays - unpaidDays);
    const salaryPart = round(daily * presDays);
    const variable = lines
      .filter(
        (l) =>
          l.group === 'devengado' &&
          (HOUR_NOVELTIES.has(l.code as NoveltyKind) ||
            l.code === 'comision' ||
            l.code === 'bonificacion_salarial'),
      )
      .reduce((s, l) => s + l.amount, 0);
    const auxilio = lines.find((l) => l.code === 'auxilio_transporte')?.amount ?? 0;
    const prov = (code: string, label: string, base: number, rate: number, explanation: string) => {
      if (base <= 0) return;
      lines.push({
        code,
        group: 'provision',
        label,
        quantity: null,
        unit: null,
        base,
        rate,
        amount: round(base * rate),
        explanation,
      });
    };
    if (!e.integral) {
      const base = salaryPart + variable + auxilio;
      prov(
        'cesantias',
        'Cesantías (8,33 %)',
        base,
        RATES.cesantias,
        `${cop(base)} (salario de ${presDays} días + variable ${cop(variable)} + auxilio ${cop(auxilio)}) ÷ 12. Se consignan al fondo antes del 14 de febrero.`,
      );
      prov(
        'intereses_cesantias',
        'Intereses a las cesantías (1 %)',
        round(base * RATES.cesantias),
        RATES.interesesCesantiasAnual,
        `12 % anual sobre las cesantías del periodo (${cop(round(base * RATES.cesantias))}). Se pagan a la persona en enero.`,
      );
      prov(
        'prima',
        'Prima de servicios (8,33 %)',
        base,
        RATES.prima,
        `${cop(base)} ÷ 12. Se paga en junio y diciembre.`,
      );
    }
    prov(
      'vacaciones_prov',
      'Vacaciones (4,17 %)',
      salaryPart,
      RATES.vacaciones,
      `${cop(salaryPart)} × 15 ÷ 360 (sin auxilio de transporte ni horas extra).`,
    );
  }

  // --- Totales ---------------------------------------------------------------
  const sum = (g: LineGroup) =>
    lines.filter((l) => l.group === g).reduce((s, l) => s + l.amount, 0);
  const deducciones = sum('deduccion');
  const aportes = sum('aporte_empleador');
  const provisiones = sum('provision');
  const neto = devengado - deducciones;
  if (neto < 0) warnings.push('Las deducciones superan lo devengado: el neto sale negativo.');
  const voluntary = lines.filter((l) => l.code === 'deduccion').reduce((s, l) => s + l.amount, 0);
  if (voluntary > 0 && voluntary > 0.5 * (devengado - (deducciones - voluntary)))
    warnings.push(
      'Las deducciones voluntarias se llevan más de la mitad de lo que le queda a la persona: revisa el límite de las libranzas (Ley 1527 de 2012).',
    );
  if (p.needsConfirmation.length) estimates.push(...p.needsConfirmation);

  return {
    employeeId: e.id,
    employeeName: e.name,
    period,
    paramsVersion: p.version,
    days: {
      contract: contractDays,
      salary: salaryDays,
      worked: workedDays,
      vacation: vacationDays,
      incapacity: incapacityDays,
      paidLeave: paidLeaveDays,
      unpaid: unpaidDays,
    },
    ibc: { salud: ibc, pension: ibc, arl: ibcArl, parafiscales: ibcParaf },
    lines,
    totals: {
      devengado,
      deducciones,
      neto,
      aportes,
      provisiones,
      costoTotal: devengado + aportes + provisiones,
    },
    warnings,
    estimates: [...new Set(estimates)],
    excluded: null,
  };
}

/** Totales de varias liquidaciones (el periodo entero). */
export function sumLiquidations(
  list: Liquidation[],
): Liquidation['totals'] & { employees: number } {
  const t = {
    devengado: 0,
    deducciones: 0,
    neto: 0,
    aportes: 0,
    provisiones: 0,
    costoTotal: 0,
    employees: 0,
  };
  for (const l of list) {
    if (l.excluded) continue;
    t.employees++;
    t.devengado += l.totals.devengado;
    t.deducciones += l.totals.deducciones;
    t.neto += l.totals.neto;
    t.aportes += l.totals.aportes;
    t.provisiones += l.totals.provisiones;
    t.costoTotal += l.totals.costoTotal;
  }
  return t;
}

/** El siguiente periodo después de uno (para «¿qué toca ahora?»). */
export function nextPeriod(
  prev: { end: string },
  frequency: 'mensual' | 'quincenal',
): { start: string; end: string } {
  const start = addDaysIso(prev.end, 1);
  const [y, m, d] = start.split('-').map(Number) as [number, number, number];
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  if (frequency === 'mensual' || d > 15) return { start, end: last };
  return { start, end: `${start.slice(0, 7)}-15` };
}
