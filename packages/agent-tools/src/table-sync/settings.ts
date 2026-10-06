import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { FIELD_KEY_RE } from '../trackers/schema';

/**
 * LO QUE SE AJUSTA A MANO DE UNA SINCRONIZACIÓN (pantalla «Campos y reglas»).
 *
 * Crear una sincronización sigue siendo cosa del chat (hay que elegir fuente,
 * hoja o carpeta); aquí sólo se cambia lo que ya existe: si corre, cada cuánto,
 * si avisa en la campana, qué columnas la identifican (`key_fields`) y, en la
 * de Drive, las instrucciones de lectura. El parche se valida aquí —no en la
 * pantalla— porque la pantalla es una sugerencia: el servidor es el que manda.
 */

export const SYNC_MIN_INTERVAL = 5;
export const SYNC_MAX_INTERVAL = 1440;
export const SYNC_INSTRUCTIONS_MAX = 1000;
export const SYNC_KEY_FIELDS_MAX = 5;

export const syncPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    intervalMinutes: z
      .number()
      .int('Cada cuánto tiene que ser un número entero de minutos.')
      .min(SYNC_MIN_INTERVAL, `Cada cuánto: mínimo ${SYNC_MIN_INTERVAL} minutos.`)
      .max(SYNC_MAX_INTERVAL, `Cada cuánto: máximo ${SYNC_MAX_INTERVAL} minutos (un día).`)
      .optional(),
    notify: z.boolean().optional(),
    keyFields: z.array(z.string().regex(FIELD_KEY_RE)).max(SYNC_KEY_FIELDS_MAX).optional(),
    /** Sólo la carpeta de Drive. */
    instructions: z.string().max(SYNC_INSTRUCTIONS_MAX).optional(),
  })
  .strict();
export type SyncPatch = z.infer<typeof syncPatchSchema>;

type SyncKind = 'table_sync' | 'drive_folder';
const TABLE: Record<SyncKind, string> = {
  table_sync: 'tracker_syncs',
  drive_folder: 'drive_folder_syncs',
};

export interface SyncSettings {
  id: string;
  kind: SyncKind;
  trackerId: string;
  enabled: boolean;
  intervalMinutes: number;
  notify: boolean;
  keyFields: string[];
  /** Sólo Drive. */
  instructions: string;
  /** Sólo Drive: los campos que se leen del documento. */
  extractKeys: string[];
  /** Sólo hoja: los campos que se llenan, con su columna de origen. */
  mapping: Record<string, string>;
  lastRunAt: string | null;
}

/** Los ajustes completos de las sincronizaciones de UNA tabla (hoja y carpeta). */
export async function readSyncSettings(
  db: SupabaseClient,
  trackerId: string,
): Promise<SyncSettings[]> {
  const [sheet, drive] = await Promise.all([
    db
      .from('tracker_syncs')
      .select('id, tracker_id, enabled, interval_minutes, notify, key_fields, mapping, last_run_at')
      .eq('tracker_id', trackerId),
    db
      .from('drive_folder_syncs')
      .select(
        'id, tracker_id, enabled, interval_minutes, notify, key_fields, instructions, extract_fields, last_run_at',
      )
      .eq('tracker_id', trackerId),
  ]);
  if (sheet.error) throw sheet.error;
  if (drive.error) throw drive.error;
  const out: SyncSettings[] = [];
  for (const r of (sheet.data ?? []) as Array<Record<string, unknown>>)
    out.push({
      id: String(r.id),
      kind: 'table_sync',
      trackerId: String(r.tracker_id),
      enabled: Boolean(r.enabled),
      intervalMinutes: Number(r.interval_minutes),
      notify: Boolean(r.notify),
      keyFields: (r.key_fields as string[] | null) ?? [],
      instructions: '',
      extractKeys: [],
      mapping: (r.mapping as Record<string, string> | null) ?? {},
      lastRunAt: (r.last_run_at as string | null) ?? null,
    });
  for (const r of (drive.data ?? []) as Array<Record<string, unknown>>)
    out.push({
      id: String(r.id),
      kind: 'drive_folder',
      trackerId: String(r.tracker_id),
      enabled: Boolean(r.enabled),
      intervalMinutes: Number(r.interval_minutes),
      notify: Boolean(r.notify),
      keyFields: (r.key_fields as string[] | null) ?? [],
      instructions: String(r.instructions ?? ''),
      extractKeys: ((r.extract_fields as Array<{ key: string }> | null) ?? []).map((e) => e.key),
      mapping: {},
      lastRunAt: (r.last_run_at as string | null) ?? null,
    });
  return out;
}

/**
 * Aplica un parche a una sincronización. `fieldKeys` son los campos que la
 * tabla tiene HOY: una columna clave que no es un campo de la tabla rompería la
 * identidad de cada fila (todas se verían nuevas y se duplicarían).
 */
