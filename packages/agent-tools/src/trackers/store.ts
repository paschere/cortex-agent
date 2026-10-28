import { usesTrm } from './trm';
import { ensureTrm } from './trm-store';
import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { emitAutomationEvent, watchesTracker } from '../apps/automations/emit';
import { referenceListsGrammar } from '../reference-lists';
import {
  applyComputed,
  changedComputedKeys,
  fillLookups,
  lookupSources,
  relationParts,
} from './computed';
import {
  type DuplicateRule,
  type TouchedKey,
  applyDuplicateRule,
  getDuplicateRule,
  validateDuplicateRule,
} from './duplicates';
import { flowOf } from './flow';
import {
  type TrackerOrigin,
  isSyncedTable,
  mergeOrigin,
  parseOrigins,
} from './origin';
import { assertDefineAllowed, assertRowWriteAllowed } from './origin-guard';
import { guardFlowWrite } from './flow-guard';
import {
  TEXT_MAX,
  type TrackerField,
  coerceValue,
  parseRelationValue,
  rowLabel,
  trackerFieldsSchema,
} from './schema';
import { type Violation, validateRowValues, visibleKeys, withDefaults } from './validation';

/**
 * Lectura y escritura de las tablas inventadas. `db` es siempre un handle con
 * alcance de espacio de trabajo: nada de aquí filtra por organization_id a mano.
 */

export const TRACKER_COLUMNS =
  'id, slug, name, description, fields, origins, created_by, created_at, updated_at';
export const TRACKER_ROW_COLUMNS =
  'id, tracker_id, label, values, created_by, created_at, updated_at';

