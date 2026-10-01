import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { generateObject } from 'ai';
import type { ZodTypeAny } from 'zod';
import { driveGet, driveGetBytes, driveGetText } from '../gdrive/client';
import { parseDocument } from '../kb/parsers';
import { XLSX_MIME } from '../kb/spreadsheets';
import { utilityModel } from '../model';
import { type TrackerField, rowLabel } from '../trackers/schema';
import { type TrackerRow, getTrackerById } from '../trackers/store';
import type { ToolContext } from '../types';
import {
  type ExtractField,
  type ExtractionOutput,
  FILES_PER_RUN,
  type FolderFile,
  type LedgerEntry,
  MAX_PROMPT_CHARS,
  type PlannedFileRow,
  type RunTotals,
  extractionPrompt,
  extractionSchema,
  extractionSystem,
  findReviewField,
  mergeRowValues,
  nextAttempts,
  pickFiles,
  planFileRows,
  sameValues,
} from './plan';

/**
 * UNA CARPETA DE DRIVE QUE LLENA UNA TABLA (migración 0162) — el motor.
 *
 * Una corrida, en cuatro pasos que el trabajo programado
 * (apps/web/inngest/functions/drive-table.ts) hace cada uno en su `step.run`:
 *
 *   1. `claimDriveFolderSync` — la toma. Corre el `next_run_at` al siguiente
 *      intervalo SÓLO si ya tocaba; si otra corrida la tomó primero (el cron y
 *      la primera carga que pidió la herramienta, a la vez), ésta no hace nada.
 *   2. `prepareDriveFolderRun` — lista la carpeta con las credenciales de quien
 *      la conectó y decide qué archivos se leen: los nuevos, los que cambiaron
 *      de revisión y los que fallaron por algo pasajero. Diez por corrida.
 *   3. `processDriveFile` — un archivo: bajarlo (o exportarlo, si es nativo de
 *      Google), sacar el texto con los mismos lectores de Brain Knowledge,
 *      pedirle al modelo los campos con su cita, creer sólo lo que la cita
 *      respalda (plan.ts), escribir las filas por clave y anotar el archivo en
 *      el libro. Un archivo que falla no tumba a los demás.
 *   4. `markDriveFolderRun` — el resultado de la corrida, visible en
 *      `trackers.drive_syncs`.
 *
 * El texto del documento es DATO. Va delimitado en el mensaje del usuario, y
 * las instrucciones del sistema dicen que no se obedece; además, nada de lo
 * que el modelo responda puede hacer otra cosa que llenar campos de esta tabla.
 */

export type DriveAccess = Pick<ToolContext, 'integrations' | 'signal'>;

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_FOLDER_FILES = 2000;

export interface DriveFolderSyncRow {
  id: string;
  organization_id?: string;
  created_by: string;
  folder_id: string;
  folder_name: string;
  tracker_id: string;
  extract_fields: ExtractField[];
  key_fields: string[];
  defaults: Record<string, string | number>;
  instructions: string;
  interval_minutes: number;
  notify: boolean;
  enabled: boolean;
  next_run_at: string;
  last_run_at: string | null;
  last_status: 'ok' | 'error' | null;
  last_error: string | null;
  last_files: number;
  last_inserted: number;
  last_updated: number;
  last_needs_review: number;
  last_failed: number;
}

export const DRIVE_SYNC_COLUMNS =
  'id, created_by, folder_id, folder_name, tracker_id, extract_fields, key_fields, defaults, instructions, interval_minutes, notify, enabled, next_run_at, last_run_at, last_status, last_error, last_files, last_inserted, last_updated, last_needs_review, last_failed';

// ---------------------------------------------------------------------------
// Drive
// ---------------------------------------------------------------------------

function api(drive: DriveAccess): ToolContext {
  return drive as ToolContext;
}

