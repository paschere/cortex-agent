/**
 * Dates on the reports screens, in Colombian Spanish.
 *
 * Deliberately a small local copy rather than an import from
 * `@cortex/agent-tools`: this module is imported by the list page today and by
 * a client component tomorrow, and the barrel pulls `node:dns` into any bundle
 * that touches it. Same reasoning as `lib/reports-shape.ts` and
 * `lib/commitments-shape.ts`.
 *
 * Calendar dates are formatted from their `YYYY-MM-DD` string, never through a
 * `Date` — parsing "2026-09-14" and formatting it back is how a date shows up
 * as the 13th for anybody west of Bogotá.
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

/** "14 de septiembre de 2026" */
export function longDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return iso;
  return `${Number(d)} de ${MONTHS[Number(m) - 1] ?? m} de ${y}`;
}

/** "Agosto de 2026" — the heading over a month's worth of saved reports. */
export function monthHeading(ym: string): string {
  const [y, m] = ym.split('-');
  const name = MONTHS[Number(m) - 1];
  if (!y || !name) return ym;
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} de ${y}`;
}

/** "04 ago 2026, 10:18" — a moment, in Bogotá, for the "calculado" stamp. */
export function stamp(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return isoTimestamp.slice(0, 10);
  try {
    const parts = new Intl.DateTimeFormat('es-CO', {
      timeZone: 'America/Bogota',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(date);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    return `${get('day')} ${get('month').replace('.', '')} ${get('year')}, ${get('hour')}:${get('minute')}`;
  } catch {
    return isoTimestamp.slice(0, 16).replace('T', ' ');
  }
}
