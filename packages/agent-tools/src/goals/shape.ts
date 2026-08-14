import { bogotaToday, daysBetween } from '../commitments/shape';

/**
 * El núcleo puro del módulo de metas: períodos, unidades, y la decisión de si
 * un número cumplió o no.
 *
 * Todo lo de este archivo es función de sus argumentos. Ni base de datos, ni
 * reloj más allá del día que se le pasa, ni modelo. Es deliberado: las dos
 * cosas con más probabilidad de estar mal aquí son la aritmética de períodos en
 * Bogotá y la comparación contra el umbral, y las dos sólo son comprobables si
 * están separadas del trabajo que las usa.
 */

// ---------------------------------------------------------------------------
// Unidades y dirección
// ---------------------------------------------------------------------------

export const METRIC_UNITS = ['percent', 'days', 'count'] as const;
export type MetricUnit = (typeof METRIC_UNITS)[number];

/**
 * Menos es mejor (cartera, backlog, silencios) o más es mejor (cumplimiento).
 *
 * Vive en la métrica y se COPIA a la meta y otra vez a cada lectura. Sin esa
 * segunda copia, cambiar una métrica de dirección reescribiría el veredicto de
 * todos los períodos ya juzgados — que es exactamente el recálculo de historia
 * que este módulo existe para no hacer.
 */
export const METRIC_DIRECTIONS = ['lower_is_better', 'higher_is_better'] as const;
export type MetricDirection = (typeof METRIC_DIRECTIONS)[number];

export const UNIT_LABEL: Record<MetricUnit, string> = {
  percent: '%',
  days: 'días',
  count: '',
};

export const DIRECTION_LABEL: Record<MetricDirection, string> = {
  lower_is_better: 'no pasar de',
  higher_is_better: 'al menos',
};

/** Lo mismo, ya redactado, para la pantalla y para el correo. */
export function describeTarget(
  direction: MetricDirection,
  target: number,
  unit: MetricUnit,
): string {
  return `${DIRECTION_LABEL[direction]} ${formatValue(target, unit)}`;
}

/**
 * El número, listo para leerse en Colombia.
 *
 * Se formatea AL ESCRIBIR la lectura y se guarda formateado (columna `display`
 * de la 0101). Formatear al leer significaría que una fila congelada puede
 * cambiar de cifra el día que cambie una regla de locale.
 */
export function formatValue(value: number, unit: MetricUnit): string {
  const rounded = Math.round(value * 10) / 10;
  const text = rounded.toLocaleString('es-CO', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  });
  if (unit === 'percent') return `${text}%`;
  if (unit === 'days') return `${text} d`;
  return text;
}

// ---------------------------------------------------------------------------
// El veredicto
// ---------------------------------------------------------------------------

export const READING_STATUSES = ['met', 'breached', 'unmeasurable'] as const;
export type ReadingStatus = (typeof READING_STATUSES)[number];

export const STATUS_LABEL: Record<ReadingStatus, string> = {
  met: 'Cumplida',
  breached: 'Incumplida',
  unmeasurable: 'Sin datos',
};

export const STATUS_TONE: Record<ReadingStatus, 'emerald' | 'rose' | 'neutral'> = {
  met: 'emerald',
  breached: 'rose',
  unmeasurable: 'neutral',
};

/**
 * Cumplió o no cumplió. Un cruce de umbral y nada más.
 *
 * `value` nulo es «no había nada que medir en este período», que no es un
 * incumplimiento: es un hueco, y tratarlo como incumplimiento mandaría un
 * correo de alarma por un mes en el que la empresa no hizo nada medible.
 *
 * La comparación es inclusiva en el umbral a propósito. «No pasar de 45 días»
 * con 45 días exactos cumple; quien fija un límite lo fija como límite, no como
 * frontera abierta, y discutir 45,0 contra 45,000001 en un producto que reporta
 * a un decimal sería inventarse una precisión que la cifra no tiene.
 */
export function judge(
  value: number | null,
  target: number,
  direction: MetricDirection,
): ReadingStatus {
  if (value == null || !Number.isFinite(value)) return 'unmeasurable';
  const met = direction === 'lower_is_better' ? value <= target : value >= target;
  return met ? 'met' : 'breached';
}

// ---------------------------------------------------------------------------
// Períodos, en días colombianos
// ---------------------------------------------------------------------------

export const CADENCES = ['week', 'month'] as const;
export type Cadence = (typeof CADENCES)[number];

export const CADENCE_LABEL: Record<Cadence, string> = {
  week: 'Semanal',
  month: 'Mensual',
};

export interface Period {
  cadence: Cadence;
  /** Primer día del período, `YYYY-MM-DD`. Es la clave de la lectura. */
  start: string;
  /** Último día del período, inclusive. */
  end: string;
  /** Cómo se llama en una lista: «julio de 2026», «semana del 3 de agosto». */
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

const DAY_MS = 86_400_000;

function shift(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Lunes de la semana en la que cae `date`. La semana laboral empieza el lunes. */
function mondayOf(date: string): string {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = domingo
  return shift(date, weekday === 0 ? -6 : 1 - weekday);
}

function labelFor(cadence: Cadence, start: string): string {
  const [year, month, day] = start.split('-').map(Number) as [number, number, number];
  if (cadence === 'month') return `${MONTHS[month - 1]} de ${year}`;
  return `semana del ${day} de ${MONTHS[month - 1]}`;
}

function periodFrom(cadence: Cadence, start: string): Period {
  const end =
    cadence === 'week'
      ? shift(start, 6)
      : (() => {
          const [y, m] = start.split('-').map(Number) as [number, number];
          return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
        })();
  return { cadence, start, end, label: labelFor(cadence, start) };
}

/** El período en el que cae `date`, esté cerrado o no. */
export function periodContaining(cadence: Cadence, date: string): Period {
  const start = cadence === 'week' ? mondayOf(date) : `${date.slice(0, 7)}-01`;
  return periodFrom(cadence, start);
}

/**
 * EL ÚLTIMO PERÍODO QUE YA CERRÓ. Lo único que se congela.
 *
 * Una lectura de un período en curso cambiaría cada mañana, y una fila que
 * cambia cada mañana es el marcador que la 0101 existe para no ser. Así que el
 * cron sólo escribe períodos terminados, y la pantalla que quiere enseñar cómo
 * va el mes calcula el período en curso EN VIVO y lo marca como tal — sin
 * guardarlo nunca.
 */
export function lastClosedPeriod(cadence: Cadence, today: string = bogotaToday()): Period {
  const current = periodContaining(cadence, today);
  const previousDay = shift(current.start, -1);
  return periodContaining(cadence, previousDay);
}

/** El período anterior a uno dado. Lo usa el aviso de recuperación. */
export function previousPeriod(period: Period): Period {
  return periodContaining(period.cadence, shift(period.start, -1));
}

/** Instante en UTC del primer momento de un día colombiano (UTC-5, fijo). */
export function bogotaDayStart(date: string): string {
  return `${date}T05:00:00.000Z`;
}

/** Instante en UTC del primer momento del día SIGUIENTE a uno colombiano. */
export function bogotaDayAfter(date: string): string {
  return bogotaDayStart(shift(date, 1));
}

/** ¿Cae este día de calendario dentro del período? Ambos extremos incluidos. */
export function withinPeriod(period: Period, day: string): boolean {
  return day >= period.start && day <= period.end;
}

export { bogotaToday, daysBetween };
