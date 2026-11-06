import { randomUUID } from 'node:crypto';
import { ForbiddenError, NotFoundError, ValidationError, logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isCompanyManager } from '../../directory/store';
import { getFile, putFile, removeFiles } from '../../files/store';
import { TRACKER_COLUMNS } from '../../trackers/store';
import { peekAppDbDriver, quoteAppIdent } from '../code/app-db';
import { getAppDbRow, runAppDbQuery } from '../code/app-db-store';
import { getAppCode, saveAppCodeFiles } from '../code/store';
import {
  type CustomAppRow,
  listRoles,
  loadPublishedSnapshot,
  mustGetApp,
  updateApp,
} from '../store';
import { applySnapshot, draftSnapshot } from '../versions';
import { parseSnapshot } from '../versions-shape';
import {
  BACKUP_BUCKET,
  BACKUP_VERSION,
  type BackupAppDb,
  type BackupCode,
  type BackupConfig,
  type BackupContent,
  type BackupKind,
  type BackupRow,
  type BackupTable,
  type BackupTracker,
  type LiveRow,
  MAX_BACKUP_BYTES,
  MAX_ROWS_PER_TABLE,
  type RestorePlan,
  type TableDiff,
  backupPath,
  backupsToDelete,
  describeTableRestore,
  diffTable,
  packBackup,
  planTableRestore,
  tableCounts,
  tableSlugsOf,
  unpackBackup,
} from './shape';

/**
 * COPIAS POR APP: LA PARTE QUE TOCA LA BASE (migración 0247).
 *
 * `db` es siempre el cliente con alcance de empresa. Una copia es un archivo
 * gzip en app_files (bucket 'app-backups') y una fila índice en
 * custom_app_backups. Restaurar escribe SOLO en las tablas que la copia
 * contiene (las que la app usaba al copiar) y siempre deja antes una copia
 * «antes de restaurar»: si esa copia no se puede hacer, no se restaura nada.
 *
 * Lo restaurado se escribe directo en tracker_rows, con los ids y valores de la
 * copia, SIN pasar por las reglas ni los avisos (restaurar no debe disparar
 * automatizaciones sobre filas viejas); `updated_at` se pone en ahora para que
 * las pantallas abiertas vean el cambio.
 */

const PAGE = 1000;
const INDEX_COLUMNS =
  'id, app_id, kind, reason, status, created_by, created_at, size_bytes, tables, storage_ref';

export interface BackupSummary {
  id: string;
  appId: string;
  kind: BackupKind;
  reason: string;
  status: 'ok' | 'failed';
  createdBy: string | null;
  createdAt: string;
  sizeBytes: number;
  /** slug → filas */
  tables: Record<string, number>;
}

function adaptSummary(r: Record<string, unknown>): BackupSummary {
  return {
    id: String(r.id),
    appId: String(r.app_id),
    kind: r.kind as BackupKind,
    reason: typeof r.reason === 'string' ? r.reason : '',
    status: r.status === 'failed' ? 'failed' : 'ok',
    createdBy: typeof r.created_by === 'string' ? r.created_by : null,
    createdAt: String(r.created_at),
    sizeBytes: Number(r.size_bytes ?? 0),
    tables: r.tables && typeof r.tables === 'object' ? (r.tables as Record<string, number>) : {},
  };
}

/** Sólo quien administra la empresa (owner/admin) hace o restaura copias. */
export async function assertBackupAdmin(db: SupabaseClient, userId: string): Promise<void> {
  if (!(await isCompanyManager(db, userId)))
    throw new ForbiddenError(
      'Sólo quien administra la empresa puede hacer o restaurar copias de una aplicación.',
    );
}

// ---------------------------------------------------------------------------
// Leer lo de hoy
// ---------------------------------------------------------------------------

