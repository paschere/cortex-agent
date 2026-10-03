import { days360, maxDay } from './dates';
import { type ContractType, type PayLine, cop } from './engine';
import { RATES, paramsFor } from './params';

/**
 * LA LIQUIDACIÓN DEL CONTRATO (terminación) — ESTIMADA, pura.
 *
 * Lo que se le debe a una persona el día que sale: salario pendiente,
 * cesantías e intereses desde la última consignación, prima del semestre,
 * vacaciones no disfrutadas y, si la empresa termina sin justa causa, la
 * indemnización del art. 64 CST:
 *
 *   indefinido, < 10 SMMLV   30 días el primer año + 20 por cada año
 *                             siguiente (y proporcional por fracción).
 *   indefinido, ≥ 10 SMMLV   20 días el primer año + 15 por cada siguiente.
 *   término fijo             los salarios del tiempo que falta del contrato.
 *   obra o labor             lo que falte de la obra, mínimo 15 días.
 *
 * Es una ESTIMACIÓN y así se rotula: un abogado laboral o el contador la
 * revisan antes de pagar (salario variable, pagos pendientes, pactos,
 * fuero de estabilidad, sanción moratoria del art. 65).
 */

export const TERMINATION_REASONS = [
  'sin_justa_causa',
  'justa_causa',
  'renuncia',
  'mutuo_acuerdo',
  'fin_contrato',
  'periodo_prueba',
] as const;
export type TerminationReason = (typeof TERMINATION_REASONS)[number];

export const TERMINATION_LABEL: Record<TerminationReason, string> = {
  sin_justa_causa: 'Despido sin justa causa',
  justa_causa: 'Despido con justa causa',
  renuncia: 'Renuncia',
  mutuo_acuerdo: 'Mutuo acuerdo',
  fin_contrato: 'Terminación del plazo o de la obra',
  periodo_prueba: 'Terminación en periodo de prueba',
};

export interface TerminationInput {
  name: string;
  contractType: ContractType;
  salary: number;
  integral: boolean;
  startDate: string;
  terminationDate: string;
  reason: TerminationReason;
  /** Hasta qué día ya se pagó el salario (la última nómina). */
  salaryPaidThrough: string;
  /** Fin pactado (fijo) o esperado (obra). */
  contractEnd?: string | null;
  /** Días hábiles de vacaciones pendientes (del saldo). */
  vacationDaysPending: number;
  /** Promedio de lo variable del último año (horas extra, comisiones). */
  variableMonthlyAverage?: number;
}

export interface TerminationResult {
  lines: PayLine[];
  total: number;
  indemnization: number;
  estimate: true;
  notes: string[];
}

