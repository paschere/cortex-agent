import { parsePath } from '../../custom-tools/response';
import type { TrackerField } from '../../trackers/schema';
import { bogotaDateTime } from '../sync';
import { matchesLookupFilter } from './filter';
import { renderLookupUrl } from './template';
import { MINUTE, bogotaDay, bogotaDayStart, dayOfValue, parseMoment } from './time';
import type { LookupMappingEntry, RowLookupRow } from './types';

/**
 * EL PLANIFICADOR: QUÉ FILAS SE CONSULTAN AHORA, PURO.
 *
 * Cada vuelta del trabajo programado le pasa la configuración, las filas de la
 * tabla y el estado de cada una; devuelve a quién llamar, con qué dirección, y
 * por qué no a los demás. No toca red ni base: así se prueba con filas de
 * mentira y el ejecutor (`run.ts`) sólo hace lo que este plan dice.
 *
 * El orden de las decisiones, por fila:
 *   1. ¿cumple el filtro? (la regla de parada —estado = aterrizado— ES el filtro);
 *   2. ¿está dentro de la ventana «cerca de»? Fuera: consulta al intervalo base,
 *      o ninguna si la regla dice `skip`;
 *   3. ¿ya toca? (`next_at` vencido o nunca consultada);
 *   4. ¿se puede armar la dirección con los campos de la fila? Si falta uno, no
 *      se consulta ni se gasta una consulta;
 *   5. los topes: lo que ya se gastó hoy (día de Bogotá) y lo de esta corrida.
 *      Las más urgentes pasan primero.
 */

export interface PlanRowInput {
  id: string;
  values: Record<string, string | number>;
}

export interface PlanState {
  next_at: string | null;
  fail_count: number;
}

export type PlanSpec = Pick<
  RowLookupRow,
  | 'url_template'
  | 'filter'
  | 'base_interval_minutes'
  | 'near'
  | 'daily_cap'
  | 'per_run_cap'
  | 'calls_today'
  | 'calls_day'
>;

export interface PlannedCall {
  rowId: string;
  url: string;
  /** Qué tan urgente es: 0 dentro de la ventana, 1 fuera. */
  urgency: number;
}

export interface LookupPlan {
  /** El día de Bogotá del plan. */
  day: string;
  /** Consultas ya hechas hoy (en cero si cambió el día). */
  callsToday: number;
  /** Cuántas se pueden hacer en esta corrida. */
  budget: number;
  calls: PlannedCall[];
  /** Tocaban, pero no cupieron en el tope. */
  deferred: number;
  capped: 'daily' | 'run' | null;
  skipped: { filter: number; window: number; missing: number; notDue: number };
  /** Filas a las que les faltó un campo de la dirección (muestra). */
  missing: Array<{ rowId: string; fields: string[] }>;
  /** Cuándo toca la próxima de las que aún no tocan (ms), o null. */
  nextDueMs: number | null;
}

export function lookupToday(spec: Pick<PlanSpec, 'calls_day' | 'calls_today'>, nowMs: number) {
  const day = bogotaDay(nowMs);
  return { day, callsToday: spec.calls_day === day ? spec.calls_today : 0 };
}

interface Cadence {
  eligible: boolean;
  intervalMinutes: number;
  inWindow: boolean;
  /** Cuándo abre la ventana, si todavía no abrió (ms). */
  opensAt: number | null;
}

/** Cada cuánto se consulta una fila con estos valores, y si entra en la ventana. */
export function cadenceFor(
  spec: Pick<PlanSpec, 'base_interval_minutes' | 'near'>,
  values: Record<string, unknown>,
  nowMs: number,
): Cadence {
  const near = spec.near;
  if (!near)
    return {
      eligible: true,
      intervalMinutes: spec.base_interval_minutes,
      inWindow: false,
      opensAt: null,
    };
  const at = parseMoment(values[near.field]);
  const open = at === null ? null : at - near.beforeMinutes * MINUTE;
  const close = at === null ? null : at + near.afterMinutes * MINUTE;
  if (open !== null && close !== null && nowMs >= open && nowMs <= close)
    return { eligible: true, intervalMinutes: near.everyMinutes, inWindow: true, opensAt: null };
  if (near.outside === 'skip')
    return {
      eligible: false,
      intervalMinutes: spec.base_interval_minutes,
      inWindow: false,
      opensAt: open !== null && open > nowMs ? open : null,
    };
  return {
    eligible: true,
    intervalMinutes: spec.base_interval_minutes,
    inWindow: false,
    opensAt: open !== null && open > nowMs ? open : null,
  };
}

/** Tope de espera tras fallos seguidos (2 h). */
const MAX_BACKOFF_MINUTES = 120;

/**
 * Cuándo vuelve a tocar una fila tras consultarla. Con los valores YA
 * escritos (la propia respuesta puede mover la hora que abre la ventana).
 * Si la ventana abre antes del siguiente intervalo, toca cuando abre. Los
 * fallos seguidos espacian el reintento: ×2 por fallo, hasta ×8 y 2 h.
 */
export function nextAtAfter(
  spec: Pick<PlanSpec, 'base_interval_minutes' | 'near'>,
  values: Record<string, unknown>,
  nowMs: number,
  failCount: number,
): number {
  const cadence = cadenceFor(spec, values, nowMs);
  const factor = failCount > 0 ? Math.min(2 ** failCount, 8) : 1;
  const minutes = Math.min(
    cadence.intervalMinutes * factor,
    Math.max(MAX_BACKOFF_MINUTES, cadence.intervalMinutes),
  );
  let next = nowMs + minutes * MINUTE;
  if (failCount === 0 && cadence.opensAt !== null && cadence.opensAt < next)
    next = Math.max(cadence.opensAt, nowMs + 5 * MINUTE);
  return next;
}