async function trackersBySlug(
  db: SupabaseClient,
  slugs: string[],
): Promise<Map<string, BackupTracker>> {
  const out = new Map<string, BackupTracker>();
  if (!slugs.length) return out;
  const { data, error } = await db.from('trackers').select(TRACKER_COLUMNS).in('slug', slugs);
  if (error) throw error;
  for (const t of (data ?? []) as Array<Record<string, unknown>>) {
    out.set(String(t.slug), {
      id: String(t.id),
      slug: String(t.slug),
      name: String(t.name),
      description: typeof t.description === 'string' ? t.description : '',
      fields: t.fields,
      origins: t.origins ?? [],
    });
  }
  return out;
}

async function liveRows(
  db: SupabaseClient,
  trackerId: string,
  max = MAX_ROWS_PER_TABLE + 1,
): Promise<BackupRow[]> {
  const rows: BackupRow[] = [];
  for (let from = 0; rows.length < max; from += PAGE) {
    const { data, error } = await db
      .from('tracker_rows')
      .select('id, label, values, created_by, created_at, updated_at')
      .eq('tracker_id', trackerId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const page = (data ?? []) as Array<Record<string, unknown>>;
    for (const r of page)
      rows.push({
        id: String(r.id),
        label: String(r.label ?? ''),
        values: (r.values as Record<string, unknown>) ?? {},
        created_by: typeof r.created_by === 'string' ? r.created_by : null,
        created_at: String(r.created_at),
        updated_at: String(r.updated_at),
      });
    if (page.length < PAGE) break;
  }
  return rows.slice(0, max);
}

async function dumpAppDb(db: SupabaseClient, appId: string): Promise<BackupAppDb | null> {
  if (!peekAppDbDriver()) return null;
  const row = await getAppDbRow(db, appId);
  if (!row) return null;
  const list = await runAppDbQuery(db, appId, {
    sql: "select table_name from information_schema.tables where table_schema = current_schema() and table_type = 'BASE TABLE' order by 1",
    readOnly: true,
  });
  const out: BackupAppDb = { schema: row.schema_name, tables: {} };
  for (const t of list.rows as Array<{ table_name: string }>) {
    const name = t.table_name;
    const rows: Array<Record<string, unknown>> = [];
    let truncated = false;
    for (let offset = 0; ; offset += 200) {
      if (offset >= MAX_ROWS_PER_TABLE) {
        truncated = true;
        break;
      }
      const page = await runAppDbQuery(db, appId, {
        sql: `select to_jsonb(t) as r from ${quoteAppIdent(name)} t order by 1 limit 200 offset ${offset}`,
        readOnly: true,
      });
      for (const p of page.rows as Array<{ r: Record<string, unknown> }>) rows.push(p.r);
      if (page.truncated) {
        truncated = true;
        break;
      }
      if (page.rows.length < 200) break;
    }
    out.tables[name] = { rows, total: rows.length, truncated };
  }
  return out;
}

async function loadCode(db: SupabaseClient, appId: string): Promise<BackupCode | null> {
  const code = await getAppCode(db, appId);
  if (!code) return null;
  const { data } = await db.from('custom_app_code_secrets').select('name').eq('app_id', appId);
  return {
    files: code.files,
    fileMeta: code.file_meta,
    sdkVersion: code.sdk_version,
    publishedBuildId: code.published_build_id,
    secretNames: ((data ?? []) as Array<{ name: string }>).map((s) => s.name).sort(),
  };
}

async function loadConfig(db: SupabaseClient, app: CustomAppRow): Promise<BackupConfig> {
  const snapshot = await draftSnapshot(db, app);
  const { data: rawApp, error } = await db
    .from('custom_apps')
    .select('*')
    .eq('id', app.id)
    .maybeSingle();
  if (error) throw error;
  const { data: automations } = await db
    .from('custom_app_automations')
    .select('*')
    .eq('app_id', app.id);
  const { data: notice } = await db
    .from('custom_app_notice_config')
    .select('config')
    .eq('app_id', app.id)
    .maybeSingle();
  const published = await loadPublishedSnapshot(db, app.id);
  return {
    app: (rawApp as Record<string, unknown>) ?? {},
    snapshot,
    automations: (automations ?? []) as Array<Record<string, unknown>>,
    noticeConfig: (notice as { config?: Record<string, unknown> } | null)?.config ?? null,
    publishedVersion: published?.number ?? null,
  };
}

// ---------------------------------------------------------------------------
// Hacer una copia
// ---------------------------------------------------------------------------

export interface CreateBackupInput {
  kind: BackupKind;
  reason?: string;
  /** Quién la pidió; null en la diaria (la hace el sistema). */
  userId?: string | null;
}

/** Arma el contenido de una copia con lo que la app tiene HOY. */
export async function collectBackup(
  db: SupabaseClient,
  app: CustomAppRow,
  input: CreateBackupInput,
): Promise<BackupContent> {
  const warnings: string[] = [];
  const config = await loadConfig(db, app);
  const roles = await listRoles(db, app.id);
  const slugs = tableSlugsOf({
    roles,
    specs: config.snapshot.screens.map((s) => s.spec),
    automations: config.automations,
  });
  const trackers = await trackersBySlug(db, slugs);
  const tables: Record<string, BackupTable> = {};
  for (const slug of slugs) {
    const tracker = trackers.get(slug);
    if (!tracker) {
      warnings.push(`La tabla «${slug}» se nombra en la app pero no existe: no se copió.`);
      continue;
    }
    const rows = await liveRows(db, tracker.id);
    const truncated = rows.length > MAX_ROWS_PER_TABLE;
    tables[slug] = {
      tracker,
      rows: truncated ? rows.slice(0, MAX_ROWS_PER_TABLE) : rows,
      total: Math.min(rows.length, MAX_ROWS_PER_TABLE),
      truncated,
    };
    if (truncated)
      warnings.push(`«${slug}» pasa de ${MAX_ROWS_PER_TABLE} filas: la copia guarda las primeras.`);
  }
  let appDb: BackupAppDb | null = null;
  try {
    appDb = await dumpAppDb(db, app.id);
  } catch (err) {
    logger.warn({ err, app: app.id }, 'backups: own database could not be dumped');
    warnings.push('No se pudo copiar la base propia de la app.');
  }
  return {
    v: BACKUP_VERSION,
    app: { id: app.id, slug: app.slug, name: app.name },
    createdAt: new Date().toISOString(),
    kind: input.kind,
    reason: (input.reason ?? '').trim().slice(0, 300),
    config,
    code: await loadCode(db, app.id),
    tables,
    appDb,
    warnings,
  };
}

/**
 * Hace una copia de la app y la guarda. Si no se puede (tamaño, archivo, base)
 * deja una fila `failed` con el motivo —para que se vea en la lista— y lanza.
 */
export async function createBackup(
  db: SupabaseClient,
  appRef: string,
  input: CreateBackupInput,
): Promise<BackupSummary> {
  const app = await mustGetApp(db, appRef, { includeArchived: true });
  const id = randomUUID();
  const reason = (input.reason ?? '').trim().slice(0, 300);
  try {
    const content = await collectBackup(db, app, input);
    let bytes = packBackup(content);
    if (bytes.byteLength > MAX_BACKUP_BYTES && content.appDb) {
      // Lo más pesado es la base propia: sin ella, la copia suele caber.
      content.appDb = null;
      content.warnings.push('La base propia no cupo en la copia por su tamaño: se dejó fuera.');
      bytes = packBackup(content);
    }
    if (bytes.byteLength > MAX_BACKUP_BYTES)
      throw new ValidationError(
        `La copia pesa ${(bytes.byteLength / 1048576).toFixed(1)} MB y el máximo es ${MAX_BACKUP_BYTES / 1048576} MB.`,
      );
    const path = backupPath(app.organization_id ?? '', app.id, id);
    await putFile(db, {
      bucket: BACKUP_BUCKET,
      path,
      content: bytes,
      contentType: 'application/gzip',
    });
    const row = {
      id,
      app_id: app.id,
      kind: input.kind,
      reason,
      status: 'ok',
      created_by: input.userId ?? null,
      size_bytes: bytes.byteLength,
      tables: tableCounts(content),
      storage_ref: path,
    };
    const { data, error } = await db
      .from('custom_app_backups')
      .insert(row)
      .select(INDEX_COLUMNS)
      .single();
    if (error) {
      await removeFiles(db, BACKUP_BUCKET, [path]).catch(() => undefined);
      throw error;
    }
    return adaptSummary(data as Record<string, unknown>);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    await db
      .from('custom_app_backups')
      .insert({
        id,
        app_id: app.id,
        kind: input.kind,
        reason: `${reason ? `${reason} · ` : ''}Falló: ${why}`.slice(0, 300),
        status: 'failed',
        created_by: input.userId ?? null,
      })
      .then(
        () => undefined,
        () => undefined,
      );
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Listar y leer
// ---------------------------------------------------------------------------

export async function listBackups(
  db: SupabaseClient,
  appId: string,
  limit = 100,
): Promise<BackupSummary[]> {
  const { data, error } = await db
    .from('custom_app_backups')
    .select(INDEX_COLUMNS)
    .eq('app_id', appId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map(adaptSummary);
}

async function mustGetIndex(
  db: SupabaseClient,
  appId: string,
  backupId: string,
): Promise<{ summary: BackupSummary; ref: string }> {
  const { data, error } = await db
    .from('custom_app_backups')
    .select(INDEX_COLUMNS)
    .eq('id', backupId)
    .eq('app_id', appId)
    .maybeSingle();
  if (error) throw error;
  const row = data as Record<string, unknown> | null;
  if (!row) throw new NotFoundError('No existe esa copia en esta aplicación.');
  if (row.status === 'failed' || typeof row.storage_ref !== 'string')
    throw new ValidationError(
      'Esa copia no se pudo guardar: no tiene contenido que ver o restaurar.',
    );
  return { summary: adaptSummary(row), ref: row.storage_ref };
}

export async function readBackup(
  db: SupabaseClient,
  appId: string,
  backupId: string,
): Promise<{ summary: BackupSummary; content: BackupContent }> {
  const { summary, ref } = await mustGetIndex(db, appId, backupId);
  const file = await getFile(db, BACKUP_BUCKET, ref);
  if (!file) throw new NotFoundError('El archivo de esa copia ya no existe.');
  const content = unpackBackup(file.content);
  // Un archivo de otra app nunca se sirve con el id de esta.
  if (content.app.id !== appId)
    throw new ValidationError('El archivo no corresponde a esta aplicación.');
  return { summary, content };
}

// ---------------------------------------------------------------------------
// Diferencias contra hoy
// ---------------------------------------------------------------------------

export interface BackupDiff {
  tables: TableDiff[];
  config: { screensChanged: string[]; rolesChanged: string[]; automationsChanged: number };
  code: { added: string[]; removed: string[]; changed: string[] } | null;
}

export async function diffAgainstToday(
  db: SupabaseClient,
  appRef: string,
  backupId: string,
): Promise<BackupDiff> {
  const app = await mustGetApp(db, appRef, { includeArchived: true });
  const { content } = await readBackup(db, app.id, backupId);
  const trackers = await trackersBySlug(db, Object.keys(content.tables));
  const tables: TableDiff[] = [];
  for (const [slug, table] of Object.entries(content.tables)) {
    const t = trackers.get(slug);
    const live: LiveRow[] = t ? await liveRows(db, t.id) : [];
    tables.push(diffTable(slug, table, live));
  }
  const now = await loadConfig(db, app);
  const bySlug = new Map(now.snapshot.screens.map((s) => [s.slug, s]));
  const screensChanged = content.config.snapshot.screens
    .filter((s) => JSON.stringify(bySlug.get(s.slug)?.spec ?? null) !== JSON.stringify(s.spec))
    .map((s) => s.title);
  for (const s of now.snapshot.screens)
    if (!content.config.snapshot.screens.some((o) => o.slug === s.slug))
      screensChanged.push(s.title);
  const rolesNow = new Map(now.snapshot.roles.map((r) => [r.key, r]));
  const rolesChanged = content.config.snapshot.roles
    .filter(
      (r) =>
        JSON.stringify(rolesNow.get(r.key)?.permissions ?? null) !== JSON.stringify(r.permissions),
    )
    .map((r) => r.name);
  for (const r of now.snapshot.roles)
    if (!content.config.snapshot.roles.some((o) => o.key === r.key)) rolesChanged.push(r.name);
  const ruleKey = (a: Record<string, unknown>) =>
    JSON.stringify([a.id, a.name, a.enabled, a.trigger, a.conditions, a.actions]);
  const before = new Map(content.config.automations.map((a) => [String(a.id), ruleKey(a)]));
  const after = new Map(now.automations.map((a) => [String(a.id), ruleKey(a)]));
  let automationsChanged = 0;
  for (const [id, k] of before) if (after.get(id) !== k) automationsChanged++;
  for (const id of after.keys()) if (!before.has(id)) automationsChanged++;
  let code: BackupDiff['code'] = null;
  if (content.code) {
    const cur = (await getAppCode(db, app.id))?.files ?? {};
    const was = content.code.files;
    code = {
      added: Object.keys(cur).filter((p) => !(p in was)),
      removed: Object.keys(was).filter((p) => !(p in cur)),
      changed: Object.keys(was).filter((p) => p in cur && cur[p] !== was[p]),
    };
  }
  return { tables, config: { screensChanged, rolesChanged, automationsChanged }, code };
}

// ---------------------------------------------------------------------------
// Restaurar
// ---------------------------------------------------------------------------

export interface RestoreOutcome {
  /** La copia «antes de restaurar» que quedó hecha. */
  safetyBackupId: string;
  /** Frases de lo que se hizo. */
  done: string[];
  skipped: string[];
}

/** Siempre antes de restaurar: sin esta copia no se restaura nada. */
async function safetyBackup(
  db: SupabaseClient,
  app: CustomAppRow,
  userId: string,
  what: string,
): Promise<string> {
  try {
    const b = await createBackup(db, app.id, {
      kind: 'antes_de_cambio',
      reason: `Antes de restaurar ${what}`,
      userId,
    });
    return b.id;
  } catch (err) {
    logger.error({ err, app: app.id }, 'backups: safety backup failed, restore aborted');
    throw new ValidationError(
      'No pude hacer la copia de seguridad previa, así que no restauré nada. Intenta de nuevo.',
    );
  }
}

/** La tabla de hoy con ese slug; si ya no existe se vuelve a crear con el mismo id y campos de la copia. */
async function ensureTracker(db: SupabaseClient, t: BackupTracker): Promise<string> {
  const found = (await trackersBySlug(db, [t.slug])).get(t.slug);
  if (found) return found.id;
  const { error } = await db.from('trackers').insert({
    id: t.id,
    slug: t.slug,
    name: t.name,
    description: t.description,
    fields: t.fields,
    origins: t.origins ?? [],
  });
  if (error) throw error;
  return t.id;
}

function tableOf(content: BackupContent, slug: string): BackupTable {
  // Sólo las tablas que la copia contiene: ninguna otra se toca desde aquí.
  const table = Object.hasOwn(content.tables, slug) ? content.tables[slug] : undefined;
  if (!table) throw new NotFoundError(`Esa copia no incluye la tabla «${slug}».`);
  return table;
}

/** Cuántas filas cambiarían al restaurar la tabla entera: para la confirmación. */
export async function previewTableRestore(
  db: SupabaseClient,
  appRef: string,
  backupId: string,
  slug: string,
): Promise<{ plan: RestorePlan; text: string }> {
  const app = await mustGetApp(db, appRef, { includeArchived: true });
  const { content } = await readBackup(db, app.id, backupId);
  const table = tableOf(content, slug);
  const current = (await trackersBySlug(db, [slug])).get(slug);
  const live = current ? await liveRows(db, current.id) : [];
  const plan = planTableRestore(diffTable(slug, table, live));
  return { plan, text: describeTableRestore(slug, plan) };
}

export async function previewRowRestore(
  db: SupabaseClient,
  appRef: string,
  backupId: string,
  slug: string,
  rowId: string,
): Promise<{ action: 'recreate' | 'update' | 'same'; text: string }> {
  const app = await mustGetApp(db, appRef, { includeArchived: true });
  const { content } = await readBackup(db, app.id, backupId);
  const table = tableOf(content, slug);
  const row = table.rows.find((r) => r.id === rowId);
  if (!row) throw new NotFoundError('Esa fila no está en la copia.');
  const current = (await trackersBySlug(db, [slug])).get(slug);
  const { data } = current
    ? await db
        .from('tracker_rows')
        .select('id, label, values')
        .eq('id', rowId)
        .eq('tracker_id', current.id)
        .maybeSingle()
    : { data: null };
  const now = data as { label: string; values: Record<string, unknown> } | null;
  if (!now)
    return {
      action: 'recreate',
      text: `La fila «${row.label}» fue borrada: se vuelve a crear con el mismo id.`,
    };
  const same = JSON.stringify([now.label, now.values]) === JSON.stringify([row.label, row.values]);
  return same
    ? { action: 'same', text: `La fila «${row.label}» ya está igual que en la copia.` }
    : { action: 'update', text: `La fila «${row.label}» vuelve a sus valores de la copia.` };
}

export async function restoreRow(
  db: SupabaseClient,
  appRef: string,
  backupId: string,
  slug: string,
  rowId: string,
  input: { userId: string },
): Promise<RestoreOutcome & { action: 'recreated' | 'updated' | 'unchanged' }> {
  await assertBackupAdmin(db, input.userId);
  const app = await mustGetApp(db, appRef, { includeArchived: true });
  const { content } = await readBackup(db, app.id, backupId);
  const table = tableOf(content, slug);
  const row = table.rows.find((r) => r.id === rowId);
  if (!row) throw new NotFoundError('Esa fila no está en la copia.');
  const safetyBackupId = await safetyBackup(
    db,
    app,
    input.userId,
    `la fila «${row.label}» de ${slug}`,
  );
  const trackerId = await ensureTracker(db, table.tracker);
  const now = new Date().toISOString();
  const { data: existing, error } = await db
    .from('tracker_rows')
    .select('id, label, values')
    .eq('id', rowId)
    .eq('tracker_id', trackerId)
    .maybeSingle();
  if (error) throw error;
  if (existing) {
    const cur = existing as { label: string; values: Record<string, unknown> };
    if (JSON.stringify([cur.label, cur.values]) === JSON.stringify([row.label, row.values]))
      return {
        safetyBackupId,
        done: ['La fila ya estaba igual.'],
        skipped: [],
        action: 'unchanged',
      };
    const { error: upErr } = await db
      .from('tracker_rows')
      .update({ label: row.label, values: row.values, updated_at: now })
      .eq('id', rowId)
      .eq('tracker_id', trackerId);
    if (upErr) throw upErr;
    return {
      safetyBackupId,
      done: [`La fila «${row.label}» volvió a sus valores de la copia.`],
      skipped: [],
      action: 'updated',
    };
  }
  const { error: insErr } = await db.from('tracker_rows').insert({
    id: row.id,
    tracker_id: trackerId,
    label: row.label,
    values: row.values,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: now,
  });
  if (insErr) throw insErr;
  return {
    safetyBackupId,
    done: [`La fila «${row.label}» se volvió a crear con el mismo id.`],
    skipped: [],
    action: 'recreated',
  };
}

export async function restoreTable(
  db: SupabaseClient,
  appRef: string,
  backupId: string,
  slug: string,
  input: { userId: string },
): Promise<RestoreOutcome & { plan: RestorePlan }> {
  await assertBackupAdmin(db, input.userId);
  const app = await mustGetApp(db, appRef, { includeArchived: true });
  const { content } = await readBackup(db, app.id, backupId);
  const table = tableOf(content, slug);
  const safetyBackupId = await safetyBackup(db, app, input.userId, `la tabla ${slug}`);
  const trackerId = await ensureTracker(db, table.tracker);
  const live = await liveRows(db, trackerId);
  const diff = diffTable(slug, table, live);
  const plan = planTableRestore(diff);
  const now = new Date().toISOString();
  const byId = new Map(table.rows.map((r) => [r.id, r]));

  const toCreate = diff.removed.flatMap((r) =>
    byId.has(r.id) ? [byId.get(r.id) as BackupRow] : [],
  );
  for (let i = 0; i < toCreate.length; i += 200) {
    const { error } = await db.from('tracker_rows').insert(
      toCreate.slice(i, i + 200).map((r) => ({
        id: r.id,
        tracker_id: trackerId,
        label: r.label,
        values: r.values,
        created_by: r.created_by,
        created_at: r.created_at,
        updated_at: now,
      })),
    );
    if (error) throw error;
  }
  for (const c of diff.changed) {
    const r = byId.get(c.id);
    if (!r) continue;
    const { error } = await db
      .from('tracker_rows')
      .update({ label: r.label, values: r.values, updated_at: now })
      .eq('id', r.id)
      .eq('tracker_id', trackerId);
    if (error) throw error;
  }
  if (plan.remove) {
    const ids = diff.added.map((r) => r.id);
    for (let i = 0; i < ids.length; i += 200) {
      const { error } = await db
        .from('tracker_rows')
        .delete()
        .eq('tracker_id', trackerId)
        .in('id', ids.slice(i, i + 200));
      if (error) throw error;
    }
  }
  const skipped = diff.truncated
    ? ['La copia es parcial (la tabla tenía demasiadas filas): no se borró ninguna fila nueva.']
    : [];
  return { safetyBackupId, done: [describeTableRestore(slug, plan)], skipped, plan };
}

export async function restoreConfig(
  db: SupabaseClient,
  appRef: string,
  backupId: string,
  input: { userId: string },
): Promise<RestoreOutcome> {
  await assertBackupAdmin(db, input.userId);
  const app = await mustGetApp(db, appRef, { includeArchived: true });
  const { content } = await readBackup(db, app.id, backupId);
  const snapshot = parseSnapshot(content.config.snapshot);
  if (!snapshot) throw new ValidationError('La configuración de esa copia no se puede leer.');
  const safetyBackupId = await safetyBackup(db, app, input.userId, 'la configuración');
  const { done, skipped } = await applySnapshot(db, app, snapshot, {
    userId: input.userId,
    label: 'Restaurar copia',
  });

  // Ubicación y geocercas (viven en la fila de la app, no en la foto de versiones).
  const loc = content.config.app.location;
  if (loc && typeof loc === 'object') {
    try {
      await updateApp(db, app.id, { location: loc as never, userId: input.userId });
      done.push('ubicación y geocercas');
    } catch (err) {
      skipped.push(`Ubicación: ${err instanceof Error ? err.message : 'no se pudo devolver'}`);
    }
  }

  // Reglas: las de la copia vuelven (por id); las que hoy existen y la copia no tenía se quitan.
  try {
    const { data: nowRules } = await db
      .from('custom_app_automations')
      .select('id')
      .eq('app_id', app.id);
    const wanted = new Set(content.config.automations.map((a) => String(a.id)));
    const extra = ((nowRules ?? []) as Array<{ id: string }>)
      .map((r) => r.id)
      .filter((id) => !wanted.has(id));
    if (extra.length)
      await db.from('custom_app_automations').delete().eq('app_id', app.id).in('id', extra);
    for (const a of content.config.automations) {
      const { id, organization_id: _org, ...rest } = a as Record<string, unknown>;
      const { data: has } = await db
        .from('custom_app_automations')
        .select('id')
        .eq('id', String(id))
        .eq('app_id', app.id)
        .maybeSingle();
      const patch = { ...rest, app_id: app.id, updated_at: new Date().toISOString() };
      const { error } = has
        ? await db
            .from('custom_app_automations')
            .update(patch)
            .eq('id', String(id))
            .eq('app_id', app.id)
        : await db.from('custom_app_automations').insert({ id, ...patch });
      if (error) throw error;
    }
    done.push(`reglas (${content.config.automations.length})`);
  } catch (err) {
    skipped.push(`Reglas: ${err instanceof Error ? err.message : 'no se pudieron devolver'}`);
  }

  if (content.config.noticeConfig) {
    const { error } = await db.from('custom_app_notice_config').upsert(
      {
        app_id: app.id,
        config: content.config.noticeConfig,
        updated_by: input.userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'app_id' },
    );
    if (error) skipped.push('Avisos automáticos: no se pudieron devolver.');
    else done.push('avisos automáticos');
  }
  return { safetyBackupId, done, skipped };
}

export async function restoreCode(
  db: SupabaseClient,
  appRef: string,
  backupId: string,
  input: { userId: string },
): Promise<RestoreOutcome> {
  await assertBackupAdmin(db, input.userId);
  const app = await mustGetApp(db, appRef, { includeArchived: true });
  const { content } = await readBackup(db, app.id, backupId);
  if (!content.code)
    throw new ValidationError('Esa copia no tiene código: la app aún no lo tenía.');
  const safetyBackupId = await safetyBackup(db, app, input.userId, 'el código');
  const current = (await getAppCode(db, app.id))?.files ?? {};
  const remove = Object.keys(current).filter((p) => !(p in (content.code as BackupCode).files));
  await saveAppCodeFiles(db, app.id, { write: content.code.files, remove }, input.userId);
  return {
    safetyBackupId,
    done: [`código del borrador (${Object.keys(content.code.files).length} archivos)`],
    skipped: [
      'Lo publicado no cambió: compila y publica para que los usuarios vean este código.',
      ...(content.code.secretNames.length
        ? [
            `Los secretos no se restauran (sólo se copian sus nombres: ${content.code.secretNames.join(', ')}).`,
          ]
        : []),
    ],
  };
}

// ---------------------------------------------------------------------------
// Retención
// ---------------------------------------------------------------------------

/** Borra las copias vencidas de UNA app (fila índice y archivo). Devuelve cuántas. */
export async function pruneBackups(
  db: SupabaseClient,
  appId: string,
  now: Date = new Date(),
): Promise<number> {
  const { data, error } = await db
    .from('custom_app_backups')
    .select('id, kind, status, created_at, storage_ref')
    .eq('app_id', appId)
    .limit(2000);
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    id: string;
    kind: BackupKind;
    status: 'ok' | 'failed';
    created_at: string;
    storage_ref: string | null;
  }>;
  const doomed = new Set(backupsToDelete(rows, now));
  if (!doomed.size) return 0;
  const refs = rows
    .filter((r) => doomed.has(r.id) && r.storage_ref)
    .map((r) => r.storage_ref as string);
  await removeFiles(db, BACKUP_BUCKET, refs);
  const { error: delErr } = await db
    .from('custom_app_backups')
    .delete()
    .eq('app_id', appId)
    .in('id', [...doomed]);
  if (delErr) throw delErr;
  return doomed.size;
}

/** Apps de la empresa con copias aunque la app ya no exista (para la retención). */
export async function backedUpAppIds(db: SupabaseClient): Promise<string[]> {
  const { data, error } = await db.from('custom_app_backups').select('app_id').limit(5000);
  if (error) throw error;
  return [...new Set(((data ?? []) as Array<{ app_id: string }>).map((r) => r.app_id))];
}
