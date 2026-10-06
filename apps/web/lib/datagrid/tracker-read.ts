import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * LO QUE LAS PANTALLAS DE TABLAS LEEN ADEMÁS DE LA TABLA.
 *
 * Las filas completas (en páginas de mil, hasta un techo), y lo que la llena
 * sola: una fuente conectada (`tracker_syncs`, 0161) o una carpeta de Drive
 * (`drive_folder_syncs`, 0164). Cada lectura mira su `error`: una base caída
 * no se pinta como «esta tabla no tiene filas».
 *
 * `db` es siempre el cliente con alcance de la empresa.
 */

export const ENTRY_COLUMNS =
  'id, tracker_id, label, values, created_by, created_at, updated_at, external_key, duplicate_flagged';

export interface TrackerEntry {
  id: string;
  tracker_id: string;
  label: string;
  values: Record<string, string | number>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  external_key: string | null;
  /** La regla de duplicados de la tabla la marcó (`tracker_rows.duplicate_flagged`). */
  duplicate_flagged: boolean;
}

function adapt(row: Record<string, unknown>): TrackerEntry {
  const values =
    row.values && typeof row.values === 'object' && !Array.isArray(row.values)
      ? (row.values as Record<string, string | number>)
      : {};
  return {
    id: String(row.id),
    tracker_id: String(row.tracker_id),
    label: String(row.label ?? ''),
    values,
    created_by: typeof row.created_by === 'string' ? row.created_by : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    external_key: typeof row.external_key === 'string' ? row.external_key : null,
    duplicate_flagged: row.duplicate_flagged === true,
  };
}

export async function countTrackerRows(db: SupabaseClient, trackerId: string): Promise<number> {
  const { count, error } = await db
    .from('tracker_rows')
    .select('id', { count: 'exact', head: true })
    .eq('tracker_id', trackerId);
  if (error) throw error;
  return count ?? 0;
}

/** Las filas más recientes primero, de a mil, hasta `limit`. */
export async function readTrackerEntries(
  db: SupabaseClient,
  trackerId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<TrackerEntry[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 2000, 20_000));
  const start = Math.max(0, opts.offset ?? 0);
  const out: TrackerEntry[] = [];
  for (let from = start; from < start + limit; from += 1000) {
    const to = Math.min(from + 1000, start + limit) - 1;
    const { data, error } = await db
      .from('tracker_rows')
      .select(ENTRY_COLUMNS)
      .eq('tracker_id', trackerId)
      .order('updated_at', { ascending: false })
      .order('id', { ascending: true })
      .range(from, to);
    if (error) throw error;
    const page = (data ?? []).map((r) => adapt(r as Record<string, unknown>));
    out.push(...page);
    if (page.length < to - from + 1) break;
  }
  return out;
}

export async function readTrackerEntry(
  db: SupabaseClient,
  trackerId: string,
  rowId: string,
): Promise<TrackerEntry | null> {
  const { data, error } = await db
    .from('tracker_rows')
    .select(ENTRY_COLUMNS)
    .eq('tracker_id', trackerId)
    .eq('id', rowId)
    .maybeSingle();
  if (error) throw error;
  return data ? adapt(data as Record<string, unknown>) : null;
}

// ---------------------------------------------------------------------------
// Lo que llena la tabla sola
// ---------------------------------------------------------------------------

export type TableSyncState = 'ok' | 'error' | 'paused' | 'waiting';

export interface TableSyncInfo {
  id: string;
  kind: 'table_sync' | 'drive_folder';
  trackerId: string;
  /** «Hoja de vuelos» o «Carpeta Facturas 2026». */
  source: string;
  every: string;
  state: TableSyncState;
  lastRunAt: string | null;
  lastError: string | null;
  lastInserted: number;
  lastUpdated: number;
  createdBy: string | null;
  /** «Google Sheets», «Carpeta de Drive» o el tipo de fuente del Feed. */
  origin: string;
  /** Enlace a la hoja o a la carpeta de Google, si se conoce su id. */
  openUrl: string | null;
}

function every(minutes: number): string {
  if (minutes < 60) return `cada ${minutes} min`;
  if (minutes === 60) return 'cada hora';
  if (minutes % 60 === 0 && minutes < 1440) return `cada ${minutes / 60} h`;
  return 'una vez al día';
}

function stateOf(enabled: boolean, status: string | null): TableSyncState {
  if (!enabled) return 'paused';
  if (status === 'error') return 'error';
  if (status === 'ok') return 'ok';
  return 'waiting';
}

