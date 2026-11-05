/**
 * Formato de cifras para Colombia. Pesos con separador de miles y SIN abreviar
 * (solo desde mil millones se escribe «mil millones»). Kilos con es-CO.
 * Horas y fechas siempre en America/Bogota.
 */

export const TZ = 'America/Bogota';

/** Número desde cualquier valor (acepta «1.234,5» y «1234.5»). */
export function N(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v !== 'string' || !v.trim()) return 0;
  let s = v.trim().replace(/[^\d,.\-]/g, '');
  if (s.includes(',') && s.includes('.')) {
    s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (s.includes(',')) {
    s = /,\d{3}(,|$)/.test(s) && !/,\d{1,2}$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if ((s.match(/\./g) ?? []).length > 1) {
    s = s.replace(/\./g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/** ¿El valor trae algo? (0 sí cuenta). */
export const hay = (v: unknown): boolean => v !== null && v !== undefined && v !== '';

export function num(n: number, dec = 0): string {
  return new Intl.NumberFormat('es-CO', { maximumFractionDigits: dec, minimumFractionDigits: 0 }).format(n);
}

/** Pesos colombianos completos: $ 1.234.567. Solo ≥ mil millones se abrevia. */
export function cop(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${n < 0 ? '-' : ''}$ ${num(abs / 1_000_000_000, 2)} mil millones`;
  return `${n < 0 ? '-' : ''}$ ${num(Math.round(abs))}`;
}

export function usd(n: number): string {
  return `US$ ${num(n, 2)}`;
}

export function dinero(n: number, moneda: string): string {
  return moneda === 'USD' ? usd(n) : cop(n);
}

export function kg(n: number): string {
  return `${num(n, 1)} kg`;
}

/** Diferencia con signo: +12,5 / -3 / 0. */
export function conSigno(n: number, dec = 1): string {
  if (!n) return '0';
  return `${n > 0 ? '+' : '-'}${num(Math.abs(n), dec)}`;
}

export function pct(n: number, dec = 1): string {
  return `${num(n, dec)} %`;
}

/** HH:MM (24 h) desde «14:05», «14:05:33» o un ISO con zona. */
export function hhmm(v: unknown): string {
  if (!hay(v)) return '';
  const s = String(v);
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s.trim());
  if (m) return `${m[1]?.padStart(2, '0')}:${m[2]}`;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return s;
  return new Intl.DateTimeFormat('es-CO', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(t);
}

/** «mié 5 nov» desde AAAA-MM-DD (o un ISO). */
export function fechaCorta(v: unknown): string {
  if (!hay(v)) return '';
  const s = String(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return String(v);
  const d = new Date(`${s}T12:00:00Z`);
  return new Intl.DateTimeFormat('es-CO', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' })
    .format(d)
    .replace(/\./g, '');
}

/** «miércoles 5 de noviembre» */
export function fechaLarga(v: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return new Intl.DateTimeFormat('es-CO', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(
    new Date(`${v}T12:00:00Z`),
  );
}

/** Fecha y hora de un ISO en Bogotá. */
export function fechaHora(v: unknown): string {
  if (!hay(v)) return '';
  const t = Date.parse(String(v));
  if (Number.isNaN(t)) return String(v);
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: TZ,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .format(t)
    .replace(/\./g, '');
}

/** 95 → «1 h 35 min». */
export function minTxt(min: number | null | undefined): string {
  if (min === null || min === undefined || Number.isNaN(min)) return '—';
  const m = Math.round(Math.abs(min));
  const t = m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
  return min < 0 ? `-${t}` : t;
}

/** Segundos → HH:MM:SS para el cronómetro. */
export function cronometro(seg: number): string {
  const s = Math.max(0, Math.floor(seg));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Promedio ignorando vacíos; null si no hay datos. */
export function promedio(xs: (number | null)[]): number | null {
  const v = xs.filter((x): x is number => x !== null && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
