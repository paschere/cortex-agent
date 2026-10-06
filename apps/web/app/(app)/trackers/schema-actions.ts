'use server';

import { buildToolContext } from '@/lib/agent';
import { readTableSyncs } from '@/lib/datagrid/tracker-read';
import { slugFromName } from '@/lib/datagrid/trackers';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { deniedToolPatterns, isToolDenied } from '@/lib/tool-access';
import type { DuplicateDraft } from '@/lib/trackers/schema-editor';
import {
  type FieldUse,
  type ViewImpact,
  diffSchemas,
  ruleBlockers,
  unsafeRetypes,
  viewsBroken,
} from '@/lib/trackers/schema-impact';
import {
  type CatalogTracker,
  type DuplicateRule,
  type TrackerField,
  type TrackerRow,
  checkSpecAgainst,
  createTrackerSync,
  defineTracker,
  driveFolderMeta,
  duplicateRuleSchema,
  findDriveFolders,
  getDuplicateRule,
  getTool,
  getTrackerById,
  getTrackerBySlug,
  latestSourceSheet,
  listTrackers,
  pruneSyncFields,
  readSyncSettings,
  readWorkSettings,
  trackerFieldsSchema,
  trackersOf,
  updateDriveFolderSync,
  updateTrackerSync,
  validateDuplicateRule,
  viewCatalog,
  viewSpecSchema,
  writeAuditEvent,
} from '@cortex/agent-tools';
import { proposeFromDriveFolder } from '@cortex/agent-tools/src/drive-table/propose-folder';
import { proposeTableFromSheet } from '@cortex/agent-tools/src/table-sync/propose';
import { NotFoundError, type UUID, ValidationError, logger } from '@cortex/core';
import { revalidatePath } from 'next/cache';
import type {
  FolderChoice,
  FolderProposalView,
  SchemaEditorData,
  SchemaImpact,
  SchemaResult,
  SchemaSaveInput,
  SchemaSyncInfo,
  SheetProposalView,
  SheetSourceInfo,
} from './schema-types';

