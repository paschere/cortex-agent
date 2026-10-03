import { colombianHolidays } from '../../management/follow-up';

/**
 * FECHAS DE NÓMINA: el mes comercial de 30 días y los días hábiles.
 *
 * La nómina colombiana cuenta en meses de 30 días (art. 134 CST y la práctica
 * de todos los liquidadores): un mes completo son 30 días aunque tenga 28 o
 * 31, una quincena son 15. `days360` es esa cuenta, incluyendo los dos
 * extremos. Las vacaciones se cuentan en días HÁBILES (art. 186 CST), sin
 * domingos ni festivos; el sábado es hábil salvo que la empresa no trabaje
 * sábados (lo dice su configuración).
 */

function parts(day: string): [number, number, number] {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return [y, m, d];
}

function isLastDayOfFeb(y: number, m: number, d: number): boolean {
  if (m !== 2) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return d === (leap ? 29 : 28);
}

/** Días comerciales entre dos fechas, INCLUIDAS las dos (1-ene a 30-ene = 30). */
export function days360(from: string, to: string): number {
  if (to < from) return 0;
  const [y1, m1, d1raw] = parts(from);
  const [y2, m2, d2raw] = parts(to);
  const d1 = Math.min(d1raw, 30);
  // El último día del mes (31, o fin de febrero) cuenta como el 30.
  const d2 = d2raw === 31 || isLastDayOfFeb(y2, m2, d2raw) ? 30 : Math.min(d2raw, 30);
  return (y2 - y1) * 360 + (m2 - m1) * 30 + (d2 - d1) + 1;
}

export function addDaysIso(day: string, n: number): string {
  const t = new Date(`${day}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** Días calendario entre dos fechas, incluidas las dos. */
export function calendarDays(from: string, to: string): number {
  if (to < from) return 0;
  return (
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
  );
}

export function maxDay(a: string, b: string): string {
  return a > b ? a : b;
}
export function minDay(a: string, b: string): string {
  return a < b ? a : b;
}

/** ¿Es hábil para vacaciones? Domingos y festivos nacionales no lo son. */
export function isPayrollBusinessDay(day: string, opts: { saturdayIsWorkday: boolean }): boolean {
  const t = new Date(`${day}T00:00:00Z`);
  const dow = t.getUTCDay();
  if (dow === 0) return false;
  if (dow === 6 && !opts.saturdayIsWorkday) return false;
  return !colombianHolidays(t.getUTCFullYear()).has(day);
}

/** Domingo o festivo nacional: el día que lleva recargo dominical/festivo. */
export function isSundayOrHoliday(day: string): boolean {
  const t = new Date(`${day}T00:00:00Z`);
  return t.getUTCDay() === 0 || colombianHolidays(t.getUTCFullYear()).has(day);
}

/** Días hábiles entre dos fechas, incluidas. */
export function businessDaysBetween(
  from: string,
  to: string,
  opts: { saturdayIsWorkday: boolean },
): number {
  let n = 0;
  for (let d = from; d <= to; d = addDaysIso(d, 1)) if (isPayrollBusinessDay(d, opts)) n++;
  return n;
}

/**
 * El último día de unas vacaciones de `businessDays` hábiles que empiezan el
 * `start` (si `start` no es hábil, empiezan el siguiente hábil).
 */
export function vacationEnd(
  start: string,
  businessDays: number,
  opts: { saturdayIsWorkday: boolean },
): string {
  let left = Math.max(1, Math.ceil(businessDays));
  let d = start;
  for (let guard = 0; guard < 400; guard++) {
    if (isPayrollBusinessDay(d, opts)) {
      left--;
      if (left === 0) return d;
    }
    d = addDaysIso(d, 1);
  }
  return d;
}

/** Último día del mes de `day`. */
export function monthEnd(day: string): string {
  const [y, m] = parts(day);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** Los periodos de un mes según la frecuencia. */
export function periodsOfMonth(
  month: string,
  frequency: 'mensual' | 'quincenal',
): Array<{ start: string; end: string }> {
  const start = `${month}-01`;
  const end = monthEnd(start);
  if (frequency === 'mensual') return [{ start, end }];
  return [
    { start, end: `${month}-15` },
    { start: `${month}-16`, end },
  ];
}
