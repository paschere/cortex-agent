import {
  type FVal,
  type FormulaContext,
  dateClock,
  dateIso,
  evaluateParsed,
  isFDate,
  isFTime,
  parseDateText,
  parseFormula,
  parseLooseNumber,
  parseTimeText,
  roundTo,
  textOf,
  timeClock,
} from './formula';

/**
 * LOS CAMPOS QUE SE LLENAN SOLOS, del lado de la fila.
 *
 * Tres clases, todas definidas en la configuración del campo:
 *   - `formula`  se calcula de otros campos de la MISMA fila (formula.ts).
 *   - `lookup`   se trae de la fila relacionada (otra tabla) al elegir la relación.
 *   - `autofill` lo propone Cortex a partir de otros campos (ver autofill-shape.ts).
 *
 * Este módulo es PURO y no importa nada del servidor ni de `schema.ts` (que lo
 * importa a él): lo corren igual el servidor al guardar y el navegador al
 * instante en el formulario, sin el barril de @cortex/agent-tools.
 */

import { referenceList } from '../reference-lists';
import type { MatchConfig } from './match-shape';

/** Lo mínimo que se necesita de un campo; `TrackerField` lo cumple. */
export interface ComputedFieldLike {
  key: string;
  label: string;
  type: string;
  formula?: string;
  percent?: boolean;
  options?: string[];
  tracker?: string;
  lookup?: { via: string; field: string; editable?: boolean };
  autofill?: { instruction: string; from: string[]; fills: string[]; when?: 'no_match' | 'rest' };
  match?: MatchConfig;
}

/** Los tipos que una fórmula puede devolver. */
export const FORMULA_RESULT_TYPES = [
  'number',
  'money',
  'date',
  'time',
  'text',
  'longtext',
  'checkbox',
] as const;

export const isFormulaField = (f: ComputedFieldLike): boolean => Boolean(f.formula);
export const isLookupField = (f: ComputedFieldLike): boolean => Boolean(f.lookup);

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

/** El campo que un nombre de fórmula señala: clave exacta, nombre visible o clave sin tildes. */
export function resolveFieldRef<T extends ComputedFieldLike>(
  fields: readonly T[],
  name: string,
): T | undefined {
  const raw = name.trim();
  return (
    fields.find((f) => f.key === raw) ??
    fields.find((f) => fold(f.label) === fold(raw)) ??
    fields.find((f) => fold(f.key) === fold(raw))
  );
}

// ---------------------------------------------------------------------------
// Valores de la fila ⇄ valores de la fórmula
// ---------------------------------------------------------------------------

type Raw = unknown;
const blank = (v: Raw) => v === undefined || v === null || (typeof v === 'string' && !v.trim());

const UUID_IN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** El id (y la etiqueta) de un valor de relación guardado; null si no es una. */
export function relationParts(raw: Raw): { id: string; label: string } | null {
  if (blank(raw)) return null;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (UUID_IN.test(t)) return { id: t.toLowerCase(), label: '' };
    try {
      return relationParts(JSON.parse(t));
    } catch {
      return null;
    }
  }
  if (typeof raw === 'object') {
    const { id, label } = raw as { id?: unknown; label?: unknown };
    if (typeof id === 'string' && UUID_IN.test(id))
      return { id: id.toLowerCase(), label: typeof label === 'string' ? label : '' };
  }
  return null;
}

/** El valor guardado de un campo, como lo ve una fórmula. */
export function toFVal(field: ComputedFieldLike, raw: Raw): FVal {
  switch (field.type) {
    case 'checkbox':
      return blank(raw) ? false : Number(raw) === 1 || raw === true || fold(String(raw)) === 'si';
    case 'number':
    case 'money': {
      if (blank(raw)) return null;
      const n = typeof raw === 'number' ? raw : parseLooseNumber(String(raw));
      return n !== null && Number.isFinite(n) ? n : null;
    }
    case 'date':
      return blank(raw) ? null : parseDateText(String(raw));
    case 'time':
      return blank(raw) ? null : parseTimeText(String(raw));
    case 'relation': {
      const rel = relationParts(raw);
      return rel ? rel.label || rel.id : null;
    }
    case 'file': {
      if (blank(raw)) return null;
      try {
        const data = JSON.parse(String(raw)) as unknown;
        const list = Array.isArray(data) ? data : [data];
        return list.map((f) => (f as { name?: string }).name ?? '').join(', ');
      } catch {
        return String(raw);
      }
    }
    default:
      return blank(raw) ? null : String(raw);
  }
}

