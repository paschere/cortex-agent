/**
 * LO QUE COMPARTEN LA PROYECCIÓN, LOS RECURRENTES Y EL COMPORTAMIENTO.
 *
 * Todo puro y determinista: fechas como `YYYY-MM-DD` de Bogotá contadas en días
 * enteros (Bogotá es UTC−5 todo el año, sin horario de verano, así que un día
 * es siempre un día), cifras redactadas para leerse en Colombia y la forma de
 * reconocer a la misma contraparte aunque una fuente traiga el NIT y otra sólo
 * el nombre.
 *
 * Los meses se escriben a mano («3 nov», «12 sep») y no con `Intl`: según la
 * versión de ICU, septiembre sale «sep.» o «sept.», y un texto que cambia con
 * la versión de Node rompe el determinismo que prometen las pruebas.
 */

import { LEDGER_CATEGORIES, type LedgerDirection } from './types';

const DAY_MS = 86_400_000;
const BOGOTA_OFFSET_MS = 5 * 3_600_000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// Fechas
// ---------------------------------------------------------------------------

/**
 * El día de Bogotá de una fecha. `YYYY-MM-DD` pasa igual; un instante con zona
 * (`…Z`, `…-05:00`) se lleva a Bogotá; un instante sin zona se toma como hora
 * local de Bogotá (se corta el día).
 */
export function toDay(value: string): string {
  const trimmed = value.trim();
  if (ISO_DAY.test(trimmed)) return trimmed;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    const t = Date.parse(trimmed);
    if (!Number.isNaN(t)) return new Date(t - BOGOTA_OFFSET_MS).toISOString().slice(0, 10);
  }
  return trimmed.slice(0, 10);
}

