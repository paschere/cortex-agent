import { FORMAT_LABEL, checkFormat, compilePattern, testPattern } from './formats';
import {
  type TrackerField,
  coerceValue,
  displayTrackerValue,
  parseCheckbox,
  parseRelationValue,
} from './schema';

/**
 * Validación de una fila ENTERA contra las reglas de sus campos: obligatorios,
 * rangos, largos, formato, patrón, únicos y campos condicionales.
 *
 * Es una función PURA y sin dependencias de servidor, a propósito: el servidor
 * la corre en toda escritura (agente, formulario público, edición en celda) y
 * el formulario del navegador corre la MISMA para decir el error debajo del
 * input antes de enviar. Lo único que no puede saber sin la base —que un valor
 * ya existe— entra por `existing`; quien escribe lo lee y se lo pasa.
 *
 * Lo que no es regla de un campo (que la fila relacionada exista, que un
 * archivo se haya subido de verdad) lo comprueba el servidor aparte.
 */

export interface Violation {
  key: string;
  message: string;
}

export interface ValidateOptions {
  /** Filas que ya existen, para `unique`. Con `selfId` se salta la fila que se edita. */
  existing?: Array<{ id?: string; values: Record<string, unknown> }>;
  selfId?: string;
  /** «YYYY-MM-DD» de hoy (hora de Bogotá). Se calcula si no se pasa. */
  today?: string;
  /** «HH:MM» de ahora (hora de Bogotá). Se calcula si no se pasa. */
  now?: string;
}

// ---------------------------------------------------------------------------
// Hoy y ahora, en hora de Bogotá (la de las empresas que usan esto)
// ---------------------------------------------------------------------------