export type FromFVal =
  | { ok: true; value: string | number | undefined }
  | { ok: false; message: string };

const TEXT_CAP = 400;
const LONGTEXT_CAP = 4000;

/** El resultado de una fórmula, listo para guardarse en un campo de este tipo. */
export function fromFVal(field: ComputedFieldLike, v: FVal): FromFVal {
  if (v === null) return { ok: true, value: undefined };
  const bad = (what: string): FromFVal => ({
    ok: false,
    message: `La fórmula de «${field.label}» tiene que dar ${what}.`,
  });
  switch (field.type) {
    case 'number':
    case 'money': {
      let n: number | null = null;
      if (typeof v === 'number') n = v;
      else if (typeof v === 'boolean') n = v ? 1 : 0;
      else if (typeof v === 'string') n = parseLooseNumber(v);
      if (n === null || !Number.isFinite(n)) return bad('un número');
      return { ok: true, value: roundTo(n, field.type === 'money' ? 2 : 6) };
    }
    case 'date': {
      const d = isFDate(v) ? v : typeof v === 'string' ? parseDateText(v) : null;
      return d ? { ok: true, value: dateIso(d) } : bad('una fecha');
    }
    case 'time': {
      if (isFTime(v)) return { ok: true, value: timeClock(v) };
      if (isFDate(v)) return { ok: true, value: dateClock(v) };
      const t = typeof v === 'string' ? parseTimeText(v) : null;
      return t ? { ok: true, value: timeClock(t) } : bad('una hora');
    }
    case 'checkbox': {
      if (typeof v === 'boolean') return { ok: true, value: v ? 1 : 0 };
      if (typeof v === 'number') return { ok: true, value: v !== 0 ? 1 : 0 };
      if (typeof v === 'string') {
        const t = fold(v);
        if (['si', 'true', 'verdadero', '1'].includes(t)) return { ok: true, value: 1 };
        if (['no', 'false', 'falso', '0', ''].includes(t)) return { ok: true, value: 0 };
      }
      return bad('sí o no');
    }
    case 'text':
    case 'longtext': {
      const text = textOf(v).trim();
      const cap = field.type === 'longtext' ? LONGTEXT_CAP : TEXT_CAP;
      return { ok: true, value: text ? text.slice(0, cap) : undefined };
    }
    default:
      return { ok: false, message: `«${field.label}» no puede ser un campo calculado.` };
  }
}

// ---------------------------------------------------------------------------
// Revisar el esquema: sintaxis, campos que existen, ciclos
// ---------------------------------------------------------------------------

export interface ComputedProblem {
  key: string;
  /** Qué propiedad del campo falla: `formula`, `lookup`, `autofill`. */
  path: 'formula' | 'lookup' | 'autofill' | 'match';
  message: string;
}

/** Las claves de los campos que la fórmula de este campo usa (los que existen). */
export function formulaDependencies(
  fields: readonly ComputedFieldLike[],
  field: ComputedFieldLike,
) {
  if (!field.formula) return [];
  const parsed = parseFormula(field.formula);
  if (!parsed.ok) return [];
  const out = new Set<string>();
  for (const name of parsed.formula.refs) {
    const ref = resolveFieldRef(fields, name);
    if (ref) out.add(ref.key);
  }
  return [...out];
}

/**
 * Todo lo que está mal en los campos calculados de una tabla, en español y
 * pensado para que el modelo (o la persona) lo corrija: fórmula mal escrita,
 * campo que no existe, ciclo entre fórmulas, un lookup que no apunta a una
 * relación, un autofill que llena un campo calculado.
 */
