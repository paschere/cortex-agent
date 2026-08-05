/**
 * How dates and figures read on this screen.
 *
 * Spanish (Colombia) throughout, and every date is formatted from its
 * `YYYY-MM-DD` string rather than through a `Date`. Parsing "2026-09-14" into a
 * Date and formatting it back is how a deadline shows up as the 13th for
 * anybody whose browser is west of Bogotá — the exact bug migration 0069 stores
 * a `date` column to avoid, reintroduced in the last three lines of the stack.
 */

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

const MONTHS_SHORT = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic',
];

/** "14 de septiembre de 2026" */
export function longDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return iso;
  return `${Number(d)} de ${MONTHS[Number(m) - 1] ?? m} de ${y}`;
}

/** "14 sep 2026" — the compact form for a row of cards. */
export function shortDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return iso;
  return `${d} ${MONTHS_SHORT[Number(m) - 1] ?? m} ${y}`;
}

/** "04 ago 10:18" — for a moment, not a deadline. Used on provenance chips. */
export function stamp(isoTimestamp: string | null): string | null {
  if (!isoTimestamp) return null;
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return isoTimestamp.slice(0, 10);
  try {
    const parts = new Intl.DateTimeFormat('es-CO', {
      timeZone: 'America/Bogota',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(date);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    return `${get('day')} ${get('month').replace('.', '')} ${get('hour')}:${get('minute')}`;
  } catch {
    return isoTimestamp.slice(0, 10);
  }
}

/** "en 12 días" / "hoy" / "hace 3 días" */
export function whenPhrase(daysLeft: number): string {
  if (daysLeft === 0) return 'hoy';
  if (daysLeft === 1) return 'mañana';
  if (daysLeft === -1) return 'ayer';
  if (daysLeft > 0) return `en ${daysLeft} días`;
  return `hace ${-daysLeft} días`;
}

export function cop(amount: number): string {
  return `$${Math.round(amount).toLocaleString('es-CO')}`;
}