/**
 * LO QUE SE CAMBIA DESDE «CAMPOS Y REGLAS».
 *
 * Mismo criterio que `actions.ts`: cada export es un endpoint al que cualquiera
 * con sesión puede llamar, así que cada uno vuelve a mirar quién es y qué le
 * deja hacer su equipo, y escribe por el MISMO camino que el chat.
 *
 *   - Cambiar campos, reglas de la tabla y sincronizaciones: lo prohibido sobre
 *     `trackers.define` (la herramienta del chat que redefine una tabla).
 *   - «Sincronizar ahora» es `actions.ts › syncTrackerNow` (`trackers.retry_sync`).
 *   - Leer la configuración sólo pide sesión; `canEdit`/`canSync` le dicen a la
 *     pantalla qué mostrar apagado, pero NADA de lo que la pantalla diga se
 *     toma como permiso: cada escritura lo vuelve a comprobar (fail-closed).
 *
 * El borrador del editor nunca se toma por bueno: el impacto (vistas que se
 * romperían, filas con datos, reglas y sincronizaciones que dependen de un
 * campo) se RECALCULA aquí al guardar. Ver `lib/trackers/schema-impact.ts` para
 * la decisión de qué se hace con eso (bloquear, no arreglar a escondidas).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DENIED = 'Tu equipo no tiene permiso para cambiar los campos ni las reglas de las tablas.';

type Db = ReturnType<typeof getOrgScopedClient>;

function message(err: unknown, fallback: string): string {
  if (err instanceof ValidationError || err instanceof NotFoundError) return err.message;
  const text = err instanceof Error ? err.message : '';
  return text && text.length < 280 && !/[{}]|relation|column|violates|PGRST|JSON/.test(text)
    ? text
    : fallback;
}

async function context() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const denied = await deniedToolPatterns(db, user.id, { failClosed: true });
  if (isToolDenied('trackers.define', denied)) throw new ValidationError(DENIED);
  return { user, db };
}

async function mustTracker(db: Db, trackerId: string): Promise<TrackerRow> {
  if (!UUID_RE.test(trackerId)) throw new NotFoundError('Esa tabla ya no existe.');
  const tracker = await getTrackerById(db, trackerId);
  if (!tracker) throw new NotFoundError('Esa tabla ya no existe.');
  return tracker;
}

function audit(
  db: Db,
  userId: string,
  started: number,
  metadata: Record<string, unknown>,
  toolId = 'trackers.define',
) {
  return writeAuditEvent({
    db,
    userId: userId as UUID,
    toolId,
    input: metadata,
    status: 'ok',
    latencyMs: Math.round(performance.now() - started),
    surface: 'web',
    decision: 'confirmed',
    metadata: { from: 'campos_y_reglas', ...metadata },
  });
}

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

export async function loadSchemaEditor(
  slug: string,
): Promise<SchemaResult<{ data: SchemaEditorData }>> {
  try {
    const user = await requireSession();
    const db = getOrgScopedClient(user.organization.id);
    const tracker = await getTrackerBySlug(db, String(slug ?? '').trim());
    if (!tracker) return { ok: false, error: 'Esa tabla ya no existe.' };
    const denied = await deniedToolPatterns(db, user.id);
    const [settings, badges, rule, others, rowCount] = await Promise.all([
      readSyncSettings(db, tracker.id),
      readTableSyncs(db, tracker.id).catch(() => []),
      getDuplicateRule(db, tracker.id),
      listTrackers(db, 100),
      db
        .from('tracker_rows')
        .select('id', { count: 'exact', head: true })
        .eq('tracker_id', tracker.id)
        .then((r) => r.count ?? 0),
    ]);
    const badge = new Map(badges.map((b) => [b.id, b]));
    const syncs: SchemaSyncInfo[] = settings.map((s) => ({
      id: s.id,
      kind: s.kind,
      source:
        badge.get(s.id)?.source ??
        (s.kind === 'drive_folder' ? 'Carpeta de Drive' : 'Hoja conectada'),
      enabled: s.enabled,
      intervalMinutes: s.intervalMinutes,
      notify: s.notify,
      keyFields: s.keyFields,
      instructions: s.instructions,
      lastRunAt: s.lastRunAt,
      lastError: badge.get(s.id)?.lastError ?? null,
    }));
    return {
      ok: true,
      data: {
        tracker: {
          id: tracker.id,
          slug: tracker.slug,
          name: tracker.name,
          description: tracker.description,
          fields: tracker.fields,
          duplicates: rule
            ? {
                key: rule.rule.key,
                distinctBy: rule.rule.distinctBy,
                flagField: rule.rule.flagField,
                flagValue: rule.rule.flagValue,
              }
            : null,
        },
        rowCount,
        syncs,
        otherTrackers: others
          .filter((t) => t.slug !== tracker.slug)
          .map((t) => ({ slug: t.slug, name: t.name })),
        canEdit: !isToolDenied('trackers.define', denied),
        canSync:
          !isToolDenied('trackers.define', denied) && !isToolDenied('trackers.retry_sync', denied),
      },
    };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo leer la configuración de la tabla.') };
  }
}

// ---------------------------------------------------------------------------
// Impacto
// ---------------------------------------------------------------------------

/** Filas con algo escrito en cada campo. `key` ya pasó el regex de claves: se puede interpolar. */
async function rowsWithData(
  db: Db,
  trackerId: string,
  keys: string[],
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  await Promise.all(
    keys.map(async (key) => {
      if (!/^[a-z][a-z0-9_]{0,31}$/.test(key)) return;
      const { count } = await db
        .from('tracker_rows')
        .select('id', { count: 'exact', head: true })
        .eq('tracker_id', trackerId)
        .neq(`values->>${key}`, '');
      out[key] = count ?? 0;
    }),
  );
  return out;
}

/** Las vistas guardadas que este cambio dejaría con problemas nuevos (los que ya tenían no cuentan). */
async function brokenViews(
  db: Db,
  viewerId: string,
  tracker: TrackerRow,
  after: TrackerField[],
): Promise<ViewImpact[]> {
  const { data, error } = await db
    .from('custom_views')
    .select('id, slug, name, spec')
    .is('archived_at', null)
    .limit(500);
  if (error) throw error;
  const candidates = (
    (data ?? []) as Array<{ id: string; slug: string; name: string; spec: unknown }>
  ).flatMap((r) => {
    const parsed = viewSpecSchema.safeParse(r.spec);
    return parsed.success && trackersOf(parsed.data).includes(tracker.slug)
      ? [{ id: r.id, slug: r.slug, name: r.name, spec: parsed.data }]
      : [];
  });
  if (!candidates.length) return [];
  const entries = await viewCatalog(db, { viewerId });
  const catalogWith = (fields: TrackerField[]): CatalogTracker[] => [
    ...entries.filter((e) => e.slug !== tracker.slug),
    { slug: tracker.slug, name: tracker.name, fields },
  ];
  const before = catalogWith(tracker.fields);
  const next = catalogWith(after);
  return viewsBroken(
    candidates,
    () => true,
    (spec, which) => checkSpecAgainst(spec, which === 'before' ? before : next),
  );
}