export function computedProblems(fields: readonly ComputedFieldLike[]): ComputedProblem[] {
  const out: ComputedProblem[] = [];
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const add = (key: string, path: ComputedProblem['path'], message: string) =>
    out.push({ key, path, message });

  for (const f of fields) {
    if (f.formula) {
      if (!(FORMULA_RESULT_TYPES as readonly string[]).includes(f.type))
        add(
          f.key,
          'formula',
          `«${f.label}» es de tipo ${f.type}: una fórmula sólo puede dar número, dinero, fecha, hora, texto o sí/no.`,
        );
      if (f.lookup) add(f.key, 'formula', `«${f.label}» no puede ser fórmula y lookup a la vez.`);
      const parsed = parseFormula(f.formula);
      if (!parsed.ok) {
        add(f.key, 'formula', `Fórmula de «${f.label}»: ${parsed.message}`);
        continue;
      }
      const seen = new Set<string>();
      for (const name of parsed.formula.refs) {
        const ref = resolveFieldRef(fields, name);
        if (!ref) {
          add(
            f.key,
            'formula',
            `Fórmula de «${f.label}»: no existe el campo «${name}». Los campos son: ${fields
              .filter((x) => x.key !== f.key)
              .map((x) => `[${x.label}]`)
              .join(', ')}.`,
          );
        } else if (ref.key === f.key) {
          add(f.key, 'formula', `Fórmula de «${f.label}»: no puede usarse a sí misma.`);
        } else if (!seen.has(ref.key)) {
          seen.add(ref.key);
        }
      }
    }
    if (f.lookup) {
      const via = byKey.get(f.lookup.via);
      if (!via || via.type !== 'relation')
        add(
          f.key,
          'lookup',
          `Lookup de «${f.label}»: «${f.lookup.via}» tiene que ser un campo de relación de esta tabla.`,
        );
      if (f.lookup.via === f.key)
        add(f.key, 'lookup', `Lookup de «${f.label}»: no puede apuntar a sí mismo.`);
      if (f.type === 'relation' || f.type === 'file')
        add(f.key, 'lookup', `«${f.label}» (${f.type}) no puede traer un valor de otra tabla.`);
    }
    if (f.match) {
      const m = f.match;
      const own = f.key;
      if (!byKey.has(m.from))
        add(own, 'match', `Buscar en lista de «${f.label}»: no existe el campo disparador «${m.from}».`);
      for (const target of Object.keys(m.fills)) {
        const t = byKey.get(target);
        if (!t) {
          add(own, 'match', `Buscar en lista de «${f.label}»: no existe el campo destino «${target}».`);
          continue;
        }
        if (target === m.from)
          add(own, 'match', `Buscar en lista de «${f.label}»: «${target}» no puede ser disparador y destino.`);
        if (t.formula || (t.lookup && !t.lookup.editable))
          add(own, 'match', `Buscar en lista de «${f.label}»: «${t.label}» ya se calcula solo.`);
        if (['file', 'relation', 'location'].includes(t.type))
          add(own, 'match', `Buscar en lista de «${f.label}»: «${t.label}» (${t.type}) no se puede llenar con texto.`);
      }
      const ref = m.source.startsWith('cortex.') ? referenceList(m.source) : null;
      if (m.source.startsWith('cortex.')) {
        if (!ref)
          add(own, 'match', `Buscar en lista de «${f.label}»: la lista «${m.source}» no existe.`);
        else {
          const cols = new Set(ref.columns.map((c) => c.key));
          for (const c of [m.key, ...Object.values(m.fills)])
            if (!cols.has(c))
              add(
                own,
                'match',
                `Buscar en lista de «${f.label}»: «${m.source}» no tiene la columna «${c}». Tiene: ${[...cols].join(', ')}.`,
              );
        }
      }
    }
    if (f.autofill) {
      const a = f.autofill;
      const own = f.key;
      for (const k of a.from)
        if (!byKey.has(k))
          add(own, 'autofill', `Autofill de «${f.label}»: no existe el campo «${k}» en \`from\`.`);
      for (const k of a.fills) {
        const target = byKey.get(k);
        if (!target) {
          add(own, 'autofill', `Autofill de «${f.label}»: no existe el campo «${k}» en \`fills\`.`);
          continue;
        }
        if (a.from.includes(k))
          add(
            own,
            'autofill',
            `Autofill de «${f.label}»: «${k}» no puede ser disparador y destino a la vez.`,
          );
        if (target.formula || (target.lookup && !target.lookup.editable))
          add(own, 'autofill', `Autofill de «${f.label}»: «${target.label}» ya se calcula solo.`);
        if (['file', 'relation', 'location'].includes(target.type))
          add(
            own,
            'autofill',
            `Autofill de «${f.label}»: «${target.label}» (${target.type}) no se puede llenar con texto.`,
          );
      }
      if (!a.from.includes(own))
        add(
          own,
          'autofill',
          `Autofill de «${f.label}»: \`from\` tiene que incluir al propio campo («${own}»).`,
        );
    }
  }

  // Ciclos entre fórmulas (a → b → a), uno por campo en el ciclo.
  const deps = new Map<string, string[]>();
  for (const f of fields) if (f.formula) deps.set(f.key, formulaDependencies(fields, f));
  const state = new Map<string, 1 | 2>();
  const reported = new Set<string>();
  const visit = (key: string, stack: string[]) => {
    state.set(key, 1);
    for (const d of deps.get(key) ?? []) {
      if (!deps.has(d)) continue;
      if (state.get(d) === 1) {
        const cycle = [...stack.slice(stack.indexOf(d)), key].map(
          (k) => `«${byKey.get(k)?.label ?? k}»`,
        );
        if (d !== key && !reported.has(d)) {
          reported.add(d);
          add(
            d,
            'formula',
            `Las fórmulas forman un ciclo: ${[...cycle, `«${byKey.get(d)?.label ?? d}»`].join(' → ')}. Una no puede depender de la otra.`,
          );
        }
      } else if (!state.get(d)) visit(d, [...stack, key]);
    }
    state.set(key, 2);
  };
  for (const key of deps.keys()) if (!state.get(key)) visit(key, []);
  return out;
}

