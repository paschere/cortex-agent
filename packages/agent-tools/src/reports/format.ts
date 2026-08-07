/**
 * How a report says a number or a date, in Colombian Spanish.
 *
 * Every one of these runs at BUILD time, never at render time. A saved report
 * stores the formatted string alongside the raw number, so the figure on the
 * page cannot change because a locale table, a rounding rule or a browser
 * changed underneath it six weeks later. That is the same reasoning as storing
 * the resolved document rather than the query — the snapshot is only a snapshot
 * if nothing downstream is still deciding things.
 *
 * Dates are formatted from their `YYYY-MM-DD` string and never through a
 * `Date`. Parsing "2026-09-14" into a Date and formatting it back is how a
 * deadline shows up as the 13th for anyone west of Bogotá; migration 0069
 * stores a `date` column precisely to avoid that, and it would be a shame to
 * reintroduce it in the last three lines of the stack.
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

/** "14 sep 2026" */
export function shortDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return iso;
  return `${d} ${MONTHS_SHORT[Number(m) - 1] ?? m} ${y}`;
}

/** "sep 26" — the axis label for a month bucket, from a `YYYY-MM` key. */
export function monthTick(ym: string): string {
  const [y, m] = ym.split('-');
  if (!y || !m) return ym;
  return `${MONTHS_SHORT[Number(m) - 1] ?? m} ${y.slice(2)}`;
}

/** "agosto de 2026" — how the period of a report is named on its own header. */
export function monthLabel(ym: string): string {
  const [y, m] = ym.split('-');
  if (!y || !m) return ym;
  return `${MONTHS[Number(m) - 1] ?? m} de ${y}`;
}

/** "04 ago 2026, 10:18" — a moment, not a deadline. Used on the source ledger. */
export function stamp(isoTimestamp: string, timeZone = 'America/Bogota'): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return isoTimestamp.slice(0, 10);
  try {
    const parts = new Intl.DateTimeFormat('es-CO', {
      timeZone,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(date);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    const month = get('month').replace('.', '');
    return `${get('day')} ${month} ${get('year')}, ${get('hour')}:${get('minute')}`;
  } catch {
    return isoTimestamp.slice(0, 16).replace('T', ' ');
  }
}

/** Colombian pesos: "$1.240.000". Thousands with dots, no decimals. */
export function cop(amount: number): string {
  return `$${Math.round(amount).toLocaleString('es-CO')}`;
}

/** A plain count, grouped the Colombian way: "1.240". */
export function count(n: number): string {
  return Math.round(n).toLocaleString('es-CO');
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${count(n)} ${n === 1 ? one : many}`;
}

/** "en 4 días" / "hace 12 días" / "hoy" — how a person would say it. */
export function whenPhrase(daysLeft: number): string {
  if (daysLeft === 0) return 'hoy';
  if (daysLeft === 1) return 'mañana';
  if (daysLeft === -1) return 'ayer';
  if (daysLeft > 0) return `en ${plural(daysLeft, 'día')}`;
  return `hace ${plural(-daysLeft, 'día')}`;
}

/** Percentage of a whole, to one decimal only when it needs one. */
export function share(part: number, whole: number): string {
  if (whole <= 0) return '0 %';
  const pct = (part / whole) * 100;
  const rounded = pct >= 10 || pct === 0 ? Math.round(pct) : Math.round(pct * 10) / 10;
  return `${rounded.toLocaleString('es-CO')} %`;
}

/** Trim a label so a chart axis stays readable, without cutting mid-word ugly. */
export function clip(text: string, max: number): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}
