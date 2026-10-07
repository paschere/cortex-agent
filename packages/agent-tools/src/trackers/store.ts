import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { emitAutomationEvent, watchesTracker } from '../apps/automations/emit';
import {
  type DuplicateRule,
  type TouchedKey,
  applyDuplicateRule,
  getDuplicateRule,
  validateDuplicateRule,
} from './duplicates';
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
  'id, slug, name, description, fields, created_by, created_at, updated_at';
export const TRACKER_ROW_COLUMNS =
  'id, tracker_id, label, values, created_by, created_at, updated_at';

export interface TrackerRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  fields: TrackerField[];
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
  },
): Promise<{ tracker: TrackerRow; created: boolean }> {
  if (input.duplicates) {
    const problem = validateDuplicateRule(input.duplicates, input.fields);
    if (problem) throw new ValidationError(`Regla de duplicados: ${problem}`);
  }
  const withRule = input.duplicates === undefined ? {} : { duplicates: input.duplicates };
  const reapply = async (tracker: TrackerRow) => {
    // Una regla nueva o cambiada se aplica a lo que la tabla ya tiene.
    if (input.duplicates) await applyDuplicateRule(db, tracker.id);
    else if (input.duplicates === null) await clearDuplicateFlags(db, tracker.id);
    return tracker;
  };
  const existing = await getTrackerBySlug(db, input.slug);
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
  const values: Record<string, string | number> = {};
  for (const field of fields) {
    if (!visible.has(field.key)) continue;
    const coerced = coerceValue(field, raw[field.key]);
    if (!coerced.ok) throw new ValidationError(coerced.message);
    if (coerced.value !== '') values[field.key] = coerced.value;
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
  return values;
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
): Promise<boolean> {
  const { data, error } = await db
    .from('tracker_rows')
    .delete()
    .eq('id', rowId)
    .eq('tracker_id', trackerId)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  // Borrar una de las dos guías repetidas resuelve el conflicto de la otra.
  if (data) await applyDuplicateRule(db, trackerId);
  return Boolean(data);
}