async function updateSync(
  db: SupabaseClient,
  kind: SyncKind,
  syncId: string,
  rawPatch: unknown,
  fieldKeys: string[],
): Promise<SyncSettings> {
  const parsed = syncPatchSchema.safeParse(rawPatch);
  if (!parsed.success)
    throw new ValidationError(parsed.error.issues[0]?.message ?? 'Esos ajustes no son válidos.');
  const patch = parsed.data;
  if (patch.instructions !== undefined && kind !== 'drive_folder')
    throw new ValidationError(
      'Sólo la sincronización de una carpeta de Drive tiene instrucciones.',
    );
  if (patch.keyFields) {
    if (!patch.keyFields.length)
      throw new ValidationError(
        'Elige al menos una columna clave: sin ella cada vuelta crearía las filas otra vez.',
      );
    const unknown = patch.keyFields.filter((k) => !fieldKeys.includes(k));
    if (unknown.length)
      throw new ValidationError(
        `Columna clave que la tabla no tiene: ${unknown.join(', ')}. Campos: ${fieldKeys.join(', ')}.`,
      );
    if (new Set(patch.keyFields).size !== patch.keyFields.length)
      throw new ValidationError('Hay una columna clave repetida.');
  }

  const table = TABLE[kind];
  const { data: current, error: readError } = await db
    .from(table)
    .select('id, tracker_id, enabled, interval_minutes, last_run_at')
    .eq('id', syncId)
    .maybeSingle();
  if (readError) throw readError;
  if (!current) throw new NotFoundError('Esa sincronización ya no existe.');
  const row = current as {
    tracker_id: string;
    enabled: boolean;
    interval_minutes: number;
    last_run_at: string | null;
  };

  const update: Record<string, unknown> = {};
  if (patch.enabled !== undefined) update.enabled = patch.enabled;
  if (patch.notify !== undefined) update.notify = patch.notify;
  if (patch.keyFields !== undefined) update.key_fields = patch.keyFields;
  if (patch.instructions !== undefined) update.instructions = patch.instructions.trim();
  if (patch.intervalMinutes !== undefined) update.interval_minutes = patch.intervalMinutes;
  // La próxima corrida se recalcula cuando cambia el ritmo o se reanuda: desde
  // la última vez que corrió (o ahora), nunca en el pasado.
  const resumed = patch.enabled === true && !row.enabled;
  if (patch.intervalMinutes !== undefined || resumed) {
    const every = patch.intervalMinutes ?? row.interval_minutes;
    const base = row.last_run_at ? new Date(row.last_run_at).getTime() : Date.now();
    update.next_run_at = new Date(Math.max(Date.now(), base + every * 60_000)).toISOString();
  }
  if (!Object.keys(update).length) throw new ValidationError('No hay nada que cambiar.');

  const { error } = await db.from(table).update(update).eq('id', syncId);
  if (error) throw error;
  const all = await readSyncSettings(db, row.tracker_id);
  const found = all.find((s) => s.id === syncId && s.kind === kind);
  if (!found) throw new NotFoundError('Esa sincronización ya no existe.');
  return found;
}

export function updateTrackerSync(
  db: SupabaseClient,
  syncId: string,
  patch: unknown,
  fieldKeys: string[],
): Promise<SyncSettings> {
  return updateSync(db, 'table_sync', syncId, patch, fieldKeys);
}

export function updateDriveFolderSync(
  db: SupabaseClient,
  syncId: string,
  patch: unknown,
  fieldKeys: string[],
): Promise<SyncSettings> {
  return updateSync(db, 'drive_folder', syncId, patch, fieldKeys);
}

/**
 * Al quitar campos de una tabla, lo que las sincronizaciones guardan sobre
 * ellos se limpia (mapeo de la hoja, campos a leer y valores fijos de Drive).
 * Las columnas CLAVE no se limpian: quitar una es bloqueado antes, porque
 * cambiaría la identidad de las filas.
 */
export async function pruneSyncFields(
  db: SupabaseClient,
  trackerId: string,
  removed: string[],
): Promise<void> {
  if (!removed.length) return;
  const drop = new Set(removed);
  const settings = await readSyncSettings(db, trackerId);
  for (const s of settings) {
    if (s.kind === 'table_sync') {
      const mapping = Object.fromEntries(Object.entries(s.mapping).filter(([k]) => !drop.has(k)));
      if (Object.keys(mapping).length !== Object.keys(s.mapping).length)
        await db.from('tracker_syncs').update({ mapping }).eq('id', s.id);
    } else {
      const { data } = await db
        .from('drive_folder_syncs')
        .select('extract_fields, defaults')
        .eq('id', s.id)
        .maybeSingle();
      const row = data as {
        extract_fields: Array<{ key: string }>;
        defaults: Record<string, unknown>;
      } | null;
      if (!row) continue;
      const extract = (row.extract_fields ?? []).filter((e) => !drop.has(e.key));
      const defaults = Object.fromEntries(
        Object.entries(row.defaults ?? {}).filter(([k]) => !drop.has(k)),
      );
      await db
        .from('drive_folder_syncs')
        .update({ extract_fields: extract, defaults })
        .eq('id', s.id);
    }
  }
}
