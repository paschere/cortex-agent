/**
 * Formatos de las pantallas de estados, presupuesto e informe para socios
 * (0191). Puro y sin `@cortex/agent-tools`: lo importan componentes de
 * cliente.
 */

const FULL = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});
const ONE = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 1 });
const TWO = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 2 });
const WHOLE = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });

/** «$ 12.345.678». */
export function fullMoney(n: number): string {
  return FULL.format(Math.round(n)).replace(/ /g, ' ');
}

/** «$ 38,5 M», «$ 950 mil». */
export function shortMoney(n: number): string {
  const sign = n < 0 ? '−' : '';
  const a = Math.abs(Math.round(n));
  if (a >= 1e9) return `${sign}$ ${TWO.format(a / 1e9)} mil M`;
  if (a >= 1e6) return `${sign}$ ${ONE.format(a / 1e6)} M`;
  if (a >= 1e3) return `${sign}$ ${WHOLE.format(a / 1e3)} mil`;
  return `${sign}$ ${WHOLE.format(a)}`;
}

export function pct(fraction: number | null | undefined, signed = false): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return '—';
  const v = fraction * 100;
  return `${signed && v > 0 ? '+' : ''}${ONE.format(v)} %`;
}

export function change(now: number, before: number | null | undefined): number | null {
  if (before === null || before === undefined || Math.abs(before) < 0.5) return null;
  return (now - before) / Math.abs(before);
}

export const MONTHS = [
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
export const MONTHS_SHORT = [
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

export const monthName = (m: number) => MONTHS[m - 1] ?? '';
export const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** «2026-09» → «sep 26». */
export function shortMonthKey(key: string): string {
  return `${MONTHS_SHORT[Number(key.slice(5, 7)) - 1] ?? ''} ${key.slice(2, 4)}`;
}

/** «2026-10-03T…» → «3 oct 2026». */
export function shortDay(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = iso.slice(0, 10);
  return `${Number(d.slice(8, 10))} ${MONTHS_SHORT[Number(d.slice(5, 7)) - 1] ?? ''} ${d.slice(0, 4)}`;
}