export async function driveFolderMeta(
  drive: DriveAccess,
  folderId: string,
): Promise<{ id: string; name: string }> {
  const meta = await driveGet<{ id: string; name: string; mimeType: string; trashed?: boolean }>(
    api(drive),
    `/files/${encodeURIComponent(folderId)}`,
    { fields: 'id,name,mimeType,trashed', supportsAllDrives: 'true' },
  );
  if (meta.mimeType !== FOLDER_MIME)
    throw new ValidationError(`«${meta.name}» no es una carpeta de Drive.`);
  if (meta.trashed) throw new ValidationError(`La carpeta «${meta.name}» está en la papelera.`);
  return { id: meta.id, name: meta.name };
}

export async function findDriveFolders(
  drive: DriveAccess,
  name: string,
): Promise<Array<{ id: string; name: string }>> {
  const safe = name.replace(/\\/g, '').replace(/'/g, "\\'");
  const r = await driveGet<{ files?: Array<{ id: string; name: string }> }>(api(drive), '/files', {
    q: `mimeType = '${FOLDER_MIME}' and name contains '${safe}' and trashed = false`,
    fields: 'files(id,name)',
    pageSize: '10',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  });
  return r.files ?? [];
}

/** Los archivos de la carpeta (sin subcarpetas), con su revisión. */
export async function listFolderFiles(drive: DriveAccess, folderId: string): Promise<FolderFile[]> {
  const out: FolderFile[] = [];
  let pageToken: string | undefined;
  do {
    const params: Record<string, string> = {
      q: `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false and mimeType != '${FOLDER_MIME}'`,
      fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,md5Checksum,size)',
      orderBy: 'modifiedTime desc',
      pageSize: '1000',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    };
    if (pageToken) params.pageToken = pageToken;
    const page = await driveGet<{
      nextPageToken?: string;
      files?: Array<{
        id: string;
        name: string;
        mimeType: string;
        modifiedTime?: string;
        md5Checksum?: string;
        size?: string;
      }>;
    }>(api(drive), '/files', params);
    for (const f of page.files ?? []) {
      out.push({
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        // Lo mismo que drive-sync: un documento nativo de Google no tiene md5.
        revision: f.md5Checksum ?? f.modifiedTime ?? '',
        modifiedTime: f.modifiedTime ?? null,
        size: f.size ? Number(f.size) : null,
      });
    }
    pageToken = page.nextPageToken;
  } while (pageToken && out.length < MAX_FOLDER_FILES);
  return out;
}

/** Un archivo que no se va a poder leer por más que se reintente. */
export class UnreadableFileError extends Error {}

const READABLE_MIMES = new Set([
  'application/pdf',
  XLSX_MIME,
  'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
]);

/** El texto de un archivo de Drive, con los mismos lectores que Brain Knowledge. */
export async function driveFileText(
  drive: DriveAccess,
  file: Pick<FolderFile, 'id' | 'name' | 'mimeType' | 'size'>,
): Promise<{ text: string; truncated: boolean }> {
  const enc = encodeURIComponent(file.id);
  let text: string;
  if (file.mimeType === 'application/vnd.google-apps.spreadsheet') {
    // xlsx y no csv: el csv de Google sólo exporta la primera hoja.
    const bytes = await driveGetBytes(api(drive), `/files/${enc}/export`, { mimeType: XLSX_MIME });
    text = (await parseDocument(bytes, XLSX_MIME)).text;
  } else if (
    file.mimeType === 'application/vnd.google-apps.document' ||
    file.mimeType === 'application/vnd.google-apps.presentation'
  ) {
    text = await driveGetText(api(drive), `/files/${enc}/export`, { mimeType: 'text/plain' });
  } else if (READABLE_MIMES.has(file.mimeType)) {
    if (file.size && file.size > MAX_FILE_BYTES)
      throw new UnreadableFileError('El archivo pesa más de 20 MB.');
    const bytes = await driveGetBytes(api(drive), `/files/${enc}`, {
      alt: 'media',
      supportsAllDrives: 'true',
    });
    try {
      text = (await parseDocument(bytes, file.mimeType)).text;
    } catch (err) {
      throw new UnreadableFileError(
        `No pude abrir el archivo: ${(err as Error).message.slice(0, 160)}`,
      );
    }
  } else if (file.mimeType.startsWith('image/')) {
    throw new UnreadableFileError('Es una imagen: todavía no leo fotos ni escaneos.');
  } else if (file.mimeType === 'application/vnd.ms-excel') {
    throw new UnreadableFileError('Es un Excel antiguo (.xls): guárdalo como .xlsx.');
  } else {
    throw new UnreadableFileError(`No sé leer este tipo de archivo (${file.mimeType}).`);
  }
  const clean = text.replaceAll('\u0000', '').trim();
  if (clean.replace(/\s/g, '').length < 20)
    throw new UnreadableFileError('El archivo no tiene texto legible (¿un PDF escaneado?).');
  return { text: clean, truncated: clean.length > MAX_PROMPT_CHARS };
}

