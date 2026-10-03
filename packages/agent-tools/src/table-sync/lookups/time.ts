import { dayOfCell } from '../../views/feed-sources';

/**
 * EL RELOJ DE BOGOTÁ, SIN LIBRERÍAS.
 *
 * Colombia no tiene horario de verano: Bogotá es UTC-5 todo el año. Eso permite
 * hacer la aritmética de días y horas a mano, sin `Intl` en el camino caliente,
 * y que «el día de hoy» y «las 00:00» signifiquen lo mismo en el servidor, en
 * las pruebas y en la grilla.
 */

export const BOGOTA_OFFSET_MS = 5 * 3_600_000;
export const MINUTE = 60_000;

/** El día (AAAA-MM-DD) en Bogotá de un instante. */
export function bogotaDay(ms: number): string {
  return new Date(ms - BOGOTA_OFFSET_MS).toISOString().slice(0, 10);
}

/** El instante en que EMPIEZA ese día en Bogotá (00:00 hora de Bogotá). */
export function bogotaDayStart(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) + BOGOTA_OFFSET_MS;
}

/** Suma días a un AAAA-MM-DD. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + n)).toISOString().slice(0, 10);
}

const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Un valor de celda como instante. Lo que no trae zona («2026-09-25 10:05») es
 * hora de Bogotá —así guarda las horas la sincronización—; una fecha sola es
 * medianoche de Bogotá; «2026-09-25T15:05:00Z» y las zonas con desfase se
 * respetan. Lo que no se entiende da `null` (nunca se adivina).
 */
export function parseMoment(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 1e11 ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  const m = DATE_TIME.exec(text);
  if (!m) {
    const day = dayOfCell(text);
    return day ? bogotaDayStart(day) : null;
  }
  const [, y, mo, d, hh, mi, ss, zone] = m;
  const parts = [y, mo, d, hh ?? '00', mi ?? '00', ss ?? '00'].map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (parts[1] < 1 || parts[1] > 12 || parts[2] < 1 || parts[2] > 31) return null;
  if (parts[3] > 23 || parts[4] > 59 || parts[5] > 59) return null;
  const local = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]);
  // Un 31 de febrero se desborda a marzo: lo descartamos.
  if (new Date(local).getUTCDate() !== parts[2]) return null;
  if (!zone) return local + BOGOTA_OFFSET_MS;
  if (zone === 'Z') return local;
  const sign = zone.startsWith('-') ? -1 : 1;
  const digits = zone.slice(1).replace(':', '');
  const offset = (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))) * MINUTE;
  return local - sign * offset;
}

/** El día (AAAA-MM-DD, Bogotá) que dice un valor, o null. */
export function dayOfValue(value: unknown): string | null {
  const ms = parseMoment(value);
  return ms === null ? null : bogotaDay(ms);
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** Formatos que son de fecha/hora (llevan alguna de estas fichas). */
export function isDateFormat(format: string): boolean {
  return /^(iso|unix|unixms)$/i.test(format) || /(YYYY|MM|DD|HH|mm|ss)/.test(format);
}

/**
 * Un instante con el formato pedido, en hora de Bogotá. Fichas: YYYY MM DD HH
 * mm ss. Aparte: `iso` (UTC, «2026-09-25T15:05:00.000Z»), `unix` (segundos) y
 * `unixms`.
 */
export function formatMoment(ms: number, format: string): string {
  if (/^iso$/i.test(format)) return new Date(ms).toISOString();
  if (/^unix$/i.test(format)) return String(Math.floor(ms / 1000));
  if (/^unixms$/i.test(format)) return String(ms);
  const local = new Date(ms - BOGOTA_OFFSET_MS);
  const fields: Record<string, string> = {
    YYYY: pad(local.getUTCFullYear(), 4),
    MM: pad(local.getUTCMonth() + 1),
    DD: pad(local.getUTCDate()),
    HH: pad(local.getUTCHours()),
    mm: pad(local.getUTCMinutes()),
    ss: pad(local.getUTCSeconds()),
  };
  return format.replace(/YYYY|MM|DD|HH|mm|ss/g, (token) => fields[token] ?? token);
}