export interface TrackerRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  fields: TrackerField[];
  /** De dónde se llena (0237); vacío = tabla propia. Ver `origin.ts`. */
  origins?: TrackerOrigin[];
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface TrackerEntryRow {
  id: string;
  tracker_id: string;
  label: string;
  values: Record<string, string | number>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function parseFields(raw: unknown): TrackerField[] {
  const parsed = trackerFieldsSchema.safeParse(raw);
  return parsed.success ? parsed.data : [];
}

function adaptTracker(row: Record<string, unknown>): TrackerRow {
  return {
    id: String(row.id),
    slug: String(row.slug),
    name: String(row.name),
    description: typeof row.description === 'string' ? row.description : '',
    fields: parseFields(row.fields),
    origins: parseOrigins(row.origins),
    created_by: typeof row.created_by === 'string' ? row.created_by : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function adaptEntry(row: Record<string, unknown>): TrackerEntryRow {
  const values =
    row.values && typeof row.values === 'object' && !Array.isArray(row.values)
      ? (row.values as Record<string, string | number>)
      : {};
  return {
    id: String(row.id),
    tracker_id: String(row.tracker_id),
    label: String(row.label),
    values,
    created_by: typeof row.created_by === 'string' ? row.created_by : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export async function listTrackers(
  db: SupabaseClient,
  limit = 40,
): Promise<Array<TrackerRow & { rowCount: number }>> {
  const { data, error } = await db
    .from('trackers')
    .select(`${TRACKER_COLUMNS}, tracker_rows(count)`)
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) throw error;

  return (data ?? []).map((row) => {
    const nested = (row as { tracker_rows?: Array<{ count: number }> }).tracker_rows;
    const count = Array.isArray(nested) ? (nested[0]?.count ?? 0) : 0;
    return { ...adaptTracker(row as Record<string, unknown>), rowCount: count };
  });
}

export async function getTrackerBySlug(
  db: SupabaseClient,
  slug: string,
): Promise<TrackerRow | null> {
  const { data, error } = await db
    .from('trackers')
    .select(TRACKER_COLUMNS)
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw error;
  return data ? adaptTracker(data as Record<string, unknown>) : null;
}

export async function getTrackerById(db: SupabaseClient, id: string): Promise<TrackerRow | null> {
  const { data, error } = await db
    .from('trackers')
    .select(TRACKER_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data ? adaptTracker(data as Record<string, unknown>) : null;
}

export async function defineTracker(
  db: SupabaseClient,
  input: {
    slug: string;
    name: string;
    description: string;
    fields: TrackerField[];
    userId: string;
    /**
     * La regla de duplicados (0201). `undefined` la deja como está —los demás
     * que redefinen una tabla (sync, lookups) no la mencionan y no deben
     * borrarla—; `null` la quita.
     */
    duplicates?: DuplicateRule | null;
    /**
     * Lo escribe la propia sincronización (hoja, carpeta, programa contable):
     * puede cambiar los campos del origen. Sin esto, una tabla que viene de una
     * integración sólo admite agregar o cambiar campos PROPIOS (0237).
     */
    system?: boolean;
  },
): Promise<{ tracker: TrackerRow; created: boolean }> {
  if (input.duplicates) {
    const problem = validateDuplicateRule(input.duplicates, input.fields);
    if (problem) throw new ValidationError(`Regla de duplicados: ${problem}`);
  }
  const withRule = input.duplicates === undefined ? {} : { duplicates: input.duplicates };
  await assertLookupTargets(db, input.slug, input.fields);
  await assertMatchSources(db, input.slug, input.fields);
  const existing = await getTrackerBySlug(db, input.slug);
  if (!input.system) assertDefineAllowed(existing, input.fields);
  const reapply = async (tracker: TrackerRow) => {
    // Una regla nueva o cambiada se aplica a lo que la tabla ya tiene.
    if (input.duplicates) await applyDuplicateRule(db, tracker.id);
    else if (input.duplicates === null) await clearDuplicateFlags(db, tracker.id);
    // Una fórmula nueva o cambiada se recalcula en las filas que ya existen.
    const changed = changedComputedKeys(existing?.fields ?? [], tracker.fields);
    if (changed.length > 0) await recomputeRows(db, tracker, changed);
    return tracker;
  };
  if (existing) {
    const { data, error } = await db
      .from('trackers')
      .update({
        name: input.name,
        description: input.description,
        fields: input.fields,
        ...withRule,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)
      .select(TRACKER_COLUMNS)
      .single();
    if (error) throw error;
    return {
      tracker: await reapply(adaptTracker(data as Record<string, unknown>)),
      created: false,
    };
  }

  const { data, error } = await db
    .from('trackers')
    .insert({
      slug: input.slug,
      name: input.name,
      description: input.description,
      fields: input.fields,
      ...withRule,
      created_by: input.userId,
    })
    .select(TRACKER_COLUMNS)
    .single();
  if (error) throw error;
  return { tracker: await reapply(adaptTracker(data as Record<string, unknown>)), created: true };
}

/** Quitar la regla: las marcas que ella puso se van con ella. */
async function clearDuplicateFlags(db: SupabaseClient, trackerId: string): Promise<void> {
  // Sin regla no se sabe qué campo era; se lee del último estado guardado antes
  // de borrarla sería lo ideal, pero basta con soltar la bandera: el valor
  // «Duplicada» que quede en la celda es un estado más que alguien puede cambiar.
  await db
    .from('tracker_rows')
    .update({ duplicate_flagged: false })
    .eq('tracker_id', trackerId)
    .eq('duplicate_flagged', true);
}

export { getDuplicateRule };

/**
 * Marca (o actualiza) de dónde viene una tabla: lo llaman las sincronizaciones
 * al crearla o al adoptarla. Mismo tipo y `ref` reemplaza; otro origen se suma.
 * Conserva `writeBack` si la empresa ya lo había activado.
 */
export async function setTrackerOrigin(
  db: SupabaseClient,
  trackerId: string,
  origin: TrackerOrigin,
): Promise<TrackerOrigin[]> {
  const { data, error } = await db
    .from('trackers')
    .select('origins')
    .eq('id', trackerId)
    .maybeSingle();
  if (error) throw error;
  const current = parseOrigins((data as { origins?: unknown } | null)?.origins);
  const next = mergeOrigin(current, origin);
  if (JSON.stringify(next) === JSON.stringify(current)) return current;
  const { error: updateError } = await db
    .from('trackers')
    .update({ origins: next })
    .eq('id', trackerId);
  if (updateError) throw updateError;
  return next;
}

export async function removeTracker(db: SupabaseClient, slug: string): Promise<boolean> {
  const { data, error } = await db
    .from('trackers')
    .delete()
    .eq('slug', slug)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

export interface ShapeOptions {
  /**
   * Sincronizaciones: las reglas del campo (rango, formato, único…) NO
   * bloquean la fila —un Sheet ajeno no se puede rechazar entero por una
   * placa mal escrita—; las violaciones vuelven aparte para marcarla. Los
   * errores de tipo y los obligatorios sí siguen siendo errores, como siempre.
   */
  lenient?: boolean;
  /** Rellena con `default` lo que venga vacío (filas nuevas). */
  applyDefaults?: boolean;
  /** Nombre de quien llena, para `default: 'viewer'`. */
  viewer?: string | null;
  /** Filas existentes, para `unique`. */
  existing?: Array<{ id?: string; values: Record<string, unknown> }>;
  selfId?: string;
  /** Edición parcial: sólo se reportan las reglas de estos campos (lo viejo no se juzga). */
  only?: ReadonlySet<string>;
}

/**
 * Valida y normaliza una fila entera: tipo de cada campo, campos ocultos por
 * `showIf` (se descartan y no se exigen) y las reglas de `validateRowValues`.
 */
export function shapeValuesDetailed(
  fields: TrackerField[],
  input: Record<string, unknown>,
  options: ShapeOptions = {},
): { values: Record<string, string | number>; violations: Violation[] } {
  const unknown = Object.keys(input).filter((key) => !fields.some((f) => f.key === key));
  if (unknown.length > 0) {
    throw new ValidationError(`Estos campos no existen en la tabla: ${unknown.join(', ')}.`);
  }
  const raw = options.applyDefaults
    ? withDefaults(fields, input, { viewer: options.viewer })
    : input;
  const visible = visibleKeys(fields, raw);
  let values: Record<string, string | number> = {};
  for (const field of fields) {
    if (!visible.has(field.key)) continue;
    // Un campo calculado no se escribe: lo pone la fórmula (abajo).
    if (field.formula) continue;
    const coerced = coerceValue(field, raw[field.key]);
    if (!coerced.ok) throw new ValidationError(coerced.message);
    if (coerced.value !== '') values[field.key] = coerced.value;
  }
  if (fields.some((f) => f.formula)) {
    // Los que están ocultos por showIf no se calculan ni se guardan.
    const hidden = fields.filter((f) => f.formula && !visible.has(f.key));
    values = applyComputed(fields, values).values as Record<string, string | number>;
    for (const f of hidden) delete values[f.key];
  }
  let violations = validateRowValues(fields, values, {
    existing: options.existing,
    selfId: options.selfId,
  });
  const only = options.only;
  if (only) violations = violations.filter((v) => only.has(v.key));
  if (violations.length > 0 && !options.lenient) {
    throw new ValidationError(violations.map((v) => v.message).join(' '));
  }
  return { values, violations };
}

export function shapeValues(
  fields: TrackerField[],
  raw: Record<string, unknown>,
  options: ShapeOptions = {},
): Record<string, string | number> {
  return shapeValuesDetailed(fields, raw, options).values;
}

/**
 * Sincronizaciones: una fila que no cumple las reglas entra igual, pero queda
 * a la vista. Si la tabla tiene un campo de revisión (clave `revision`,
 * `revisar`, `para_revisar`; texto, o select con una opción que diga «revis…»)
 * se escribe ahí; si no, se deja en el registro del servidor.
 */
export function markForReview(
  tracker: Pick<TrackerRow, 'slug' | 'fields'>,
  values: Record<string, string | number>,
  violations: Violation[],
): Record<string, string | number> {
  if (violations.length === 0) return values;
  const field = tracker.fields.find((f) => /^(revision|revisar|para_revisar)$/.test(f.key));
  const note = `Revisar: ${violations.map((v) => v.message).join(' ')}`.slice(0, TEXT_MAX);
  if (field?.type === 'text') return { ...values, [field.key]: note };
  const option =
    field?.type === 'select' ? field.options?.find((o) => /revis/i.test(o)) : undefined;
  if (field && option) return { ...values, [field.key]: option };
  console.warn(
    `[trackers] fila de ${tracker.slug} entró con ${violations.length} regla(s) incumplida(s): ${note}`,
  );
  return values;
}

const UNIQUE_SCAN_LIMIT = 5000;

/**
 * Prepara los valores de una escritura de ESTE lado del servidor: defaults,
 * campos ocultos, reglas (incluido `unique`, que necesita leer la tabla) y
 * relaciones. Es lo que usan upsertRow, el formulario y la edición en celda.
 *
 * Relaciones: el id tiene que ser de una fila de la tabla relacionada y la
 * etiqueta que se guarda es la REAL de esa fila, no la que mandó el navegador.
 * `allowedRelationTrackers` limita a qué tablas puede apuntar quien escribe
 * (la página pública sólo apunta a las fuentes de su vista).
 */
export async function prepareValues(
  db: SupabaseClient,
  tracker: Pick<TrackerRow, 'id' | 'slug' | 'fields'>,
  raw: Record<string, unknown>,
  options: {
    selfId?: string;
    applyDefaults?: boolean;
    viewer?: string | null;
    only?: ReadonlySet<string>;
    lenient?: boolean;
    allowedRelationTrackers?: ReadonlySet<string>;
  } = {},
): Promise<Record<string, string | number>> {
  if (usesTrm(tracker.fields)) await ensureTrm(db);
  let existing: ShapeOptions['existing'];
  if (tracker.fields.some((f) => f.unique)) {
    const { data, error } = await db
      .from('tracker_rows')
      .select('id, values')
      .eq('tracker_id', tracker.id)
      .limit(UNIQUE_SCAN_LIMIT);
    if (error) throw error;
    existing = (data ?? []) as Array<{ id: string; values: Record<string, unknown> }>;
  }
  const values = shapeValues(tracker.fields, raw, { ...options, existing });
  for (const field of tracker.fields) {
    const v = values[field.key];
    if (field.type !== 'relation' || v === undefined) continue;
    if (options.only && !options.only.has(field.key)) continue;
    const rel = parseRelationValue(v);
    const target = field.tracker;
    if (!rel || !target) throw new ValidationError(`«${field.label}» no es una relación válida.`);
    if (options.allowedRelationTrackers && !options.allowedRelationTrackers.has(target))
      throw new ValidationError(`«${field.label}» apunta a una tabla que aquí no está permitida.`);
    const other = await getTrackerBySlug(db, target);
    if (!other) throw new ValidationError(`La tabla «${target}» de «${field.label}» ya no existe.`);
    const { data, error } = await db
      .from('tracker_rows')
      .select('id, label')
      .eq('id', rel.id)
      .eq('tracker_id', other.id)
      .maybeSingle();
    if (error) throw error;
    if (!data)
      throw new ValidationError(`«${field.label}»: esa fila no existe en «${other.name}».`);
    values[field.key] = JSON.stringify({
      id: rel.id,
      label: String((data as { label: string }).label),
    });
  }
  // Lookups: lo que traen las filas relacionadas, y las fórmulas que los usan.
  if (lookupSources(tracker.fields).length > 0) {
    const related = await loadRelated(db, tracker.fields, values);
    const changedVia = new Set(
      lookupSources(tracker.fields)
        .map((s) => s.via)
        .filter((via) => options.only?.has(via)),
    );
    let filled = fillLookups(tracker.fields, values, related, { changedVia });
    // Lookups ENCADENADOS: una relación que el primer paso acaba de traer del padre
    // (cliente → su tarifa por defecto) es la vía de otros lookups (tarifa → precio):
    // se valida que la fila copiada siga existiendo y se hace una segunda pasada.
    const chained = lookupSources(tracker.fields).filter(
      (s) => s.field.type === 'relation' && filled[s.field.key] !== values[s.field.key],
    );
    if (chained.length > 0) {
      const next = { ...filled } as Record<string, string | number>;
      const newVia = new Set<string>();
      for (const s of chained) {
        const key = s.field.key;
        const rel = relationParts(next[key]);
        const other = s.field.tracker ? await getTrackerBySlug(db, s.field.tracker) : null;
        let row: { label: unknown } | null = null;
        if (rel && other) {
          const { data, error } = await db
            .from('tracker_rows')
            .select('label')
            .eq('id', rel.id)
            .eq('tracker_id', other.id)
            .maybeSingle();
          if (error) throw error;
          row = data as { label: unknown } | null;
        }
        if (rel && row) {
          next[key] = JSON.stringify({ id: rel.id, label: String(row.label) });
          newVia.add(key);
        } else if (values[key] === undefined) delete next[key];
        else next[key] = values[key] as string | number;
      }
      if (newVia.size > 0) {
        const related2 = await loadRelated(db, tracker.fields, next);
        filled = fillLookups(tracker.fields, next, related2, {
          changedVia: new Set([...changedVia, ...newVia]),
        });
      } else filled = next;
    }
    return recompute(tracker.fields, filled as Record<string, string | number>);
  }
  return values;
}

/** Vuelve a calcular las fórmulas de unos valores ya armados (los lookups pueden haberlas cambiado). */
function recompute(
  fields: TrackerField[],
  values: Record<string, string | number>,
): Record<string, string | number> {
  if (!fields.some((f) => f.formula)) return values;
  const hidden = fields.filter((f) => f.formula && !visibleKeys(fields, values).has(f.key));
  const next = applyComputed(fields, values).values as Record<string, string | number>;
  for (const f of hidden) delete next[f.key];
  return next;
}

/** Las filas relacionadas de cada lookup, leídas una vez por relación (null = ya no existe). */
async function loadRelated(
  db: SupabaseClient,
  fields: TrackerField[],
  values: Record<string, unknown>,
  cache: Map<string, Record<string, unknown> | null> = new Map(),
): Promise<Record<string, Record<string, unknown> | null | undefined>> {
  const out: Record<string, Record<string, unknown> | null | undefined> = {};
  for (const s of lookupSources(fields)) {
    if (s.via in out) continue;
    const rel = relationParts(values[s.via]);
    if (!rel) continue;
    if (!cache.has(rel.id)) {
      const { data, error } = await db
        .from('tracker_rows')
        .select('values')
        .eq('id', rel.id)
        .maybeSingle();
      if (error) {
        out[s.via] = undefined;
        continue;
      }
      cache.set(rel.id, data ? ((data as { values: Record<string, unknown> }).values ?? {}) : null);
    }
    out[s.via] = cache.get(rel.id);
  }
  return out;
}

/** Cada lookup tiene que apuntar a un campo que existe en la tabla relacionada. */
async function assertLookupTargets(
  db: SupabaseClient,
  slug: string,
  fields: TrackerField[],
): Promise<void> {
  for (const s of lookupSources(fields)) {
    const rel = fields.find((f) => f.key === s.via);
    if (!rel?.tracker) continue; // computedProblems ya lo rechazó
    if (rel.tracker === slug) {
      if (!fields.some((f) => f.key === s.target))
        throw new ValidationError(
          `Lookup de «${s.field.label}»: la tabla no tiene un campo «${s.target}».`,
        );
      continue;
    }
    const other = await getTrackerBySlug(db, rel.tracker);
    if (!other)
      throw new ValidationError(
        `Lookup de «${s.field.label}»: la tabla «${rel.tracker}» no existe.`,
      );
    if (!other.fields.some((f) => f.key === s.target))
      throw new ValidationError(
        `Lookup de «${s.field.label}»: «${other.name}» no tiene un campo «${s.target}». Sus campos: ${other.fields.map((f) => f.key).join(', ')}.`,
      );
    if (s.field.type === 'relation') {
      const tf = other.fields.find((f) => f.key === s.target);
      if (tf && (tf.type !== 'relation' || tf.tracker !== s.field.tracker))
        throw new ValidationError(
          `Lookup de «${s.field.label}»: «${tf.label}» de «${other.name}» tiene que ser una relación a «${s.field.tracker}».`,
        );
    }
  }
}

/** «Buscar en una lista» contra una tabla del espacio: que exista y tenga las columnas. */
async function assertMatchSources(
  db: SupabaseClient,
  slug: string,
  fields: TrackerField[],
): Promise<void> {
  for (const f of fields) {
    const m = f.match;
    if (!m || m.source.startsWith('cortex.')) continue;
    const cols = [m.key, ...Object.values(m.fills)];
    const other = m.source === slug ? { name: 'esta tabla', fields } : await getTrackerBySlug(db, m.source);
    if (!other)
      throw new ValidationError(
        `Buscar en lista de «${f.label}»: la tabla «${m.source}» no existe (ni es una lista de la plataforma: ${referenceListsGrammar()}).`,
      );
    const missing = cols.filter((c) => !other.fields.some((x) => x.key === c));
    if (missing.length)
      throw new ValidationError(
        `Buscar en lista de «${f.label}»: ${other.name} no tiene ${missing.length === 1 ? 'el campo' : 'los campos'} ${missing.map((c) => `«${c}»`).join(', ')}. Sus campos: ${other.fields.map((x) => x.key).join(', ')}.`,
      );
  }
}

const RECOMPUTE_MAX_ROWS = 5000;
const RECOMPUTE_PAGE = 500;

/**
 * Cambió una fórmula (o un lookup): se recalcula en las filas que ya existen.
 * Sólo se escribe donde el valor cambia, sin tocar `updated_at`. Tope de filas
 * para que una tabla enorme no deje la petición colgada; lo que pase del tope
 * se recalcula la próxima vez que se edite la fila.
 */
export async function recomputeRows(
  db: SupabaseClient,
  tracker: Pick<TrackerRow, 'id' | 'fields'>,
  keys: string[],
): Promise<{ checked: number; changed: number }> {
  const only = new Set(keys);
  if (usesTrm(tracker.fields)) await ensureTrm(db);
  const cache = new Map<string, Record<string, unknown> | null>();
  const hasLookups = lookupSources(tracker.fields).some((s) => only.has(s.field.key));
  let checked = 0;
  let changed = 0;
  for (let from = 0; from < RECOMPUTE_MAX_ROWS; from += RECOMPUTE_PAGE) {
    const { data, error } = await db
      .from('tracker_rows')
      .select('id, values')
      .eq('tracker_id', tracker.id)
      .order('created_at', { ascending: true })
      .range(from, from + RECOMPUTE_PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as Array<{ id: string; values: Record<string, string | number> }>;
    const updates: Array<{ id: string; values: Record<string, string | number> }> = [];
    for (const row of rows) {
      checked += 1;
      let next = { ...(row.values ?? {}) };
      if (hasLookups) {
        const related = await loadRelated(db, tracker.fields, next, cache);
        next = fillLookups(tracker.fields, next, related, {
          changedVia: new Set(lookupSources(tracker.fields).map((s) => s.via)),
        }) as Record<string, string | number>;
      }
      next = applyComputed(tracker.fields, next).values as Record<string, string | number>;
      if (keys.some((k) => String(next[k] ?? '') !== String(row.values?.[k] ?? '')))
        updates.push({ id: row.id, values: next });
    }
    for (let i = 0; i < updates.length; i += 20) {
      await Promise.all(
        updates.slice(i, i + 20).map(async (u) => {
          const { error: upErr } = await db
            .from('tracker_rows')
            .update({ values: u.values })
            .eq('id', u.id)
            .eq('tracker_id', tracker.id);
          if (upErr) throw upErr;
          changed += 1;
        }),
      );
    }
    if (rows.length < RECOMPUTE_PAGE) break;
  }
  return { checked, changed };
}

export async function upsertRow(
  db: SupabaseClient,
  input: {
    tracker: TrackerRow;
    rowId?: string;
    values: Record<string, unknown>;
    label?: string;
    /** Quién escribe; `null` para lo que hace una automatización sin dueño. */
    userId: string | null;
    /** Escrituras automáticas (consultas programadas): las reglas del campo no bloquean. */
    lenient?: boolean;
    /** Edición parcial: las reglas sólo se juzgan en estos campos. */
    only?: ReadonlySet<string>;
  },
): Promise<TrackerEntryRow> {
  const values = await prepareValues(db, input.tracker, input.values, {
    selfId: input.rowId,
    applyDefaults: !input.rowId,
    lenient: input.lenient,
    only: input.only,
  });
  // Tabla que viene de una integración (0237): los campos del origen y las
  // filas nuevas a mano se rechazan aquí, el único punto de escritura.
  if (isSyncedTable(input.tracker)) {
    let before: Record<string, unknown> | null = null;
    let externalKey: string | null | undefined;
    if (input.rowId) {
      const { data: cur } = await db
        .from('tracker_rows')
        .select('values, external_key')
        .eq('id', input.rowId)
        .eq('tracker_id', input.tracker.id)
        .maybeSingle();
      before = ((cur as { values?: Record<string, unknown> } | null)?.values ?? {}) as Record<
        string,
        unknown
      >;
      externalKey = (cur as { external_key?: string | null } | null)?.external_key ?? null;
    }
    assertRowWriteAllowed(input.tracker, {
      creating: !input.rowId,
      before,
      after: values,
      externalKey,
    });
  }
  // Flujo por estados: el salto tiene que existir, el rol poder y los requisitos cumplirse.
  if (flowOf(input.tracker.fields)) {
    let prior: Record<string, unknown> | null = null;
    if (input.rowId) {
      const { data: cur } = await db
        .from('tracker_rows')
        .select('values')
        .eq('id', input.rowId)
        .eq('tracker_id', input.tracker.id)
        .maybeSingle();
      prior = ((cur as { values?: Record<string, unknown> } | null)?.values ?? {}) as Record<
        string,
        unknown
      >;
    }
    Object.assign(values, guardFlowWrite(input.tracker, prior, values));
  }
  const label = rowLabel(input.tracker.fields, values, input.label);
  // Automatizaciones (0210): una consulta indexada y recordada; sin reglas que
  // miren esta tabla, no se lee nada más.
  const watched = await watchesTracker(db, input.tracker.id);
  const actor = { kind: 'member' as const, id: input.userId };

  if (input.rowId) {
    let before: Record<string, string | number> | null = null;
    if (watched) {
      const { data: prior } = await db
        .from('tracker_rows')
        .select('values')
        .eq('id', input.rowId)
        .eq('tracker_id', input.tracker.id)
        .maybeSingle();
      before = ((prior as { values?: Record<string, string | number> } | null)?.values ??
        null) as Record<string, string | number> | null;
    }
    const { data, error } = await db
      .from('tracker_rows')
      .update({
        label,
        values,
        updated_at: new Date().toISOString(),
      })
      .eq('id', input.rowId)
      .eq('tracker_id', input.tracker.id)
      .select(TRACKER_ROW_COLUMNS)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new NotFoundError('Esa fila no está en esta tabla.');
    // La clave pudo cambiar: se revisa la tabla entera (guía vieja y nueva).
    const saved = adaptEntry(data as Record<string, unknown>);
    const final = await withDuplicates(db, input.tracker.id, saved);
    if (watched && JSON.stringify(before ?? {}) !== JSON.stringify(final.values))
      await emitAutomationEvent(db, {
        kind: 'row_updated',
        trackerId: input.tracker.id,
        trackerSlug: input.tracker.slug,
        rowId: final.id,
        before,
        after: final.values,
        label: final.label,
        version: final.updated_at,
        actor,
      });
    return final;
  }

  const { data, error } = await db
    .from('tracker_rows')
    .insert({
      tracker_id: input.tracker.id,
      label,
      values,
      created_by: input.userId,
    })
    .select(TRACKER_ROW_COLUMNS)
    .single();
  if (error) throw error;
  const inserted = adaptEntry(data as Record<string, unknown>);
  const final = await withDuplicates(db, input.tracker.id, inserted, [inserted.values]);
  if (watched)
    await emitAutomationEvent(db, {
      kind: 'row_created',
      trackerId: input.tracker.id,
      trackerSlug: input.tracker.slug,
      rowId: final.id,
      after: final.values,
      label: final.label,
      version: final.created_at,
      actor,
    });
  return final;
}

/**
 * Aplica la regla de duplicados y devuelve la fila como quedó (con su marca):
 * el llamador (chat, grilla, trabajo del equipo) muestra lo que hay en la base,
 * no lo que mandó.
 */
async function withDuplicates(
  db: SupabaseClient,
  trackerId: string,
  row: TrackerEntryRow,
  touched?: TouchedKey[],
): Promise<TrackerEntryRow> {
  const outcome = await applyDuplicateRule(db, trackerId, touched);
  if (!outcome.changed) return row;
  const { data } = await db
    .from('tracker_rows')
    .select(TRACKER_ROW_COLUMNS)
    .eq('id', row.id)
    .maybeSingle();
  return data ? adaptEntry(data as Record<string, unknown>) : row;
}

export async function queryRows(
  db: SupabaseClient,
  input: {
    trackerId: string;
    equals?: { key: string; value: string };
    limit: number;
  },
): Promise<TrackerEntryRow[]> {
  let q = db
    .from('tracker_rows')
    .select(TRACKER_ROW_COLUMNS)
    .eq('tracker_id', input.trackerId)
    .order('updated_at', { ascending: false })
    .limit(input.limit);

  if (input.equals) {
    q = q.contains('values', { [input.equals.key]: input.equals.value });
  }

  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []).map((row) => adaptEntry(row as Record<string, unknown>));
}

export async function removeRow(
  db: SupabaseClient,
  trackerId: string,
  rowId: string,
  options: { slug?: string; userId?: string | null } = {},
): Promise<boolean> {
  const removed = await removeRows(db, { id: trackerId, slug: options.slug }, [rowId], options);
  return removed.length > 0;
}

/**
 * Borra filas (por id) y avisa a las automatizaciones («Se borra una fila»):
 * el suceso lleva los valores que tenía la fila, que ya no existe. Devuelve los
 * ids que de verdad se borraron. Una consulta indexada, y sin reglas que miren
 * la tabla no se lee nada más.
 */
export async function removeRows(
  db: SupabaseClient,
  tracker: { id: string; slug?: string },
  rowIds: string[],
  options: { userId?: string | null } = {},
): Promise<string[]> {
  if (!rowIds.length) return [];
  const watched = await watchesTracker(db, tracker.id);
  let prior = new Map<string, { label: string; values: Record<string, string | number> }>();
  if (watched) {
    const { data } = await db
      .from('tracker_rows')
      .select('id, label, values')
      .eq('tracker_id', tracker.id)
      .in('id', rowIds);
    prior = new Map(
      (
        (data ?? []) as Array<{
          id: string;
          label: string;
          values: Record<string, string | number>;
        }>
      ).map((r) => [r.id, { label: r.label, values: r.values ?? {} }]),
    );
  }
  const { data, error } = await db
    .from('tracker_rows')
    .delete()
    .eq('tracker_id', tracker.id)
    .in('id', rowIds)
    .select('id');
  if (error) throw error;
  const removed = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
  // Borrar una de las dos guías repetidas resuelve el conflicto de la otra.
  if (removed.length) await applyDuplicateRule(db, tracker.id);
  if (watched) {
    const version = new Date().toISOString();
    for (const id of removed) {
      const p = prior.get(id);
      if (!p) continue;
      await emitAutomationEvent(db, {
        kind: 'row_deleted',
        trackerId: tracker.id,
        trackerSlug: tracker.slug,
        rowId: id,
        before: p.values,
        after: p.values,
        label: p.label,
        version,
        actor: { kind: 'member', id: options.userId ?? null },
      });
    }
  }
  return removed;
}