/** De dónde viene y, si se puede, el enlace para abrirlo en Google. */
export function originOf(
  kind: TableSyncInfo['kind'],
  r: {
    folder_id?: string;
    feed_sources?:
      | { kind: string | null; config: Record<string, unknown> | null }
      | Array<{ kind: string | null; config: Record<string, unknown> | null }>
      | null;
  },
): { origin: string; openUrl: string | null } {
  if (kind === 'drive_folder') {
    const id = r.folder_id?.trim();
    return {
      origin: 'Carpeta de Drive',
      openUrl: id && /^[\w-]+$/.test(id) ? `https://drive.google.com/drive/folders/${id}` : null,
    };
  }
  const src = one(r.feed_sources);
  const sheetId = src?.config?.spreadsheetId;
  if (typeof sheetId === 'string' && /^[\w-]+$/.test(sheetId))
    return {
      origin: 'Google Sheets',
      openUrl: `https://docs.google.com/spreadsheets/d/${sheetId}`,
    };
  return { origin: src?.kind === 'api' ? 'API' : 'Fuente conectada', openUrl: null };
}

const one = <T>(rel: T | T[] | null | undefined): T | null =>
  Array.isArray(rel) ? (rel[0] ?? null) : (rel ?? null);

export async function readTableSyncs(
  db: SupabaseClient,
  trackerId?: string,
): Promise<TableSyncInfo[]> {
  let syncQ = db
    .from('tracker_syncs')
    .select(
      'id, tracker_id, interval_minutes, enabled, last_run_at, last_status, last_error, last_inserted, last_updated, created_by, feed_sources(name, kind, config)',
    )
    .order('created_at', { ascending: false })
    .limit(200);
  let driveQ = db
    .from('drive_folder_syncs')
    .select(
      'id, tracker_id, folder_id, folder_name, interval_minutes, enabled, last_run_at, last_status, last_error, last_inserted, last_updated, created_by',
    )
    .order('created_at', { ascending: false })
    .limit(200);
  if (trackerId) {
    syncQ = syncQ.eq('tracker_id', trackerId);
    driveQ = driveQ.eq('tracker_id', trackerId);
  }
  const [syncs, drive] = await Promise.all([syncQ, driveQ]);
  if (syncs.error) throw syncs.error;
  if (drive.error) throw drive.error;
  type FeedSourceRel = {
    name: string | null;
    kind: string | null;
    config: Record<string, unknown> | null;
  };
  type SyncRow = {
    id: string;
    tracker_id: string;
    interval_minutes: number;
    enabled: boolean;
    last_run_at: string | null;
    last_status: string | null;
    last_error: string | null;
    last_inserted: number;
    last_updated: number;
    created_by: string | null;
    feed_sources?: FeedSourceRel | FeedSourceRel[] | null;
    folder_name?: string;
    folder_id?: string;
  };
  const shape = (r: SyncRow, kind: TableSyncInfo['kind']): TableSyncInfo => ({
    id: r.id,
    kind,
    trackerId: r.tracker_id,
    source:
      kind === 'drive_folder'
        ? `Carpeta de Drive «${(r.folder_name ?? '').trim() || 'sin nombre'}»`
        : `Fuente «${one(r.feed_sources)?.name?.trim() || 'conectada'}»`,
    every: every(r.interval_minutes),
    state: stateOf(r.enabled, r.last_status),
    lastRunAt: r.last_run_at,
    lastError: r.last_status === 'error' ? r.last_error : null,
    lastInserted: r.last_inserted ?? 0,
    lastUpdated: r.last_updated ?? 0,
    createdBy: r.created_by,
    ...originOf(kind, r),
  });
  return [
    ...((syncs.data ?? []) as unknown as SyncRow[]).map((r) => shape(r, 'table_sync')),
    ...((drive.data ?? []) as unknown as SyncRow[]).map((r) => shape(r, 'drive_folder')),
  ];
}

/** Nombres de personas del directorio, para «creada por» y el historial. */
export async function readPeopleNames(
  db: SupabaseClient,
  ids: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))].slice(0, 200);
  if (!unique.length) return new Map();
  const { data, error } = await db.from('users').select('id, name, email').in('id', unique);
  if (error) throw error;
  return new Map(
    ((data ?? []) as Array<{ id: string; name: string | null; email: string | null }>).map((u) => [
      u.id,
      u.name?.trim() || u.email?.split('@')[0] || 'Alguien',
    ]),
  );
}

// ---------------------------------------------------------------------------
// Credenciales para las consultas por fila (0198)
// ---------------------------------------------------------------------------

/**
 * Las herramientas propias de lectura (GET) que pueden servir de credencial: su
 * nombre y el servidor al que van. Nunca la llave: ni siquiera se pide la
 * columna cifrada.
 */
export async function readLookupCredentials(
  db: SupabaseClient,
): Promise<Array<{ slug: string; name: string; host: string }>> {
  const { data, error } = await db
    .from('custom_tools')
    .select('slug, name, url_template, http_method, enabled')
    .eq('enabled', true)
    .eq('http_method', 'GET')
    .order('name', { ascending: true })
    .limit(40);
  if (error) throw error;
  return ((data ?? []) as Array<{ slug: string; name: string; url_template: string }>)
    .map((t) => ({
      slug: t.slug,
      name: t.name,
      host: /^https?:\/\/([^/?#]+)/i.exec(t.url_template)?.[1]?.toLowerCase() ?? '',
    }))
    .filter((t) => t.host && !t.host.includes('{'));
}