/** Días desde 1970-01-01 (UTC) de un `YYYY-MM-DD`. */
export function dayNumber(day: string): number {
  return Math.round(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
}

export function fromDayNumber(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(day: string, days: number): string {
  return fromDayNumber(dayNumber(day) + days);
}

/** Días enteros de `from` a `to`. Negativo: `to` es antes. */
export function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

/** 1 = lunes … 7 = domingo. */
export function isoWeekday(day: string): number {
  const dow = new Date(dayNumber(day) * DAY_MS).getUTCDay();
  return dow === 0 ? 7 : dow;
}

/** El lunes de la semana del día. */
export function mondayOf(day: string): string {
  return addDays(day, 1 - isoWeekday(day));
}

export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/** El día `anchor` del mes, o el último si el mes es más corto (30 → 28 feb). */
export function dayOfMonth(year: number, month1: number, anchor: number): string {
  const d = Math.min(Math.max(1, Math.round(anchor)), daysInMonth(year, month1));
  return `${year}-${String(month1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Índice de mes continuo (año·12 + mes) para contar meses entre fechas. */
export function monthIndex(day: string): number {
  return Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1;
}

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const WEEKDAYS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];

/** «3 nov». */
export function formatDay(day: string): string {
  return `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1] ?? ''}`;
}

/** «lunes» para 1 … «domingo» para 7. */
export function weekdayName(n: number): string {
  return WEEKDAYS[(((Math.round(n) - 1) % 7) + 7) % 7] ?? 'lunes';
}

// ---------------------------------------------------------------------------
// Cifras
// ---------------------------------------------------------------------------

const ONE_DECIMAL = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 1 });
const WHOLE = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });

/**
 * Plata para leer de un vistazo. Pesos: «$ 38,5 M», «$ 950 mil», «−$ 3,2 M».
 * Otra moneda nunca se escribe con el signo del peso: «12.000 USD».
 */
export function formatMoney(value: number, currency = 'COP'): string {
  const sign = value < 0 ? '−' : '';
  const n = Math.abs(Math.round(value));
  if (currency.toUpperCase() !== 'COP')
    return `${sign}${WHOLE.format(n)} ${currency.toUpperCase()}`;
  if (n >= 1e9) return `${sign}$ ${ONE_DECIMAL.format(n / 1e9)} mil M`;
  if (n >= 1e6) return `${sign}$ ${ONE_DECIMAL.format(n / 1e6)} M`;
  if (n >= 1e3) return `${sign}$ ${WHOLE.format(n / 1e3)} mil`;
  return `${sign}$ ${WHOLE.format(n)}`;
}

/** «92%». */
export function formatPct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** «1 factura» / «6 facturas». */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** «a», «a y b», «a, b y c». */
export function joinEs(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} y ${parts[parts.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Nombres, contrapartes y categorías
// ---------------------------------------------------------------------------

const LEGAL_TOKENS = new Set(['sas', 'ltda', 'limitada', 'sa', 'esp', 'cia', 'bic', 'sca', 'eu']);

/** «Nexa Logística S.A.S.» → «nexa logistica». Sin tildes, sin forma jurídica. */
export function normalizeName(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/s\.\s*a\.\s*s\.?/g, ' sas ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length > 1 && !LEGAL_TOKENS.has(t))
    .join(' ')
    .trim();
}

/** El NIT sin dígito de verificación ni puntos: «901.234.567-1» → «901234567». */
export function normalizeTaxId(value: string | null | undefined): string {
  if (!value) return '';
  const base = value.split('-')[0] ?? '';
  const digits = base.replace(/\D/g, '');
  return digits.length >= 5 ? digits : '';
}

/**
 * Reconoce a la misma contraparte con NIT o sin él. Aprende de cada registro
 * que trae ambos (nombre → NIT) para que «Nexa» sin NIT caiga en el mismo
 * cajón que «NEXA LOGÍSTICA SAS · 901234567».
 */
export function makeKeyResolver(
  records: ReadonlyArray<{ name?: string | null; taxId?: string | null }>,
): (name?: string | null, taxId?: string | null) => string | null {
  const nameToNit = new Map<string, string>();
  for (const r of records) {
    const nit = normalizeTaxId(r.taxId);
    const name = normalizeName(r.name);
    if (nit && name && !nameToNit.has(name)) nameToNit.set(name, nit);
  }
  return (name, taxId) => {
    const nit = normalizeTaxId(taxId);
    if (nit) return `nit:${nit}`;
    const norm = normalizeName(name);
    if (!norm) return null;
    const known = nameToNit.get(norm);
    return known ? `nit:${known}` : `name:${norm}`;
  };
}

/**
 * ¿«Nexa» nombra a «Nexa Logística S.A.S.»? Sí si cada palabra de la consulta
 * está en el nombre (o es su NIT). Así un escenario dicho en el chat encuentra
 * a la contraparte sin exigir el nombre legal completo.
 */
export function nameMatches(
  query: string,
  name: string | null | undefined,
  taxId?: string | null,
): boolean {
  const qNit = normalizeTaxId(query);
  if (qNit && qNit === normalizeTaxId(taxId)) return true;
  const q = normalizeName(query).split(' ').filter(Boolean);
  if (q.length === 0) return false;
  const tokens = new Set(normalizeName(name).split(' ').filter(Boolean));
  return q.every((t) => tokens.has(t));
}

const CATEGORY_LABELS: Record<string, string> = {
  ventas: 'Ventas',
  otros_ingresos: 'Otros ingresos',
  nomina: 'Nómina',
  arriendo: 'Arriendo',
  servicios_publicos: 'Servicios públicos',
  transporte: 'Transporte',
  proveedores: 'Proveedores',
  impuestos: 'Impuestos',
  bancos_y_financieros: 'Bancos y financieros',
  software: 'Software',
  mercadeo: 'Mercadeo',
  mantenimiento: 'Mantenimiento',
  honorarios: 'Honorarios',
  otros_gastos: 'Otros gastos',
};

/** «servicios_publicos» → «Servicios públicos». Una categoría nueva se lee igual. */
export function categoryLabel(category: string): string {
  const known = CATEGORY_LABELS[category];
  if (known) return known;
  const words = category.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Igualdad de categorías tolerante: «nomina» = «Nómina» = «NÓMINA». */
export function categoryKey(category: string | null | undefined): string {
  if (!category) return '';
  const norm = normalizeName(category.replace(/_/g, ' '));
  for (const c of LEDGER_CATEGORIES) {
    if (normalizeName(c.replace(/_/g, ' ')) === norm) return c;
    if (normalizeName(CATEGORY_LABELS[c]) === norm) return c;
  }
  return norm;
}

const MONTH_WORDS = new Set([
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'setiembre',
  'octubre',
  'noviembre',
  'diciembre',
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'sept',
  'oct',
  'nov',
  'dic',
]);
const FILLER_WORDS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'mes', 'para', 'por', 'en']);

/**
 * La «firma» de una descripción para agrupar lo que se repite sin contraparte:
 * «Pago nómina quincena 2 sept 2026» y «Pago nómina quincena 1 octubre» dan lo
 * mismo. Sin números, sin meses, sin palabras de relleno; las tres primeras.
 */
export function descriptionSignature(description: string | null | undefined): string {
  return normalizeName(description)
    .split(' ')
    .filter((t) => t && !/\d/.test(t) && !MONTH_WORDS.has(t) && !FILLER_WORDS.has(t))
    .slice(0, 3)
    .join(' ');
}

/** La descripción para mostrar, sin el mes ni el año que cambian cada vez. */
export function cleanDescription(description: string): string {
  const words = description
    .split(/\s+/)
    .filter((w) => {
      const n = normalizeName(w);
      return n === '' ? /[a-zA-Z]/.test(w) : !/^\d+$/.test(n) && !MONTH_WORDS.has(n);
    })
    .join(' ')
    .replace(/[\s\-–·,:/]+$/, '')
    .trim();
  const text = words || description.trim();
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

/** Hash corto y estable (FNV-1a) para ids deterministas. */
export function stableHash(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// ---------------------------------------------------------------------------
// La línea en borrador
// ---------------------------------------------------------------------------

/**
 * Una línea de la proyección antes de redondear y de caer en su semana. Lleva
 * lo que el escenario necesita para encontrarla (contraparte, categoría) y de
 * dónde salió.
 */
export interface DraftItem {
  label: string;
  direction: LedgerDirection;
  amount: number;
  probability: number;
  expectedDate: string;
  reason: string;
  from: 'movement' | 'recurring' | 'scenario' | 'estimate';
  movementId?: string | null;
  recurringId?: string | null;
  counterpartyName?: string | null;
  counterpartyTaxId?: string | null;
  category?: string | null;
}
