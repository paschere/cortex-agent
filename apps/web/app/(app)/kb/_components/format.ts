/**
 * Figures, dates and durations as this page prints them.
 *
 * Colombian Spanish and Colombian separators: 1.284, not 1,284. Everything here
 * is pure and client-safe — the numbers themselves come from `_lib/brain.ts`,
 * this file only decides how they read.
 */

const LOCALE = 'es-CO';

/** A count, grouped: 1.284. */
export function num(value: number): string {
  return value.toLocaleString(LOCALE);
}

/** Hours of audio: "48 min" under the hour, "12,4 h" over it. */
export function hours(seconds: number): string {
  if (seconds <= 0) return '0 h';
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min`;
  const h = seconds / 3600;
  return `${h.toLocaleString(LOCALE, { maximumFractionDigits: 1 })} h`;
}

/** A recording's length as a clock reads it: 12:03. */
export function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** How long ago, in words: "hace 3 min", "hace 2 h", "12 mar". */
export function ago(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const minutes = Math.floor((Date.now() - then) / 60_000);
  if (minutes < 1) return 'hace un momento';
  if (minutes < 60) return `hace ${minutes} min`;
  const h = Math.floor(minutes / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `hace ${d} d`;
  return shortDate(iso);
}

/** "12 mar 2026" — the date an answer would cite. */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(LOCALE, { day: '2-digit', month: 'short', year: 'numeric' });
}

/** "mar 12 mar, 2:00 p. m." — a meeting, with the hour it happened. */
export function meetingMoment(iso: string | null): string {
  if (!iso) return 'sin fecha';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'sin fecha';
  return d.toLocaleDateString(LOCALE, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** "1 documento" / "5 documentos", without the (s) that reads like a form. */
export function plural(count: number, one: string, many: string): string {
  return `${num(count)} ${count === 1 ? one : many}`;
}