/** Los campos con fórmula en el orden en que se pueden calcular (los que dependen de otros, después). */
export function formulaOrder<T extends ComputedFieldLike>(fields: readonly T[]): T[] {
  const formulas = fields.filter((f) => f.formula);
  const done = new Set<string>();
  const out: T[] = [];
  const visit = (f: T, depth: number) => {
    if (done.has(f.key) || depth > fields.length) return;
    done.add(f.key);
    for (const dep of formulaDependencies(fields, f)) {
      const d = formulas.find((x) => x.key === dep);
      if (d) visit(d, depth + 1);
    }
    out.push(f);
  };
  for (const f of formulas) visit(f, 0);
  return out;
}

// ---------------------------------------------------------------------------
// Calcular
// ---------------------------------------------------------------------------

function bogotaNow(): { today: string; now: string } {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { today: `${p.year}-${p.month}-${p.day}`, now: `${p.hour}:${p.minute}` };
}

export interface ComputeOptions {
  today?: string;
  now?: string;
  /** Si se pasa, sólo se calculan estos campos (y los que de ellos dependan se dejan como están). */
  only?: ReadonlySet<string>;
}

export interface ComputeResult<V> {
  values: Record<string, V | string | number>;
  /** Avisos por campo («No se puede dividir entre cero.»). */
  warnings: Record<string, string[]>;
  /** Fallos por campo: el campo quedó vacío por esto. */
  errors: Record<string, string>;
}

/**
 * Calcula todos los campos con fórmula de la fila. Lo que alguien haya puesto a
 * mano en un campo calculado se descarta: manda la fórmula. Un campo cuya
 * fórmula da vacío (o falla) queda sin valor.
 */
export function applyComputed<V = string | number>(
  fields: readonly ComputedFieldLike[],
  values: Record<string, V | string | number>,
  options: ComputeOptions = {},
): ComputeResult<V> {
  const out: Record<string, V | string | number> = { ...values };
  const warnings: Record<string, string[]> = {};
  const errors: Record<string, string> = {};
  const clock = options.today && options.now ? null : bogotaNow();
  const today = options.today ?? (clock as { today: string }).today;
  const now = options.now ?? (clock as { now: string }).now;
  const cache = new Map<string, FVal>();
  const fvalOf = (f: ComputedFieldLike): FVal => {
    if (cache.has(f.key)) return cache.get(f.key) as FVal;
    const v = toFVal(f, out[f.key]);
    cache.set(f.key, v);
    return v;
  };
  const ctx: FormulaContext = {
    today,
    now,
    get: (name) => {
      const f = resolveFieldRef(fields, name);
      return f ? fvalOf(f) : undefined;
    },
  };
  for (const f of formulaOrder(fields)) {
    if (options.only && !options.only.has(f.key)) continue;
    delete out[f.key];
    cache.delete(f.key);
    const parsed = parseFormula(f.formula as string);
    if (!parsed.ok) {
      errors[f.key] = parsed.message;
      continue;
    }
    const res = evaluateParsed(parsed.formula, ctx);
    if (res.warnings.length) warnings[f.key] = res.warnings;
    if (res.error) {
      errors[f.key] = res.error;
      continue;
    }
    const stored = fromFVal(f, res.value);
    if (!stored.ok) {
      errors[f.key] = stored.message;
      continue;
    }
    if (stored.value !== undefined) out[f.key] = stored.value;
  }
  return { values: out, warnings, errors };
}