/** Los campos que «Qué se mide» (Equipo) nombra para esta tabla. */
async function workUses(db: Db, slug: string): Promise<FieldUse[]> {
  try {
    const settings = await readWorkSettings(db);
    const mapping = settings.trackerMappings.find((m) => m.tracker === slug);
    if (!mapping) return [];
    return Object.entries(mapping as Record<string, unknown>)
      .filter(([k, v]) => k.endsWith('Field') && typeof v === 'string' && v)
      .map(([, v]) => ({
        key: String(v),
        where: 'la medición de trabajo de esta tabla (Equipo › Qué se mide)',
      }));
  } catch (err) {
    logger.warn({ err }, 'campos y reglas: no se pudo leer qué se mide como trabajo');
    return [];
  }
}

/** Fuera de zod: el borrador se normaliza igual que al guardar. */
function parseDraftFields(raw: unknown): TrackerField[] {
  const parsed = trackerFieldsSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const at = typeof issue?.path[0] === 'number' ? ` (campo ${Number(issue.path[0]) + 1})` : '';
    throw new ValidationError(`${issue?.message ?? 'Revisa los campos.'}${at}`);
  }
  return parsed.data;
}

function parseDraftRule(
  raw: DuplicateDraft | null | undefined,
  fields: TrackerField[],
): DuplicateRule | null {
  if (!raw) return null;
  const parsed = duplicateRuleSchema.safeParse(raw);
  if (!parsed.success) throw new ValidationError('La regla de duplicados no está completa.');
  const problem = validateDuplicateRule(parsed.data, fields);
  if (problem) throw new ValidationError(`Regla de duplicados: ${problem}`);
  return parsed.data;
}

async function analyze(
  db: Db,
  viewerId: string,
  tracker: TrackerRow,
  fields: TrackerField[],
  rule: DuplicateRule | null,
  confirmed: string[],
): Promise<SchemaImpact> {
  const diff = diffSchemas(tracker.fields, fields);
  const touched = [...diff.removed.map((r) => r.key), ...diff.retyped.map((r) => r.key)];
  const [withData, views, syncs, extra] = await Promise.all([
    rowsWithData(db, tracker.id, touched),
    brokenViews(db, viewerId, tracker, fields),
    readSyncSettings(db, tracker.id),
    workUses(db, tracker.slug),
  ]);
  const blockers = [
    ...ruleBlockers(
      diff,
      syncs.map((s) => ({ kind: s.kind, keyFields: s.keyFields })),
      rule,
      extra,
    ),
    ...unsafeRetypes(diff, withData).map(
      (r) =>
        `«${r.label}» tiene datos en ${r.rows} ${r.rows === 1 ? 'fila' : 'filas'}: pasarlo de ${r.from} a ${r.to} los dejaría sin sentido. Crea un campo nuevo y copia los datos.`,
    ),
  ];
  const removed = diff.removed.map((r) => ({ ...r, rows: withData[r.key] ?? 0 }));
  const needsConfirm = removed.some((r) => r.rows > 0 && !confirmed.includes(r.key));
  return {
    removed,
    droppedOptions: diff.droppedOptions,
    views,
    blockers,
    needsConfirm,
    canSave: blockers.length === 0 && views.length === 0,
  };
}

export async function analyzeSchemaChange(
  trackerId: string,
  draft: { fields: TrackerField[]; duplicates: DuplicateDraft | null },
): Promise<SchemaResult<{ impact: SchemaImpact }>> {
  try {
    const { user, db } = await context();
    const tracker = await mustTracker(db, trackerId);
    const fields = parseDraftFields(draft?.fields);
    const rule = parseDraftRule(draft?.duplicates, fields);
    return { ok: true, impact: await analyze(db, user.id, tracker, fields, rule, []) };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo revisar el cambio.') };
  }
}

// ---------------------------------------------------------------------------
// Escritura
// ---------------------------------------------------------------------------

/** Una relación sólo puede apuntar a una tabla que existe. */
async function checkRelations(db: Db, fields: TrackerField[], selfSlug?: string): Promise<void> {
  const wanted = [
    ...new Set(fields.flatMap((f) => (f.type === 'relation' && f.tracker ? [f.tracker] : []))),
  ];
  if (!wanted.length) return;
  const { data, error } = await db.from('trackers').select('slug').in('slug', wanted);
  if (error) throw error;
  const have = new Set((data ?? []).map((r) => (r as { slug: string }).slug));
  if (selfSlug) have.add(selfSlug);
  const missing = wanted.filter((s) => !have.has(s));
  if (missing.length)
    throw new ValidationError(
      `La relación apunta a una tabla que no existe: ${missing.join(', ')}.`,
    );
}

function cleanText(value: unknown, max: number): string {
  return String(value ?? '')
    .trim()
    .slice(0, max);
}

