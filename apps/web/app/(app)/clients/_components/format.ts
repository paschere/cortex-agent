/**
 * How dates and figures read on the client screens.
 *
 * Spanish (Colombia) throughout. A `YYYY-MM-DD` deadline is formatted from its
 * STRING and never through a `Date`: parsing "2026-09-14" into a Date and
 * formatting it back is how a deadline shows up as the 13th for anybody whose
 * browser sits west of Bogotá. A timestamp — when a mail arrived, when somebody
 * vouched for a domain — is a real instant and is formatted in Bogotá time.
 */

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

/** "14 sep 2026" — from a calendar date, without ever building a Date. */
export function shortDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return iso;
  return `${d} ${MONTHS_SHORT[Number(m) - 1] ?? m} ${y}`;
}

/** "04 ago 10:18" — for a moment. Used on provenance chips. */
export function stamp(isoTimestamp: string | null | undefined): string | null {
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

/** "14 sep 2026" — for a moment, when the hour is noise. */
export function dayOf(isoTimestamp: string | null | undefined): string | null {
  if (!isoTimestamp) return null;
  const iso = isoTimestamp.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? shortDate(iso) : null;
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

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