/** Los campos que alguien tiene que llenar a mano: sin los calculados. */
export function fillableFields<T extends ComputedFieldLike>(fields: readonly T[]): T[] {
  return fields.filter((f) => !f.formula && !(f.lookup && !f.lookup.editable));
}

// ---------------------------------------------------------------------------
// Lookup: traer de la fila relacionada
// ---------------------------------------------------------------------------

/** Qué campos son lookup y por qué relación vienen. */
export function lookupSources(fields: readonly ComputedFieldLike[]) {
  return fields
    .filter((f) => f.lookup)
    .map((f) => ({
      field: f,
      via: (f.lookup as NonNullable<ComputedFieldLike['lookup']>).via,
      target: (f.lookup as NonNullable<ComputedFieldLike['lookup']>).field,
      editable: Boolean(f.lookup?.editable),
    }));
}

/** Un valor de otra tabla, en la forma que acepta este campo; undefined si no encaja. */
export function adaptLookupValue(field: ComputedFieldLike, raw: Raw): string | number | undefined {
  if (blank(raw)) return undefined;
  switch (field.type) {
    case 'number':
    case 'money': {
      const n = typeof raw === 'number' ? raw : parseLooseNumber(String(raw));
      return n !== null && Number.isFinite(n) ? n : undefined;
    }
    case 'checkbox':
      return Number(raw) === 1 || fold(String(raw)) === 'si' ? 1 : 0;
    case 'select': {
      const hit = field.options?.find((o) => fold(o) === fold(String(raw)));
      return hit;
    }
    default:
      return typeof raw === 'number'
        ? raw
        : String(raw).slice(0, field.type === 'longtext' ? LONGTEXT_CAP : TEXT_CAP);
  }
}

/**
 * Pone en la fila lo que traen los lookups. `related[via]` es la fila
 * relacionada ya leída (`undefined` = no se pudo leer: se deja lo que hay).
 *   - Lookup NO editable: manda la fila relacionada, siempre; sin relación, queda vacío.
 *   - Lookup editable: se llena si está vacío o si la relación acaba de cambiar
 *     (`changedVia`); si no, lo que la persona dejó se respeta.
 */
export function fillLookups<V>(
  fields: readonly ComputedFieldLike[],
  values: Record<string, V | string | number>,
  related: Record<string, Record<string, unknown> | null | undefined>,
  options: { changedVia?: ReadonlySet<string> } = {},
): Record<string, V | string | number> {
  const out = { ...values };
  for (const s of lookupSources(fields)) {
    const rel = relationParts(out[s.via]);
    const row = related[s.via];
    if (!rel) {
      if (!s.editable) delete out[s.field.key];
      continue;
    }
    if (row === undefined || row === null) continue;
    const next = adaptLookupValue(s.field, row[s.target]);
    const current = out[s.field.key];
    if (s.editable && !blank(current) && !options.changedVia?.has(s.via)) continue;
    if (next === undefined) {
      if (!s.editable || options.changedVia?.has(s.via)) delete out[s.field.key];
    } else out[s.field.key] = next;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cambios de fórmula: qué filas hay que recalcular
// ---------------------------------------------------------------------------

/** Las claves cuyo cálculo (fórmula, tipo, o lookup) cambió entre dos esquemas. */
export function changedComputedKeys(
  before: readonly ComputedFieldLike[],
  after: readonly ComputedFieldLike[],
): string[] {
  const prev = new Map(before.map((f) => [f.key, f]));
  const out: string[] = [];
  for (const f of after) {
    if (!f.formula && !f.lookup) continue;
    const old = prev.get(f.key);
    const same =
      old &&
      old.formula === f.formula &&
      old.type === f.type &&
      JSON.stringify(old.lookup ?? null) === JSON.stringify(f.lookup ?? null);
    if (!same) out.push(f.key);
  }
  return out;
}