export async function saveTrackerSchema(
  trackerId: string,
  input: SchemaSaveInput,
): Promise<SchemaResult<{ fields: TrackerField[] }>> {
  const started = performance.now();
  try {
    const { user, db } = await context();
    const tracker = await mustTracker(db, trackerId);
    const name = cleanText(input?.name, 80);
    if (!name) return { ok: false, error: 'Ponle un nombre a la tabla.' };
    const fields = parseDraftFields(input?.fields);
    const rule = parseDraftRule(input?.duplicates, fields);
    await checkRelations(db, fields, tracker.slug);

    const confirmed = Array.isArray(input?.confirmRemoved) ? input.confirmRemoved.map(String) : [];
    const impact = await analyze(db, user.id, tracker, fields, rule, confirmed);
    if (impact.blockers.length)
      return { ok: false, error: `No se guardó. ${impact.blockers.join(' ')}` };
    if (impact.views.length) {
      const list = impact.views
        .slice(0, 5)
        .map((v) => `«${v.name}» (${v.problems[0] ?? 'problema'})`)
        .join('; ');
      return {
        ok: false,
        error: `No se guardó: dejaría con problemas ${impact.views.length === 1 ? 'esta vista' : `estas ${impact.views.length} vistas`}: ${list}. Arréglalas primero (quita el campo del bloque) y vuelve a guardar.`,
      };
    }
    if (impact.needsConfirm)
      return {
        ok: false,
        needsConfirm: true,
        error: 'Hay campos con datos que se van a quitar de la tabla; confirma antes de guardar.',
      };

    // Sólo se toca la regla si cambió: redefinirla recorre la tabla entera.
    const current = await getDuplicateRule(db, tracker.id);
    const same = JSON.stringify(current?.rule ?? null) === JSON.stringify(rule);
    await defineTracker(db, {
      slug: tracker.slug,
      name,
      description: cleanText(input?.description, 500),
      fields,
      userId: user.id,
      ...(same ? {} : { duplicates: rule }),
    });
    await pruneSyncFields(
      db,
      tracker.id,
      impact.removed.map((r) => r.key),
    ).catch((err) =>
      logger.warn(
        { err, slug: tracker.slug },
        'campos y reglas: no se limpiaron las sincronizaciones',
      ),
    );
    await audit(db, user.id, started, {
      tracker: tracker.slug,
      fields: fields.length,
      removed: impact.removed.map((r) => r.key),
      duplicates: rule ? 'on' : 'off',
    });
    revalidatePath(`/trackers/${tracker.slug}`);
    revalidatePath('/trackers');
    return { ok: true, fields };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudieron guardar los campos.') };
  }
}

export async function createTrackerWithSchema(input: {
  name: string;
  description: string;
  fields: TrackerField[];
  duplicates: DuplicateDraft | null;
}): Promise<SchemaResult<{ slug: string; id: string; fields: TrackerField[] }>> {
  const started = performance.now();
  try {
    const { user, db } = await context();
    const name = cleanText(input?.name, 80);
    if (!name) return { ok: false, error: 'Ponle un nombre a la tabla.' };
    const fields = parseDraftFields(input?.fields);
    const rule = parseDraftRule(input?.duplicates, fields);
    await checkRelations(db, fields);
    const { data: slugs, error } = await db.from('trackers').select('slug').limit(1000);
    if (error) throw error;
    const slug = slugFromName(
      name,
      ((slugs ?? []) as Array<{ slug: string }>).map((s) => s.slug),
    );
    const { tracker, created } = await defineTracker(db, {
      slug,
      name,
      description: cleanText(input?.description, 500),
      fields,
      userId: user.id,
      ...(rule ? { duplicates: rule } : {}),
    });
    if (!created) return { ok: false, error: 'Ya existe una tabla con ese nombre.' };
    await audit(db, user.id, started, {
      tracker: tracker.slug,
      created: true,
      fields: fields.length,
    });
    revalidatePath('/trackers');
    return { ok: true, slug: tracker.slug, id: tracker.id, fields };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo crear la tabla.') };
  }
}

