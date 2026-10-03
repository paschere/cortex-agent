import type { TrackerField } from '../../trackers/schema';
import { addDays, bogotaDay, dayOfValue } from './time';
import type { LookupFilter } from './types';

/**
 * QUÉ FILAS SE CONSULTAN: EL FILTRO DE LAS VISTAS, SOBRE FILAS DE UNA TABLA.
 *
 * Mismos operadores y mismo sentido que `matchesFilter` de la grilla
 * (apps/web/lib/datagrid/view.ts), para que «fecha es hoy Y estado no es
 * aterrizado, cancelado» quiera decir lo mismo al armarlo en pantalla que al
 * correr de madrugada:
 *   - buscar ignora tildes y mayúsculas;
 *   - un filtro a medio llenar (sin valor) todavía no filtra;
 *   - «no es / no es ninguno de» incluye lo vacío (una guía sin estado sigue
 *     consultándose hasta que algo diga que ya terminó).
 * En fechas, el valor puede ser «hoy» (el día de Bogotá al momento de correr).
 * `last_days 0` y `next_days 0` también son «hoy».
 */

export function foldText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase();
}

function isEmpty(value: unknown): boolean {
  return (
    value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
  );
}

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string')
    return value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
  if (value === undefined || value === null) return [];
  return [String(value)];
}

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const n = Number(value.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

const TODAY_TOKENS = new Set(['hoy', 'today', '@hoy']);
const isTodayToken = (v: unknown) =>
  typeof v === 'string' && TODAY_TOKENS.has(v.trim().toLowerCase());

/** El día que dice el valor de un filtro de fecha («hoy» o una fecha). */
function filterDay(value: unknown, today: string): string | null {
  return isTodayToken(value) ? today : dayOfValue(value);
}

/** Si el filtro ya dice algo (tiene el valor que su operador pide). */
export function isActiveFilter(filter: { op: string; value?: unknown }): boolean {
  if (filter.op === 'empty' || filter.op === 'not_empty') return true;
  const v = filter.value;
  if (filter.op === 'between') return Array.isArray(v) && (!isEmpty(v[0]) || !isEmpty(v[1]));
  if (filter.op === 'in' || filter.op === 'not_in') return asList(v).length > 0;
  if (typeof v === 'boolean') return true;
  return !isEmpty(v);
}

export function matchesOne(
  field: TrackerField | undefined,
  value: unknown,
  filter: { op: string; value?: unknown },
  today: string,
): boolean {
  const { op } = filter;
  const empty = isEmpty(value);
  if (op === 'empty') return empty;
  if (op === 'not_empty') return !empty;
  const type = field?.type ?? 'text';

  const dateOp = op === 'before' || op === 'after' || op === 'last_days' || op === 'next_days';
  const dateSemantics =
    type === 'date' ||
    dateOp ||
    isTodayToken(filter.value) ||
    (op === 'between' && Array.isArray(filter.value) && filter.value.some((v) => isTodayToken(v)));
  if (dateSemantics) {
    const day = dayOfValue(value);
    if (op === 'last_days' || op === 'next_days') {
      const n = parseNumber(filter.value);
      if (n === null || !day) return false;
      const days = Math.max(0, Math.round(n));
      return op === 'last_days'
        ? day >= addDays(today, -days) && day <= today
        : day >= today && day <= addDays(today, days);
    }
    if (op === 'between') {
      const [lo, hi] = Array.isArray(filter.value) ? filter.value : [];
      const a = filterDay(lo, today);
      const b = filterDay(hi, today);
      if (!day) return false;
      return (!a || day >= a) && (!b || day <= b);
    }
    if (op === 'in' || op === 'not_in') {
      const days = asList(filter.value).map((v) => filterDay(v, today));
      return op === 'in' ? Boolean(day) && days.includes(day) : !days.includes(day);
    }
    const target = filterDay(filter.value, today);
    if (!target) return true;
    if (op === 'neq') return day !== target;
    if (!day) return false;
    if (op === 'eq') return day === target;
    if (op === 'before' || op === 'lt') return day < target;
    if (op === 'after' || op === 'gt') return day > target;
    if (op === 'lte') return day <= target;
    if (op === 'gte') return day >= target;
    return true;
  }

  if (type === 'number' || type === 'money') {
    const n = parseNumber(value);
    if (op === 'between') {
      const [lo, hi] = Array.isArray(filter.value) ? filter.value : [];
      const a = parseNumber(lo);
      const b = parseNumber(hi);
      if (n === null) return false;
      return (a === null || n >= a) && (b === null || n <= b);
    }
    if (op === 'in' || op === 'not_in') {
      const list = asList(filter.value).map(parseNumber);
      return op === 'in' ? n !== null && list.includes(n) : n === null || !list.includes(n);
    }
    const target = parseNumber(filter.value);
    if (target === null) return true;
    if (op === 'neq') return n === null || n !== target;
    if (n === null) return false;
    if (op === 'eq') return n === target;
    if (op === 'gt') return n > target;
    if (op === 'gte') return n >= target;
    if (op === 'lt') return n < target;
    if (op === 'lte') return n <= target;
    return true;
  }

  if (type === 'select') {
    const have = empty ? [] : [String(value)];
    const want = asList(filter.value).map(foldText);
    const folded = have.map(foldText);
    if (op === 'in' || op === 'eq' || op === 'contains')
      return want.length === 0 || folded.some((v) => want.includes(v));
    if (op === 'not_in' || op === 'neq' || op === 'not_contains')
      return !folded.some((v) => want.includes(v));
    return true;
  }

  // Texto.
  const hay = foldText(value);
  const needle = foldText(filter.value);
  if (op === 'contains') return hay.includes(needle);
  if (op === 'not_contains') return !hay.includes(needle);
  if (op === 'eq') return hay === needle;
  if (op === 'neq') return hay !== needle;
  if (op === 'in') return asList(filter.value).some((v) => foldText(v) === hay);
  if (op === 'not_in') return !asList(filter.value).some((v) => foldText(v) === hay);
  if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') {
    const cmp = hay.localeCompare(needle, 'es');
    return op === 'gt' ? cmp > 0 : op === 'gte' ? cmp >= 0 : op === 'lt' ? cmp < 0 : cmp <= 0;
  }
  return true;
}

/** Si una fila cumple el filtro. Sin filtros activos, todas cumplen. */
export function matchesLookupFilter(
  filter: LookupFilter,
  fields: TrackerField[],
  values: Record<string, unknown>,
  nowMs: number,
): boolean {
  const active = filter.filters.filter(isActiveFilter);
  if (!active.length) return true;
  const today = bogotaDay(nowMs);
  const test = (f: (typeof active)[number]) =>
    matchesOne(
      fields.find((field) => field.key === f.key),
      values[f.key],
      f,
      today,
    );
  return filter.match === 'any' ? active.some(test) : active.every(test);
}

/** Los campos que el filtro nombra y la tabla no tiene (para validar al guardar). */
export function unknownFilterFields(filter: LookupFilter, fields: TrackerField[]): string[] {
  return [...new Set(filter.filters.map((f) => f.key))].filter(
    (key) => !fields.some((field) => field.key === key),
  );
}
