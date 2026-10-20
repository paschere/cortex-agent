import { todayIn } from '../../views/compute';

/**
 * RANGOS DE FECHAS RELATIVOS DE UN REPORTE, EN HORA DE BOGOTÁ.
 *
 * «La semana pasada» es lunes a domingo de la semana anterior a la de hoy
 * (según el calendario de Bogotá, UTC-5 fijo: el servidor puede estar en otra
 * zona y a las 7 de la mañana del lunes en Bogotá ya es lunes y no domingo en
 * UTC). Puro: recibe «ahora» y devuelve días AAAA-MM-DD, ambos extremos
 * incluidos.
 */

export const RANGE_PRESETS = [
  'today',
  'yesterday',
  'this_week',
  'last_week',
  'last_7_days',
  'this_month',
  'last_month',
  'last_30_days',
  'this_year',
  'all',
] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

export const RANGE_PRESET_LABEL: Record<RangePreset, string> = {
  today: 'Hoy',
  yesterday: 'Ayer',
  this_week: 'Esta semana',
  last_week: 'La semana pasada',
  last_7_days: 'Los últimos 7 días',
  this_month: 'El mes en curso',
  last_month: 'El mes pasado',
  last_30_days: 'Los últimos 30 días',
  this_year: 'El año en curso',
  all: 'Todo el historial',
};

export interface DayRange {
  /** Primer día incluido (AAAA-MM-DD) o null = sin límite. */
  from: string | null;
  /** Último día incluido (AAAA-MM-DD) o null = sin límite. */
  to: string | null;
  label: string;
}

export function addDaysIso(day: string, days: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 1 = lunes … 7 = domingo. */
export function isoWeekday(day: string): number {
  return ((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
}

function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

function monthEnd(day: string): string {
  const [y = 1970, m = 1] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0, 12)).toISOString().slice(0, 10);
}

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function short(day: string): string {
  const [y, m, d] = day.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1] ?? m} ${y}`;
}

/** «12 al 18 oct 2026», «28 sep al 4 oct 2026» o «1 dic 2026 al 3 ene 2027». */
export function rangeText(from: string | null, to: string | null): string {
  if (!from && !to) return 'todo el historial';
  if (from && !to) return `desde el ${short(from)}`;
  if (!from && to) return `hasta el ${short(to)}`;
  const a = from as string;
  const b = to as string;
  if (a === b) return short(a);
  const [ay, am, ad] = a.split('-');
  const [by, bm, bd] = b.split('-');
  if (ay === by && am === bm) return `${Number(ad)} al ${Number(bd)} ${MONTHS[Number(bm) - 1]} ${by}`;
  if (ay === by)
    return `${Number(ad)} ${MONTHS[Number(am) - 1]} al ${Number(bd)} ${MONTHS[Number(bm) - 1]} ${by}`;
  return `${short(a)} al ${short(b)}`;
}

export function resolveRange(preset: RangePreset, now: Date): DayRange {
  const today = todayIn(now);
  let from: string | null = null;
  let to: string | null = null;
  switch (preset) {
    case 'today':
      from = to = today;
      break;
    case 'yesterday':
      from = to = addDaysIso(today, -1);
      break;
    case 'this_week': {
      from = addDaysIso(today, -(isoWeekday(today) - 1));
      to = addDaysIso(from, 6);
      break;
    }
    case 'last_week': {
      const thisMonday = addDaysIso(today, -(isoWeekday(today) - 1));
      from = addDaysIso(thisMonday, -7);
      to = addDaysIso(thisMonday, -1);
      break;
    }
    case 'last_7_days':
      from = addDaysIso(today, -6);
      to = today;
      break;
    case 'this_month':
      from = monthStart(today);
      to = monthEnd(today);
      break;
    case 'last_month': {
      const lastDayPrev = addDaysIso(monthStart(today), -1);
      from = monthStart(lastDayPrev);
      to = lastDayPrev;
      break;
    }
    case 'last_30_days':
      from = addDaysIso(today, -29);
      to = today;
      break;
    case 'this_year':
      from = `${today.slice(0, 4)}-01-01`;
      to = `${today.slice(0, 4)}-12-31`;
      break;
    case 'all':
      break;
  }
  return {
    from,
    to,
    label: preset === 'all' ? RANGE_PRESET_LABEL.all : `${RANGE_PRESET_LABEL[preset]} (${rangeText(from, to)})`,
  };
}

/** El día de Bogotá de un valor de fecha (AAAA-MM-DD, o una marca de tiempo ISO). */
export function bogotaDayOf(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : todayIn(new Date(t));
}

export function inRange(day: string | null, range: Pick<DayRange, 'from' | 'to'>): boolean {
  if (!range.from && !range.to) return true;
  if (!day) return false;
  if (range.from && day < range.from) return false;
  if (range.to && day > range.to) return false;
  return true;
}