export async function updateSyncSettings(
  kind: SchemaSyncInfo['kind'],
  syncId: string,
  patch: {
    enabled?: boolean;
    intervalMinutes?: number;
    notify?: boolean;
    keyFields?: string[];
    instructions?: string;
  },
): Promise<SchemaResult<{ sync: SchemaSyncInfo }>> {
  const started = performance.now();
  try {
    const { user, db } = await context();
    if (kind !== 'table_sync' && kind !== 'drive_folder')
      return { ok: false, error: 'No sé qué sincronización cambiar.' };
    if (!UUID_RE.test(String(syncId)))
      return { ok: false, error: 'Esa sincronización ya no existe.' };
    // Los campos que la tabla tiene hoy: una clave tiene que ser uno de ellos.
    const table = kind === 'drive_folder' ? 'drive_folder_syncs' : 'tracker_syncs';
    const { data: row, error } = await db
      .from(table)
      .select('tracker_id')
      .eq('id', syncId)
      .maybeSingle();
    if (error) throw error;
    const trackerId = (row as { tracker_id: string } | null)?.tracker_id;
    if (!trackerId) return { ok: false, error: 'Esa sincronización ya no existe.' };
    const tracker = await mustTracker(db, trackerId);
    const keys = tracker.fields.map((f) => f.key);
    const settings =
      kind === 'drive_folder'
        ? await updateDriveFolderSync(db, syncId, patch, keys)
        : await updateTrackerSync(db, syncId, patch, keys);
    await audit(db, user.id, started, { tracker: tracker.slug, sync: syncId, kind, patch });
    revalidatePath(`/trackers/${tracker.slug}`);
    const badge = (await readTableSyncs(db, tracker.id).catch(() => [])).find(
      (b) => b.id === syncId,
    );
    return {
      ok: true,
      sync: {
        id: settings.id,
        kind: settings.kind,
        source: badge?.source ?? (kind === 'drive_folder' ? 'Carpeta de Drive' : 'Hoja conectada'),
        enabled: settings.enabled,
        intervalMinutes: settings.intervalMinutes,
        notify: settings.notify,
        keyFields: settings.keyFields,
        instructions: settings.instructions,
        lastRunAt: settings.lastRunAt,
        lastError: badge?.lastError ?? null,
      },
    };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo guardar la sincronización.') };
  }
}

/** «Sincronizar ahora»: la misma herramienta del chat (`trackers.retry_sync`), con su propio permiso. */
export async function runSyncNow(
  kind: SchemaSyncInfo['kind'],
  syncId: string,
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const started = performance.now();
  try {
    const user = await requireSession();
    const db = getOrgScopedClient(user.organization.id);
    const denied = await deniedToolPatterns(db, user.id, { failClosed: true });
    if (isToolDenied('trackers.retry_sync', denied))
      return { ok: false, error: 'Tu equipo no tiene permiso para correr sincronizaciones.' };
    if (kind !== 'table_sync' && kind !== 'drive_folder')
      return { ok: false, error: 'No sé qué sincronizar.' };
    if (!UUID_RE.test(String(syncId)))
      return { ok: false, error: 'Esa sincronización ya no existe.' };
    const tool = getTool('trackers.retry_sync');
    if (!tool)
      return { ok: false, error: 'Esta instalación no puede correr sincronizaciones a mano.' };
    const ctx = buildToolContext({
      organizationId: user.organization.id,
      userId: user.id as UUID,
      agentId: user.id as UUID,
      surface: 'web',
    });
    const out = (await tool.handler(tool.inputSchema.parse({ kind, syncId }), ctx)) as {
      queued: boolean;
    };
    await audit(db, user.id, started, { kind, syncId, queued: out.queued }, 'trackers.retry_sync');
    return {
      ok: true,
      message: out.queued
        ? 'Listo: la estoy corriendo. Las filas nuevas aparecen al recargar en un momento.'
        : 'Quedó marcada para la próxima vuelta (como mucho en unos minutos).',
    };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo correr la sincronización.') };
  }
}

// ---------------------------------------------------------------------------
// Crear una tabla DESDE una hoja conectada
// ---------------------------------------------------------------------------

/**
 * Sólo el dueño de la fuente puede usarla: las fuentes del Feed son privadas
 * (`feed_sources.actor_id`), y tanto el listado como `latestSourceSheet`
 * filtran por quien pregunta. Además hace falta poder definir tablas y crear
 * sincronizaciones (`trackers.define` y `trackers.sync_from_source`).
 */
async function sheetContext() {
  const { user, db } = await context();
  const denied = await deniedToolPatterns(db, user.id, { failClosed: true });
  if (isToolDenied('trackers.sync_from_source', denied))
    throw new ValidationError('Tu equipo no tiene permiso para llenar tablas desde una hoja.');
  return { user, db };
}