function bogotaParts(date: Date): { day: string; time: string } {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

export function todayBogota(date: Date = new Date()): string {
  return bogotaParts(date).day;
}
export function nowBogota(date: Date = new Date()): string {
  return bogotaParts(date).time;
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** «today», «today+7», «now» o un literal → el valor concreto de HOY. */
export function resolveBound(
  type: 'date' | 'time',
  bound: string,
  ctx: { today: string; now: string },
): string {
  if (type === 'time') return bound === 'now' ? ctx.now : bound;
  const m = /^today(?:([+-])(\d{1,4}))?$/.exec(bound);
  if (!m) return bound;
  return m[1] ? addDays(ctx.today, (m[1] === '-' ? -1 : 1) * Number(m[2])) : ctx.today;
}

// ---------------------------------------------------------------------------
// Campos condicionales
// ---------------------------------------------------------------------------

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

const fold = (v: unknown) =>
  String(v ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .trim()
    .toLowerCase();

function conditionHolds(
  dep: TrackerField | undefined,
  value: unknown,
  cond: NonNullable<TrackerField['showIf']>,
): boolean {
  if (cond.notEmpty !== undefined) {
    const filled = dep?.type === 'checkbox' ? parseCheckbox(value) === 1 : !isBlank(value);
    if (filled !== cond.notEmpty) return false;
  }
  if (cond.equals !== undefined) {
    const wanted = Array.isArray(cond.equals) ? cond.equals : [cond.equals];
    if (dep?.type === 'checkbox') {
      const have = parseCheckbox(value);
      return wanted.some((w) => parseCheckbox(w) === have);
    }
    return wanted.some((w) => fold(w) === fold(value));
  }
  return true;
}

/**
 * Las claves de los campos que se muestran con estos valores. Un campo cuyo
 * «padre» está oculto también se oculta (la cadena entera tiene que cumplirse).
 * El esquema ya impide ciclos; aun así se corta la recursión por si llega un
 * esquema viejo o roto.
 */
export function visibleKeys(fields: TrackerField[], values: Record<string, unknown>): Set<string> {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const memo = new Map<string, boolean>();
  const visible = (f: TrackerField, depth: number): boolean => {
    const cached = memo.get(f.key);
    if (cached !== undefined) return cached;
    let ok = true;
    if (f.showIf && depth < fields.length) {
      const dep = byKey.get(f.showIf.field);
      // Si el padre no está entre los campos (un formulario que pide un subconjunto)
      // la condición no se puede evaluar: el campo se queda visible.
      ok = dep ? visible(dep, depth + 1) && conditionHolds(dep, values[dep.key], f.showIf) : true;
    }
    memo.set(f.key, ok);
    return ok;
  };
  return new Set(fields.filter((f) => visible(f, 0)).map((f) => f.key));
}

export function isFieldVisible(
  fields: TrackerField[],
  field: TrackerField,
  values: Record<string, unknown>,
): boolean {
  return visibleKeys(fields, values).has(field.key);
}

// ---------------------------------------------------------------------------
// Valores por defecto
// ---------------------------------------------------------------------------

/**
 * El valor inicial de cada campo que tiene `default`: «today», «now»,
 * «viewer» (el nombre de quien llena; sin sesión, vacío) o el valor fijo.
 * Sólo devuelve los campos con valor: lo vacío no se pre-llena.
 */
export function defaultValues(
  fields: TrackerField[],
  ctx: { today?: string; now?: string; viewer?: string | null } = {},
): Record<string, string | number> {
  const today = ctx.today ?? todayBogota();
  const now = ctx.now ?? nowBogota();
  const out: Record<string, string | number> = {};
  for (const f of fields) {
    const d = f.default;
    if (d === undefined || d === '') continue;
    let v: string | number | undefined;
    if (d === 'today') v = f.type === 'date' ? today : f.type === 'time' ? now : undefined;
    else if (d === 'now') v = f.type === 'time' ? now : f.type === 'date' ? today : undefined;
    else if (d === 'viewer') v = ctx.viewer?.trim() || undefined;
    else if (f.type === 'checkbox') v = parseCheckbox(d) ?? undefined;
    else v = d;
    if (v !== undefined && v !== '') out[f.key] = v;
  }
  return out;
}

/** Rellena con los defaults lo que vino vacío (y se muestra). No pisa nada. */
export function withDefaults(
  fields: TrackerField[],
  values: Record<string, unknown>,
  ctx: { today?: string; now?: string; viewer?: string | null } = {},
): Record<string, unknown> {
  const defaults = defaultValues(fields, ctx);
  const merged: Record<string, unknown> = { ...values };
  for (const [k, v] of Object.entries(defaults)) if (isBlank(merged[k])) merged[k] = v;
  return merged;
}

// ---------------------------------------------------------------------------
// La validación
// ---------------------------------------------------------------------------

/** Texto con el que se compara un `unique`: sin tildes, espacios, guiones ni mayúsculas. */
export function uniqueKey(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[\s\-_.]+/g, '');
}

/** Lo que se compara en un `unique`: para una relación, el id (la etiqueta puede cambiar). */
function comparable(field: TrackerField, v: unknown): string {
  if (isBlank(v)) return '';
  if (field.type === 'relation') return parseRelationValue(v)?.id ?? String(v);
  return String(v);
}

function boundText(field: TrackerField, bound: string | number): string {
  if (field.type === 'money') return `$${Number(bound).toLocaleString('es-CO')}`;
  return String(bound);
}

/**
 * Valida los valores de una fila contra los campos. Devuelve la lista de
 * errores en español (vacía = todo bien). Acepta valores crudos (lo que escribió
 * alguien en un formulario) o ya normalizados.
 */
export function validateRowValues(
  fields: TrackerField[],
  values: Record<string, unknown>,
  options: ValidateOptions = {},
): Violation[] {
  const ctx = { today: options.today ?? todayBogota(), now: options.now ?? nowBogota() };
  const visible = visibleKeys(fields, values);
  const out: Violation[] = [];

  for (const field of fields) {
    // Un campo oculto no se exige ni se valida: el servidor lo descarta.
    if (!visible.has(field.key)) continue;
    const raw = values[field.key];
    if (isBlank(raw)) {
      if (field.required) out.push({ key: field.key, message: `Falta «${field.label}».` });
      continue;
    }
    // Primero que el valor tenga la forma del tipo (fecha válida, número, opción…).
    const typed = coerceValue(field, raw);
    if (!typed.ok) {
      out.push({ key: field.key, message: typed.message });
      continue;
    }
    const value = typed.value;
    const rule = (fallback: string): Violation => ({
      key: field.key,
      message: field.message ?? fallback,
    });
    const label = `«${field.label}»`;

    if (field.type === 'number' || field.type === 'money') {
      const n = Number(value);
      if (typeof field.min === 'number' && n < field.min)
        out.push(rule(`${label} no puede ser menor que ${boundText(field, field.min)}.`));
      if (typeof field.max === 'number' && n > field.max)
        out.push(rule(`${label} no puede ser mayor que ${boundText(field, field.max)}.`));
    } else if (field.type === 'date' || field.type === 'time') {
      const v = String(value);
      const lo =
        typeof field.min === 'string' ? resolveBound(field.type, field.min, ctx) : undefined;
      const hi =
        typeof field.max === 'string' ? resolveBound(field.type, field.max, ctx) : undefined;
      if (lo && v < lo) {
        out.push(
          rule(
            field.type === 'date' && field.min === 'today'
              ? `${label} no puede ser una fecha pasada.`
              : `${label} no puede ser anterior a ${lo}.`,
          ),
        );
      }
      if (hi && v > hi) {
        out.push(
          rule(
            field.type === 'date' && field.max === 'today'
              ? `${label} no puede ser una fecha futura.`
              : field.type === 'time' && field.max === 'now'
                ? `${label} no puede ser una hora futura.`
                : `${label} no puede ser posterior a ${hi}.`,
          ),
        );
      }
    } else if (field.type === 'text' || field.type === 'longtext') {
      const s = String(value);
      if (field.minLength !== undefined && s.length < field.minLength)
        out.push(rule(`${label} necesita al menos ${field.minLength} caracteres.`));
      if (field.maxLength !== undefined && s.length > field.maxLength)
        out.push(rule(`${label} admite hasta ${field.maxLength} caracteres.`));
      if (field.format && !checkFormat(field.format, s))
        out.push(rule(`${label} tiene que ser ${FORMAT_LABEL[field.format]}.`));
      if (field.pattern) {
        const re = compilePattern(field.pattern);
        // Un patrón que no compila (esquema viejo o roto) no bloquea a nadie.
        if (re && !testPattern(re, s)) out.push(rule(`${label} no tiene el formato esperado.`));
      }
    }

    if (field.unique && options.existing && field.type !== 'file') {
      const mine = uniqueKey(comparable(field, value));
      const clash =
        mine !== '' &&
        options.existing.some(
          (r) =>
            (options.selfId === undefined || r.id !== options.selfId) &&
            uniqueKey(comparable(field, r.values[field.key])) === mine,
        );
      if (clash)
        out.push(rule(`Ya hay un registro con ${label} «${displayTrackerValue(field, value)}».`));
    }
  }
  return out;
}

/** Los mensajes de la lista por campo (el primero de cada uno), para pintar debajo del input. */
export function violationsByKey(list: Violation[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of list) if (!(v.key in out)) out[v.key] = v.message;
  return out;
}