// ---------------------------------------------------------------------------
// El modelo
// ---------------------------------------------------------------------------

export type DriveRowExtractor = (input: {
  system: string;
  prompt: string;
  schema: ZodTypeAny;
}) => Promise<ExtractionOutput>;

/** La lectura de verdad: el modelo de utilidad, con la forma exacta de la salida. */
export const modelExtractor: DriveRowExtractor = async ({ system, prompt, schema }) => {
  const { object } = await generateObject({
    model: utilityModel(),
    schema,
    system,
    prompt,
    maxTokens: 8000,
    abortSignal: AbortSignal.timeout(120_000),
  });
  return object as ExtractionOutput;
};

// ---------------------------------------------------------------------------
// La corrida
// ---------------------------------------------------------------------------

export async function getDriveFolderSync(
  db: SupabaseClient,
  syncId: string,
): Promise<DriveFolderSyncRow | null> {
  const { data, error } = await db
    .from('drive_folder_syncs')
    .select(DRIVE_SYNC_COLUMNS)
    .eq('id', syncId)
    .maybeSingle();
  if (error) throw error;
  return (data as unknown as DriveFolderSyncRow | null) ?? null;
}

/**
 * La toma: corre `next_run_at` al siguiente intervalo sólo si ya tocaba.
 * Devuelve la fila si esta corrida se la quedó, null si no tocaba o ya la
 * tomó otra.
 */