export async function listSheetSources(): Promise<SchemaResult<{ sources: SheetSourceInfo[] }>> {
  try {
    const { user, db } = await sheetContext();
    const { data, error } = await db
      .from('feed_sources')
      .select('id, name, latest_attachment_id')
      .eq('actor_id', user.id)
      .eq('kind', 'google_sheet')
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) throw error;
    const sources = (data ?? []) as Array<{
      id: string;
      name: string | null;
      latest_attachment_id: string | null;
    }>;
    const ids = sources.flatMap((s) => (s.latest_attachment_id ? [s.latest_attachment_id] : []));
    const captures = ids.length
      ? await db
          .from('chat_attachments')
          .select('id, feed_tables')
          .in('id', ids)
          .eq('created_by', user.id)
          .gt('purge_at', new Date().toISOString())
      : { data: [], error: null };
    if (captures.error) throw captures.error;
    const tabs = new Map(
      (
        (captures.data ?? []) as Array<{
          id: string;
          feed_tables: Array<{ name: string; rows: unknown[] }> | null;
        }>
      ).map((c) => [c.id, c.feed_tables ?? []] as const),
    );
    return {
      ok: true,
      sources: sources
        // Sin captura vigente no hay nada que leer: se actualiza en el Feed primero.
        .filter(
          (s) => s.latest_attachment_id && (tabs.get(s.latest_attachment_id)?.length ?? 0) > 0,
        )
        .map((s) => ({
          id: s.id,
          name: s.name?.trim() || 'Hoja sin nombre',
          tabs: (tabs.get(s.latest_attachment_id as string) ?? []).map((t, index) => ({
            index,
            name: t.name || `Hoja ${index + 1}`,
            rows: Math.max(0, (t.rows?.length ?? 0) - 1),
          })),
        })),
    };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudieron leer tus hojas conectadas.') };
  }
}

function readSheetIndex(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 50) throw new ValidationError('Esa pestaña no existe.');
  return n;
}

export async function proposeFromSheet(
  sourceId: string,
  sheetIndex: number,
): Promise<SchemaResult<{ proposal: SheetProposalView }>> {
  try {
    const { user, db } = await sheetContext();
    if (!UUID_RE.test(String(sourceId))) return { ok: false, error: 'Esa hoja ya no existe.' };
    const index = readSheetIndex(sheetIndex);
    const found = await latestSourceSheet(db, sourceId, user.id, index);
    if (!found)
      return {
        ok: false,
        error: 'Esa hoja no tiene una captura vigente. Actualízala en el Feed y vuelve a intentar.',
      };
    const p = proposeTableFromSheet(found.sheet);
    const evidence: SheetProposalView['evidence'] = {};
    const fields: TrackerField[] = p.fields.map(({ sourceColumn, why, samples, ...field }) => {
      evidence[field.key] = { sourceColumn, why, samples };
      return field;
    });
    return {
      ok: true,
      proposal: {
        sourceId,
        sheetIndex: index,
        suggestedName: found.sourceName.slice(0, 80),
        fields,
        evidence,
        keyColumns: p.keyColumns,
        keyWhy: p.keyWhy,
        duplicates: p.duplicates
          ? {
              key: p.duplicates.key,
              distinctBy: p.duplicates.distinctBy,
              flagField: p.duplicates.flagField,
              flagValue: p.duplicates.flagValue,
              why: p.duplicates.why,
            }
          : null,
        rows: p.rows,
        notes: p.notes,
      },
    };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo leer la hoja.') };
  }
}

export async function createTableFromSheet(input: {
  sourceId: string;
  sheetIndex: number;
  name: string;
  description: string;
  fields: TrackerField[];
  columns: Record<string, string>;
  keyColumns: string[];
  duplicates: DuplicateDraft | null;
  intervalMinutes: number;
  notify: boolean;
}): Promise<SchemaResult<{ slug: string; id: string; fields: TrackerField[]; loaded: number }>> {
  const started = performance.now();
  try {
    const { user, db } = await sheetContext();
    if (!UUID_RE.test(String(input?.sourceId)))
      return { ok: false, error: 'Esa hoja ya no existe.' };
    const name = cleanText(input?.name, 80);
    if (!name) return { ok: false, error: 'Ponle un nombre a la tabla.' };
    const index = readSheetIndex(input?.sheetIndex);
    const every = Number(input?.intervalMinutes);
    if (!Number.isInteger(every) || every < 5 || every > 1440)
      return { ok: false, error: 'Cada cuánto: entre 5 y 1440 minutos.' };
    const fields = parseDraftFields(input?.fields);
    const rule = parseDraftRule(input?.duplicates, fields);
    await checkRelations(db, fields);
    const columns = input?.columns ?? {};
    const approved = fields.map((f) => ({ ...f, sourceColumn: String(columns[f.key] ?? f.label) }));
    // Las claves se dicen por el nombre del campo o de su columna; tiene que haber al menos una.
    const keyColumns = (Array.isArray(input?.keyColumns) ? input.keyColumns : [])
      .map(String)
      .filter(Boolean)
      .slice(0, 5);
    if (!keyColumns.length)
      return { ok: false, error: 'Elige al menos una columna que identifique cada fila.' };
    const { data: slugs, error } = await db.from('trackers').select('slug').limit(1000);
    if (error) throw error;
    const slug = slugFromName(
      name,
      ((slugs ?? []) as Array<{ slug: string }>).map((s) => s.slug),
    );
    const out = await createTrackerSync(db, {
      sourceId: input.sourceId,
      sheetIndex: index,
      actorId: user.id,
      tracker: { slug, name, description: cleanText(input?.description, 500) || undefined },
      keyColumns,
      intervalMinutes: every,
      notify: Boolean(input?.notify),
      fields: approved,
      duplicates: rule,
    });
    await audit(db, user.id, started, {
      tracker: out.tracker.slug,
      created: true,
      fromSheet: input.sourceId,
      fields: fields.length,
      loaded: out.outcome.inserted,
    });
    revalidatePath('/trackers');
    return {
      ok: true,
      slug: out.tracker.slug,
      id: out.tracker.id,
      fields,
      loaded: out.outcome.inserted,
    };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo crear la tabla desde la hoja.') };
  }
}

