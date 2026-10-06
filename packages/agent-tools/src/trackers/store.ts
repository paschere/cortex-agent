import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type DuplicateRule,
  type TouchedKey,
  applyDuplicateRule,
  getDuplicateRule,
  validateDuplicateRule,
} from './duplicates';
import { type TrackerField, coerceValue, rowLabel, trackerFieldsSchema } from './schema';

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

export function shapeValues(
  fields: TrackerField[],
  raw: Record<string, unknown>,
): Record<string, string | number> {
  const values: Record<string, string | number> = {};
  const unknown = Object.keys(raw).filter((key) => !fields.some((f) => f.key === key));
  if (unknown.length > 0) {
    throw new ValidationError(`Estos campos no existen en la tabla: ${unknown.join(', ')}.`);
  }
  for (const field of fields) {
    const coerced = coerceValue(field, raw[field.key]);
    if (!coerced.ok) throw new ValidationError(coerced.message);
    if (coerced.value !== '') values[field.key] = coerced.value;
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
    userId: string;
  },
): Promise<TrackerEntryRow> {
  const values = shapeValues(input.tracker.fields, input.values);
  const label = rowLabel(input.tracker.fields, values, input.label);

  if (input.rowId) {
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
    return withDuplicates(db, input.tracker.id, saved);
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
  return withDuplicates(db, input.tracker.id, inserted, [inserted.values]);
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