export async function claimDriveFolderSync(
  db: SupabaseClient,
  syncId: string,
  now = new Date(),
): Promise<DriveFolderSyncRow | null> {
  const sync = await getDriveFolderSync(db, syncId);
  if (!sync?.enabled) return null;
  const { data, error } = await db
    .from('drive_folder_syncs')
    .update({
      next_run_at: new Date(now.getTime() + sync.interval_minutes * 60_000).toISOString(),
    })
    .eq('id', syncId)
    .lte('next_run_at', now.toISOString())
    .select(DRIVE_SYNC_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  return (data as unknown as DriveFolderSyncRow | null) ?? null;
}

export interface PreparedRun {
  tracker: Pick<TrackerRow, 'id' | 'slug' | 'name' | 'description' | 'fields'>;
  files: FolderFile[];
  backlog: number;
  ledger: LedgerEntry[];
}

export async function prepareDriveFolderRun(
  db: SupabaseClient,
  drive: DriveAccess,
  sync: DriveFolderSyncRow,
): Promise<PreparedRun> {
  const tracker = await getTrackerById(db, sync.tracker_id);
  if (!tracker) throw new NotFoundError('La tabla de esta carpeta ya no existe.');
  const files = await listFolderFiles(drive, sync.folder_id);
  const { data, error } = await db
    .from('drive_folder_sync_files')
    .select('file_id, revision, status, attempts')
    .eq('sync_id', sync.id)
    .limit(5000);
  if (error) throw error;
  const ledger = (data ?? []) as LedgerEntry[];
  const picked = pickFiles(files, ledger, FILES_PER_RUN);
  const due = new Set(picked.now.map((f) => f.id));
  return {
    tracker: {
      id: tracker.id,
      slug: tracker.slug,
      name: tracker.name,
      description: tracker.description,
      fields: tracker.fields,
    },
    files: picked.now,
    backlog: picked.backlog,
    ledger: ledger.filter((l) => due.has(l.file_id)),
  };
}

export interface FileResult {
  fileId: string;
  status: 'ok' | 'needs_review' | 'error';
  inserted: number;
  updated: number;
  needsReview: number;
  newLabels: string[];
  error?: string;
}

/** Cómo se nombra una fila: sus campos clave como se leyeron («Proveedor · FE-4471»). */
export function plannedLabel(
  fields: TrackerField[],
  keyFields: string[],
  values: Record<string, string | number>,
  fallback: string,
): string {
  const parts = keyFields.map((k) => values[k]).filter((v) => v !== undefined && v !== '');
  if (parts.length === keyFields.length) return parts.map(String).join(' · ').slice(0, 200);
  const label = rowLabel(fields, values);
  return label === 'Sin nombre' ? fallback.slice(0, 200) : label;
}

async function writeRow(
  db: SupabaseClient,
  input: {
    tracker: PreparedRun['tracker'];
    sync: DriveFolderSyncRow;
    planned: PlannedFileRow;
    fileName: string;
  },
): Promise<{ id: string; action: 'inserted' | 'updated' | 'unchanged'; label: string }> {
  const { tracker, sync, planned } = input;
  const reviewField = findReviewField(tracker.fields);
  const known = new Set(tracker.fields.map((f) => f.key));
  const find = async () => {
    const { data, error } = await db
      .from('tracker_rows')
      .select('id, values')
      .eq('tracker_id', tracker.id)
      .eq('external_key', planned.key)
      .maybeSingle();
    if (error) throw error;
    return data as { id: string; values: Record<string, unknown> } | null;
  };
  const shape = (existing: Record<string, unknown> | null) => {
    const merged = mergeRowValues({ existing, planned, defaults: sync.defaults, reviewField });
    // Un campo que la tabla ya no tiene (lo borraron) no se escribe.
    for (const k of Object.keys(merged)) if (!known.has(k)) delete merged[k];
    return merged;
  };
  const labelOf = (values: Record<string, string | number>) =>
    plannedLabel(
      tracker.fields,
      sync.key_fields,
      values,
      planned.keyMissing ? `Por revisar · ${input.fileName}` : input.fileName,
    );

  const update = async (found: { id: string; values: Record<string, unknown> }) => {
    const values = shape(found.values ?? {});
    const label = labelOf(values);
    if (sameValues(found.values ?? {}, values))
      return { id: found.id, action: 'unchanged' as const, label };
    const { error } = await db
      .from('tracker_rows')
      .update({ label, values, updated_at: new Date().toISOString() })
      .eq('id', found.id)
      .eq('tracker_id', tracker.id);
    if (error) throw error;
    return { id: found.id, action: 'updated' as const, label };
  };

  const found = await find();
  if (found) return update(found);
  const values = shape(null);
  const label = labelOf(values);
  const { data, error } = await db
    .from('tracker_rows')
    .insert({
      tracker_id: tracker.id,
      label,
      values,
      external_key: planned.key,
      created_by: sync.created_by,
    })
    .select('id')
    .single();
  if (error) {
    // Otra corrida la insertó entre la lectura y ésta: se actualiza esa.
    if ((error as { code?: string }).code === '23505') {
      const again = await find();
      if (again) return update(again);
    }
    throw error;
  }
  return { id: (data as { id: string }).id, action: 'inserted', label };
}

/** Un archivo, de punta a punta. Nunca lanza: un archivo que falla queda en el libro. */
export async function processDriveFile(
  db: SupabaseClient,
  drive: DriveAccess,
  input: {
    sync: DriveFolderSyncRow;
    tracker: PreparedRun['tracker'];
    file: FolderFile;
    ledger?: LedgerEntry;
    extractor?: DriveRowExtractor;
  },
): Promise<FileResult> {
  const { sync, tracker, file } = input;
  const extractor = input.extractor ?? modelExtractor;
  const base = { fileId: file.id, inserted: 0, updated: 0, needsReview: 0, newLabels: [] };
  const record = async (row: {
    status: FileResult['status'];
    rowIds?: string[];
    extracted?: unknown[];
    notes?: string[];
    error?: string | null;
    attempts: number;
  }) => {
    const { error } = await db.from('drive_folder_sync_files').upsert(
      {
        sync_id: sync.id,
        file_id: file.id,
        file_name: file.name.slice(0, 300),
        mime_type: file.mimeType.slice(0, 200),
        revision: file.revision.slice(0, 200),
        status: row.status,
        tracker_row_ids: row.rowIds ?? [],
        extracted: row.extracted ?? [],
        notes: (row.notes ?? []).slice(0, 40).map((n) => n.slice(0, 300)),
        error: row.error ? row.error.slice(0, 500) : null,
        attempts: row.attempts,
        processed_at: new Date().toISOString(),
      },
      { onConflict: 'sync_id,file_id' },
    );
    if (error) throw error;
  };

  try {
    const { text, truncated } = await driveFileText(drive, file);
    const extract = sync.extract_fields.filter((e) => tracker.fields.some((f) => f.key === e.key));
    if (!extract.length)
      throw new UnreadableFileError('Ninguno de los campos a leer existe ya en la tabla.');
    const output = await extractor({
      system: extractionSystem({
        tableName: tracker.name,
        tableDescription: tracker.description,
        fields: tracker.fields,
        extract,
        instructions: sync.instructions,
      }),
      prompt: extractionPrompt(file.name, text),
      schema: extractionSchema(tracker.fields, extract),
    });
    const plan = planFileRows({
      output,
      fields: tracker.fields,
      extract,
      keyFields: sync.key_fields,
      documentText: text,
      fileId: file.id,
      truncated,
    });

    const result: FileResult = { ...base, status: 'ok', newLabels: [] };
    const rowIds: string[] = [];
    for (const planned of plan.rows) {
      const written = await writeRow(db, { tracker, sync, planned, fileName: file.name });
      rowIds.push(written.id);
      if (written.action === 'inserted') {
        result.inserted += 1;
        result.newLabels.push(written.label);
      } else if (written.action === 'updated') result.updated += 1;
      if (planned.review.length) result.needsReview += 1;
    }
    const review = plan.notes.length > 0 || plan.rows.some((r) => r.review.length > 0);
    if (!plan.rows.length) result.needsReview += 1;
    result.status = review ? 'needs_review' : 'ok';
    await record({
      status: result.status,
      rowIds,
      extracted: plan.rows.map((r) => ({ key: r.key, values: r.values, review: r.review })),
      notes: [...plan.notes, ...plan.rows.flatMap((r) => r.review)],
      attempts: nextAttempts(input.ledger, file.revision, 'none'),
    });
    return result;
  } catch (err) {
    const permanent = err instanceof UnreadableFileError;
    const message = err instanceof Error ? err.message : 'No se pudo leer el archivo.';
    await record({
      status: 'error',
      error: message,
      attempts: nextAttempts(input.ledger, file.revision, permanent ? 'permanent' : 'transient'),
    }).catch(() => undefined);
    return { ...base, status: 'error', error: message };
  }
}

export function totalsOf(results: FileResult[]): RunTotals {
  return {
    files: results.length,
    inserted: results.reduce((n, r) => n + r.inserted, 0),
    updated: results.reduce((n, r) => n + r.updated, 0),
    needsReview: results.reduce((n, r) => n + r.needsReview, 0),
    failed: results.filter((r) => r.status === 'error').length,
    newLabels: results.flatMap((r) => r.newLabels),
    reviewLabels: [],
  };
}

export async function markDriveFolderRun(
  db: SupabaseClient,
  syncId: string,
  result: { ok: true; totals: RunTotals } | { ok: false; error: string },
): Promise<void> {
  await db
    .from('drive_folder_syncs')
    .update({
      last_run_at: new Date().toISOString(),
      last_status: result.ok ? 'ok' : 'error',
      last_error: result.ok ? null : result.error.slice(0, 500),
      ...(result.ok
        ? {
            last_files: result.totals.files,
            last_inserted: result.totals.inserted,
            last_updated: result.totals.updated,
            last_needs_review: result.totals.needsReview,
            last_failed: result.totals.failed,
          }
        : {}),
    })
    .eq('id', syncId);
}

// ---------------------------------------------------------------------------
// Crear y listar
// ---------------------------------------------------------------------------

export async function upsertDriveFolderSync(
  db: SupabaseClient,
  input: {
    actorId: string;
    folder: { id: string; name: string };
    trackerId: string;
    extract: ExtractField[];
    keyFields: string[];
    defaults: Record<string, string | number>;
    instructions: string;
    intervalMinutes: number;
    notify: boolean;
  },
): Promise<DriveFolderSyncRow> {
  const { data, error } = await db
    .from('drive_folder_syncs')
    .upsert(
      {
        created_by: input.actorId,
        folder_id: input.folder.id,
        folder_name: input.folder.name.slice(0, 200),
        tracker_id: input.trackerId,
        extract_fields: input.extract,
        key_fields: input.keyFields,
        defaults: input.defaults,
        instructions: input.instructions.slice(0, 1000),
        interval_minutes: input.intervalMinutes,
        notify: input.notify,
        enabled: true,
        // La primera lectura, ya: la toma la encuentra vencida.
        next_run_at: new Date().toISOString(),
      },
      { onConflict: 'organization_id,folder_id,tracker_id' },
    )
    .select(DRIVE_SYNC_COLUMNS)
    .single();
  if (error) throw error;
  return data as unknown as DriveFolderSyncRow;
}

export interface DriveSyncListing extends DriveFolderSyncRow {
  tracker: { slug: string; name: string } | null;
  problems: Array<{ file_name: string; status: string; notes: string[]; error: string | null }>;
}

export async function listDriveFolderSyncs(db: SupabaseClient): Promise<DriveSyncListing[]> {
  const { data, error } = await db
    .from('drive_folder_syncs')
    .select(`${DRIVE_SYNC_COLUMNS}, trackers(slug, name)`)
    .order('created_at', { ascending: false })
    .limit(30);
  if (error) throw error;
  const syncs = (data ?? []) as unknown as Array<
    DriveFolderSyncRow & { trackers: { slug: string; name: string } | null }
  >;
  if (!syncs.length) return [];
  const { data: files, error: fError } = await db
    .from('drive_folder_sync_files')
    .select('sync_id, file_name, status, notes, error, processed_at')
    .in(
      'sync_id',
      syncs.map((s) => s.id),
    )
    .neq('status', 'ok')
    .order('processed_at', { ascending: false })
    .limit(100);
  if (fError) throw fError;
  const problems = (files ?? []) as Array<{
    sync_id: string;
    file_name: string;
    status: string;
    notes: string[] | null;
    error: string | null;
  }>;
  return syncs.map(({ trackers, ...s }) => ({
    ...s,
    tracker: trackers,
    problems: problems
      .filter((p) => p.sync_id === s.id)
      .slice(0, 5)
      .map((p) => ({
        file_name: p.file_name,
        status: p.status,
        notes: p.notes ?? [],
        error: p.error,
      })),
  }));
}