// ---------------------------------------------------------------------------
// Crear una tabla DESDE una carpeta de Drive
// ---------------------------------------------------------------------------

/**
 * La carpeta se lee con las credenciales de Google de quien la crea (igual que
 * `trackers.sync_from_drive_folder`), y sólo si su equipo puede definir tablas
 * y llenarlas desde una carpeta de Drive.
 */
async function folderContext() {
  const { user, db } = await context();
  const denied = await deniedToolPatterns(db, user.id, { failClosed: true });
  if (isToolDenied('trackers.sync_from_drive_folder', denied))
    throw new ValidationError(
      'Tu equipo no tiene permiso para llenar tablas desde una carpeta de Drive.',
    );
  const ctx = buildToolContext({
    organizationId: user.organization.id,
    userId: user.id as UUID,
    agentId: user.id as UUID,
    surface: 'web',
  });
  return { user, db, ctx, drive: { integrations: ctx.integrations, signal: undefined } };
}

const DRIVE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;

export async function findFolders(ref: string): Promise<SchemaResult<{ folders: FolderChoice[] }>> {
  try {
    const { drive } = await folderContext();
    const text = cleanText(ref, 500);
    if (!text) return { ok: false, error: 'Pega el enlace de la carpeta o escribe su nombre.' };
    const fromUrl =
      text.match(/\/folders\/([A-Za-z0-9_-]{10,})/)?.[1] ??
      text.match(/[?&]id=([A-Za-z0-9_-]{10,})/)?.[1] ??
      (/^[A-Za-z0-9_-]{25,}$/.test(text) && /\d/.test(text) ? text : null);
    if (fromUrl) {
      const meta = await driveFolderMeta(drive, fromUrl);
      return { ok: true, folders: [{ id: meta.id, name: meta.name }] };
    }
    const found = await findDriveFolders(drive, text);
    if (!found.length)
      return { ok: false, error: `No encontré en tu Drive una carpeta llamada «${text}».` };
    return { ok: true, folders: found.map((f) => ({ id: f.id, name: f.name })) };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo buscar la carpeta en tu Drive.') };
  }
}

export async function proposeFromFolder(
  folderId: string,
  includeSubfolders: boolean,
): Promise<SchemaResult<{ proposal: FolderProposalView }>> {
  try {
    const { drive } = await folderContext();
    if (!DRIVE_ID_RE.test(String(folderId)))
      return { ok: false, error: 'Esa carpeta no es válida.' };
    const folder = await driveFolderMeta(drive, folderId);
    const p = await proposeFromDriveFolder(drive, folder, {
      includeSubfolders: Boolean(includeSubfolders),
    });
    const evidence: FolderProposalView['evidence'] = {};
    const fields: TrackerField[] = p.fields.map(
      ({ sourceColumn, fromDocument, fromFolder, hint, why, samples, ...field }) => {
        evidence[field.key] = {
          ...(sourceColumn ? { sourceColumn } : {}),
          ...(fromDocument ? { fromDocument } : {}),
          ...(fromFolder ? { fromFolder } : {}),
          ...(hint ? { hint } : {}),
          why,
          samples,
        };
        return field as TrackerField;
      },
    );
    const inv = p.inventory;
    return {
      ok: true,
      proposal: {
        folder: { id: folder.id, name: folder.name },
        recursive: p.recursive,
        inventory: {
          total: inv.total,
          sheets: inv.counts.sheet,
          documents: inv.counts.document,
          images: inv.counts.image,
          unreadable: inv.counts.unreadable,
          subfolders: inv.folders.map((f) => ({ path: f.path, files: f.files })),
          notes: [
            ...(inv.skipped.length
              ? [`Hay ${inv.skipped.length} subcarpeta(s) que no se incluyeron.`]
              : []),
            ...(inv.tooDeep.length
              ? [`${inv.tooDeep.length} subcarpeta(s) están a más de ${inv.maxDepth} niveles.`]
              : []),
            ...(inv.truncated ? [`Sólo se contaron los primeros ${inv.maxFiles} archivos.`] : []),
            ...(inv.problems.length ? [`No se pudo abrir: ${inv.problems.join(', ')}.`] : []),
            ...inv.unreadable.slice(0, 5).map((u) => `«${u.name}»: ${u.reason}`),
          ],
        },
        suggestedName: p.name.slice(0, 80),
        description: p.description,
        fields,
        evidence,
        keyFields: p.keyFields,
        keyWhy: p.keyWhy,
        duplicates: p.duplicates
          ? {
              key: p.duplicates.key,
              distinctBy: p.duplicates.distinctBy,
              flagField: p.duplicates.flagField,
              flagValue: p.duplicates.flagValue,
              why: p.duplicates.why,
            }
          : null,
        sheetRows: p.sheetRows,
        notes: p.notes,
      },
    };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo leer la carpeta.') };
  }
}