export function planLookup(
  spec: PlanSpec,
  fields: TrackerField[],
  rows: PlanRowInput[],
  states: Map<string, PlanState>,
  nowMs: number,
): LookupPlan {
  const { day, callsToday } = lookupToday(spec, nowMs);
  const dailyLeft = Math.max(0, spec.daily_cap - callsToday);
  const budget = Math.min(spec.per_run_cap, dailyLeft);
  const skipped = { filter: 0, window: 0, missing: 0, notDue: 0 };
  const missing: LookupPlan['missing'] = [];
  const due: Array<PlannedCall & { sortAt: number }> = [];
  let nextDueMs: number | null = null;

  for (const row of rows) {
    if (!matchesLookupFilter(spec.filter, fields, row.values, nowMs)) {
      skipped.filter += 1;
      continue;
    }
    const cadence = cadenceFor(spec, row.values, nowMs);
    if (!cadence.eligible) {
      skipped.window += 1;
      if (cadence.opensAt !== null && (nextDueMs === null || cadence.opensAt < nextDueMs))
        nextDueMs = cadence.opensAt;
      continue;
    }
    const state = states.get(row.id);
    const at = state?.next_at ? Date.parse(state.next_at) : Number.NaN;
    if (Number.isFinite(at) && at > nowMs) {
      skipped.notDue += 1;
      if (nextDueMs === null || at < nextDueMs) nextDueMs = at;
      continue;
    }
    const url = renderLookupUrl(spec.url_template, row.values, nowMs);
    if (!url.ok) {
      skipped.missing += 1;
      if (missing.length < 5) missing.push({ rowId: row.id, fields: url.missing });
      continue;
    }
    due.push({
      rowId: row.id,
      url: url.url,
      urgency: cadence.inWindow ? 0 : 1,
      sortAt: Number.isFinite(at) ? at : 0,
    });
  }

  due.sort((a, b) => a.urgency - b.urgency || a.sortAt - b.sortAt);
  const calls = due.slice(0, budget).map(({ sortAt: _s, ...call }) => call);
  const deferred = due.length - calls.length;
  const capped: LookupPlan['capped'] =
    deferred > 0 ? (spec.per_run_cap < dailyLeft ? 'run' : 'daily') : null;
  return { day, callsToday, budget, calls, deferred, capped, skipped, missing, nextDueMs };
}

// ---------------------------------------------------------------------------
// La respuesta de la API → columnas de la tabla
// ---------------------------------------------------------------------------

function walk(data: unknown, path: string): unknown {
  let node: unknown = data;
  for (const segment of parsePath(path)) {
    if (node === null || node === undefined) return undefined;
    if (Array.isArray(node)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= node.length) return undefined;
      node = node[index];
      continue;
    }
    if (typeof node !== 'object') return undefined;
    const record = node as Record<string, unknown>;
    if (!Object.hasOwn(record, segment)) return undefined;
    node = record[segment];
  }
  return node;
}

/** Un valor de la respuesta en una cadena JSON o ya parseada. */
export function valueAtPath(data: unknown, path: string): unknown {
  return walk(data, path);
}

const HAS_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

function coerce(
  field: TrackerField,
  raw: unknown,
  translate: Record<string, string> | undefined,
): string | number | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === 'object') {
    if (Array.isArray(raw) && raw.every((v) => v === null || typeof v !== 'object'))
      return (
        raw
          .filter((v) => v !== null && v !== '')
          .join(', ')
          .slice(0, 400) || undefined
      );
    return undefined;
  }
  let text = typeof raw === 'boolean' ? (raw ? 'Sí' : 'No') : String(raw).trim();
  if (!text) return undefined;
  if (translate) {
    const hit = Object.entries(translate).find(([k]) => k.toLowerCase() === text.toLowerCase());
    if (hit) text = hit[1];
  }
  switch (field.type) {
    case 'number':
    case 'money': {
      const n = typeof raw === 'number' ? raw : Number(text.replace(/\s/g, '').replace(',', '.'));
      return Number.isFinite(n) ? n : undefined;
    }
    case 'date':
      return dayOfValue(text) ?? undefined;
    case 'select':
      return text.slice(0, 80);
    default:
      return HAS_TIME.test(text)
        ? (bogotaDateTime(text) ?? text.slice(0, 400))
        : text.slice(0, 400);
  }
}

export interface MappedValues {
  values: Record<string, string | number>;
  /** Caminos que la respuesta no trajo (o vacíos). */
  absent: string[];
  /** Valores de un campo de opciones que la tabla aún no conoce. */
  newOptions: Record<string, string[]>;
}

/** Aplica el mapeo a una respuesta ya leída. */
export function mapResponse(
  data: unknown,
  mapping: LookupMappingEntry[],
  fields: TrackerField[],
): MappedValues {
  const values: Record<string, string | number> = {};
  const absent: string[] = [];
  const newOptions: Record<string, string[]> = {};
  for (const entry of mapping) {
    const field = fields.find((f) => f.key === entry.field);
    if (!field) {
      absent.push(entry.path);
      continue;
    }
    const value = coerce(field, walk(data, entry.path), entry.translate);
    if (value === undefined) {
      absent.push(entry.path);
      continue;
    }
    values[field.key] = value;
    if (field.type === 'select' && !field.options?.includes(String(value))) {
      newOptions[field.key] ??= [];
      if (!newOptions[field.key]?.includes(String(value)))
        newOptions[field.key]?.push(String(value));
    }
  }
  return { values, absent, newOptions };
}

/** Cuándo se reinicia el contador: la próxima medianoche de Bogotá (ms). */
export function nextResetMs(nowMs: number): number {
  return bogotaDayStart(bogotaDay(nowMs + 24 * 3_600_000));
}