export function liquidateTermination(input: TerminationInput): TerminationResult {
  const p = paramsFor(input.terminationDate);
  const lines: PayLine[] = [];
  const notes: string[] = [
    'Estimación: la confirma un abogado laboral o el contador antes de pagar.',
    'Si no se paga lo que se debe al terminar, corre la sanción moratoria del art. 65 CST (un día de salario por cada día de retraso).',
  ];
  const daily = input.salary / 30;
  const variable = input.variableMonthlyAverage ?? 0;
  const auxilio =
    !input.integral && input.salary <= RATES.auxilioTopeSmmlv * p.smmlv ? p.auxilioTransporte : 0;
  const year = input.terminationDate.slice(0, 4);
  const push = (l: Omit<PayLine, 'group' | 'estimate'>) =>
    lines.push({ ...l, group: 'devengado', estimate: true });

  if (input.contractType === 'prestacion_servicios') {
    return {
      lines: [],
      total: 0,
      indemnization: 0,
      estimate: true,
      notes: [
        'Un contrato de prestación de servicios no se liquida con prestaciones: se paga lo pactado contra su cuenta de cobro.',
      ],
    };
  }

  // Salario pendiente.
  if (input.terminationDate > input.salaryPaidThrough) {
    const d = days360(nextDay(input.salaryPaidThrough), input.terminationDate);
    if (d > 0)
      push({
        code: 'salario_pendiente',
        label: 'Salario pendiente',
        quantity: d,
        unit: 'dias',
        base: input.salary,
        rate: null,
        amount: Math.round(daily * d),
        explanation: `${d} días × ${cop(daily)} desde la última nómina.`,
      });
  }

  // Cesantías e intereses del año en curso, prima del semestre.
  if (!input.integral && input.contractType !== 'aprendizaje') {
    const base = input.salary + variable + auxilio;
    const yearFrom = maxDay(`${year}-01-01`, input.startDate);
    const dYear = days360(yearFrom, input.terminationDate);
    const ces = Math.round((base * dYear) / 360);
    push({
      code: 'cesantias',
      label: 'Cesantías',
      quantity: dYear,
      unit: 'dias',
      base,
      rate: null,
      amount: ces,
      explanation: `${cop(base)} (salario${variable ? ' + variable' : ''}${auxilio ? ' + auxilio de transporte' : ''}) × ${dYear} días ÷ 360, desde ${yearFrom}.`,
    });
    push({
      code: 'intereses_cesantias',
      label: 'Intereses a las cesantías',
      quantity: dYear,
      unit: 'dias',
      base: ces,
      rate: 0.12,
      amount: Math.round((ces * dYear * 0.12) / 360),
      explanation: `${cop(ces)} × ${dYear} días × 12 % ÷ 360.`,
    });
    const semester =
      Number(input.terminationDate.slice(5, 7)) <= 6 ? `${year}-01-01` : `${year}-07-01`;
    const semFrom = maxDay(semester, input.startDate);
    const dSem = days360(semFrom, input.terminationDate);
    push({
      code: 'prima',
      label: 'Prima de servicios',
      quantity: dSem,
      unit: 'dias',
      base,
      rate: null,
      amount: Math.round((base * dSem) / 360),
      explanation: `${cop(base)} × ${dSem} días ÷ 360, desde ${semFrom}.`,
    });
  }

  // Vacaciones no disfrutadas: se compensan en dinero (art. 189 CST).
  if (input.vacationDaysPending > 0) {
    push({
      code: 'vacaciones_compensadas',
      label: 'Vacaciones no disfrutadas',
      quantity: input.vacationDaysPending,
      unit: 'dias',
      base: input.salary,
      rate: null,
      amount: Math.round(daily * input.vacationDaysPending),
      explanation: `${input.vacationDaysPending} días hábiles pendientes × ${cop(daily)} (sólo salario ordinario).`,
    });
  }

  // Indemnización (art. 64 CST).
  let indemnization = 0;
  if (input.reason === 'sin_justa_causa') {
    if (input.contractType === 'indefinido') {
      const served = days360(input.startDate, input.terminationDate);
      const high = input.salary >= 10 * p.smmlv;
      const first = high ? 20 : 30;
      const perYear = high ? 15 : 20;
      const extra = served > 360 ? ((served - 360) / 360) * perYear : 0;
      const exact = first + extra;
      const days = Math.round(exact * 100) / 100;
      indemnization = Math.round(daily * exact);
      push({
        code: 'indemnizacion',
        label: 'Indemnización por despido sin justa causa',
        quantity: days,
        unit: 'dias',
        base: input.salary,
        rate: null,
        amount: indemnization,
        explanation: `Art. 64 CST, contrato indefinido, ${high ? '10 o más' : 'menos de 10'} salarios mínimos: ${first} días por el primer año${extra ? ` + ${Math.round(extra * 100) / 100} días por ${Math.round(((served - 360) / 360) * 100) / 100} años adicionales (${perYear} por año)` : ''} = ${days} días × ${cop(daily)}.`,
      });
    } else if (input.contractType === 'fijo' || input.contractType === 'obra') {
      const end = input.contractEnd ?? null;
      if (!end) {
        notes.push(
          'Falta la fecha de terminación pactada (o esperada de la obra) para calcular la indemnización.',
        );
      } else {
        let days = Math.max(0, days360(nextDay(input.terminationDate), end));
        if (input.contractType === 'obra') days = Math.max(15, days);
        indemnization = Math.round(daily * days);
        push({
          code: 'indemnizacion',
          label: 'Indemnización por despido sin justa causa',
          quantity: days,
          unit: 'dias',
          base: input.salary,
          rate: null,
          amount: indemnization,
          explanation:
            input.contractType === 'fijo'
              ? `Art. 64 CST, término fijo: los salarios de los ${days} días que faltaban hasta el ${end}.`
              : `Art. 64 CST, obra o labor: lo que faltaba de la obra (${days} días, mínimo 15).`,
        });
      }
    }
  } else if (input.reason === 'justa_causa') {
    notes.push(
      'Con justa causa no hay indemnización, pero la causa debe estar probada y notificada por escrito con el debido proceso.',
    );
  } else if (input.reason === 'fin_contrato' && input.contractType === 'fijo') {
    notes.push(
      'El término fijo se termina sin indemnización sólo si se avisó por escrito con al menos 30 días de anticipación; si no, se renueva.',
    );
  }

  if (input.integral)
    notes.push(
      'Salario integral: no causa cesantías, intereses ni prima (ya van en el factor prestacional).',
    );
  const total = lines.reduce((s, l) => s + l.amount, 0);
  return { lines, total, indemnization, estimate: true, notes };
}

function nextDay(day: string): string {
  const t = new Date(`${day}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}