export async function createTableFromFolder(input: {
  folder: FolderChoice;
  recursive: boolean;
  name: string;
  description: string;
  fields: TrackerField[];
  sources: Record<
    string,
    { sourceColumn?: string; fromDocument?: boolean; fromFolder?: boolean; hint?: string }
  >;
  keyFields: string[];
  duplicates: DuplicateDraft | null;
  intervalMinutes: number;
  notify: boolean;
}): Promise<SchemaResult<{ slug: string; id: string; fields: TrackerField[] }>> {
  const started = performance.now();
  try {
    const { user, db, ctx } = await folderContext();
    const folderId = String(input?.folder?.id ?? '');
    if (!DRIVE_ID_RE.test(folderId)) return { ok: false, error: 'Esa carpeta no es válida.' };
    const name = cleanText(input?.name, 80);
    if (!name) return { ok: false, error: 'Ponle un nombre a la tabla.' };
    const every = Number(input?.intervalMinutes);
    if (!Number.isInteger(every) || every < 10 || every > 1440)
      return { ok: false, error: 'Cada cuánto: entre 10 y 1440 minutos.' };
    const fields = parseDraftFields(input?.fields);
    const rule = parseDraftRule(input?.duplicates, fields);
    await checkRelations(db, fields);
    const keyFields = (Array.isArray(input?.keyFields) ? input.keyFields : [])
      .map(String)
      .filter((k) => fields.some((f) => f.key === k))
      .slice(0, 5);
    if (!keyFields.length)
      return { ok: false, error: 'Elige al menos un campo que identifique cada registro.' };
    const sources = input?.sources ?? {};
    const approved = fields.map((f) => {
      const s = sources[f.key] ?? {};
      const sourceColumn = typeof s.sourceColumn === 'string' ? s.sourceColumn.slice(0, 120) : '';
      return {
        ...f,
        ...(sourceColumn ? { sourceColumn } : {}),
        fromDocument: Boolean(s.fromDocument),
        ...(s.fromFolder ? { fromFolder: true } : {}),
        ...(typeof s.hint === 'string' && s.hint ? { hint: s.hint.slice(0, 200) } : {}),
      };
    });
    const { data: slugs, error } = await db.from('trackers').select('slug').limit(1000);
    if (error) throw error;
    const slug = slugFromName(
      name,
      ((slugs ?? []) as Array<{ slug: string }>).map((s) => s.slug),
    );
    const tool = getTool('trackers.sync_from_drive_folder');
    if (!tool) return { ok: false, error: 'Esta instalación no lee carpetas de Drive.' };
    await tool.handler(
      tool.inputSchema.parse({
        folder: `https://drive.google.com/drive/folders/${folderId}`,
        table: slug,
        tableName: name,
        tableDescription: cleanText(input?.description, 500) || undefined,
        fields: approved,
        keyFields,
        ...(rule ? { duplicates: rule } : {}),
        recursive: Boolean(input?.recursive),
        intervalMinutes: every,
        notify: Boolean(input?.notify),
      }),
      ctx,
    );
    const tracker = await getTrackerBySlug(db, slug);
    if (!tracker) return { ok: false, error: 'No se pudo crear la tabla.' };
    await audit(
      db,
      user.id,
      started,
      {
        tracker: tracker.slug,
        created: true,
        fromDriveFolder: folderId,
        recursive: Boolean(input?.recursive),
        fields: fields.length,
      },
      'trackers.sync_from_drive_folder',
    );
    revalidatePath('/trackers');
    return { ok: true, slug: tracker.slug, id: tracker.id, fields };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo crear la tabla desde la carpeta.') };
  }
}

/** Las tablas del espacio (para elegir a cuál apunta una relación al crear una tabla nueva). */
export async function listTrackerChoices(): Promise<Array<{ slug: string; name: string }>> {
  try {
    const user = await requireSession();
    const db = getOrgScopedClient(user.organization.id);
    return (await listTrackers(db, 100)).map((t) => ({ slug: t.slug, name: t.name }));
  } catch {
    return [];
  }
}
