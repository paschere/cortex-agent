'use server';

import type { GridColumn, GridQueryResult, GridRow, GridView } from '@/components/datagrid/types';
import { buildToolContext } from '@/lib/agent';
import { readPeopleNames, readTrackerEntries, readTrackerEntry } from '@/lib/datagrid/tracker-read';
import {
  FIELD_KEY_PATTERN,
  MAX_SELECT_OPTIONS,
  MAX_TRACKER_FIELDS,
  TRACKER_FIELD_TYPES,
  type TrackerFieldType,
  fieldKeyFrom,
  slugFromName,
  toTrackerValue,
  trackerColumns,
  trackerGridRow,
} from '@/lib/datagrid/trackers';
import { applyView, normalizeView } from '@/lib/datagrid/view';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { deniedToolPatterns, isToolDenied } from '@/lib/tool-access';
import {
  type TrackerField,
  type TrackerRow,
  defineTracker,
  getTool,
  getTrackerById,
  parseDocument,
  readWorkSettings,
  rowLabel,
  shapeValues,
  syncWork,
  trackerFieldsSchema,
  upsertRow,
  writeAuditEvent,
} from '@cortex/agent-tools';
import { NotFoundError, type UUID, ValidationError, logger } from '@cortex/core';
import { revalidatePath } from 'next/cache';
import type { ActionResult, HistoryEntry, NewTrackerInput } from './types';

/**
 * LO QUE SE CAMBIA DESDE «TABLAS».
 *
 * Cada export es un endpoint que cualquiera con sesión puede llamar, así que
 * cada uno vuelve a mirar quién es y qué puede, y escribe por el MISMO camino
 * que el chat:
 *
 *   - Editar, crear y editar en bloque pasan por `upsertRow` — la validación de
 *     `trackers.upsert` (tipos, opciones, obligatorios) — y respetan lo que el
 *     equipo de la persona tenga prohibido sobre `trackers.upsert`.
 *   - Borrar filas: lo prohibido sobre `trackers.remove`.
 *   - Crear una tabla o agregarle una columna: `defineTracker`, lo prohibido
 *     sobre `trackers.define`. La confirmación es el diálogo de la pantalla.
 *   - «Sincronizar ahora» es `trackers.retry_sync`, la misma herramienta.
 *
 * Cada cambio deja su fila en `audit_events` (superficie `web`) con qué filas
 * y qué campos tocó: eso es lo que el historial de una fila lee después. Si la
 * tabla «se mide como trabajo», el registro de trabajo se re-sincroniza.
 *
 * Devuelven `{ ok, error }` en vez de lanzar: en producción Next borra el
 * mensaje de lo que una acción lanza, y la persona tiene que leer por qué no.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BULK = 1000;
const MAX_IMPORT = 1000;
const QUERY_CAP = 20_000;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const DENIED: Record<string, string> = {
  'trackers.upsert': 'Tu equipo no tiene permiso para cambiar tablas.',
  'trackers.remove': 'Tu equipo no tiene permiso para borrar filas de tablas.',
  'trackers.define': 'Tu equipo no tiene permiso para crear tablas ni cambiar sus columnas.',
  'trackers.retry_sync': 'Tu equipo no tiene permiso para correr sincronizaciones.',
};

function message(err: unknown, fallback: string): string {
  if (err instanceof ValidationError || err instanceof NotFoundError) return err.message;
  const text = err instanceof Error ? err.message : '';
  return text && text.length < 280 && !/[{}]|relation|column|violates|PGRST|JSON/.test(text)
    ? text
    : fallback;
}

async function context(toolId: keyof typeof DENIED) {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const denied = await deniedToolPatterns(db, user.id, { failClosed: true });
  if (isToolDenied(toolId, denied)) throw new ValidationError(DENIED[toolId] ?? 'Sin permiso.');
  return { user, db };
}

type Db = ReturnType<typeof getOrgScopedClient>;

async function mustTracker(db: Db, trackerId: string): Promise<TrackerRow> {
  if (!UUID_RE.test(trackerId)) throw new NotFoundError('Esa tabla ya no existe.');
  const tracker = await getTrackerById(db, trackerId);
  if (!tracker) throw new NotFoundError('Esa tabla ya no existe.');
  return tracker;
}

function audit(
  db: Db,
  userId: string,
  toolId: string,
  started: number,
  metadata: Record<string, unknown>,
  status: 'ok' | 'error' = 'ok',
) {
  return writeAuditEvent({
    db,
    userId: userId as UUID,
    toolId,
    input: metadata,
    status,
    latencyMs: Math.round(performance.now() - started),
    surface: 'web',
    decision: 'confirmed',
    metadata: { from: 'tablas', ...metadata },
  });
}

/** Si la tabla se mide como trabajo, que el registro vea el cambio. */
async function resyncWork(db: Db, organizationId: string, slug: string) {
  try {
    const settings = await readWorkSettings(db);
    if (!settings.trackerMappings.some((m) => m.tracker === slug)) return;
    await syncWork(db, organizationId, { onlyTracker: slug });
  } catch (err) {
    logger.warn({ err, slug }, 'tablas: la fila cambió pero el registro de trabajo no se refrescó');
  }
}

/** Los valores de una fila con un cambio encima, solo con campos que existen. */
function merged(
  fields: TrackerField[],
  current: Record<string, string | number>,
  patch: Record<string, unknown>,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const f of fields) {
    const v = f.key in patch ? toTrackerValue(f.type, patch[f.key]) : current[f.key];
    if (v !== undefined && v !== '') out[f.key] = v;
  }
  return out;
}

/** El nombre que alguien le puso a mano a la fila se conserva al editar. */
function keptLabel(
  fields: TrackerField[],
  entry: { label: string; values: Record<string, string | number> },
) {
  return entry.label !== rowLabel(fields, entry.values) ? entry.label : undefined;
}

// ---------------------------------------------------------------------------
// Celdas y filas
// ---------------------------------------------------------------------------

export async function editTrackerCell(
  trackerId: string,
  rowId: string,
  key: string,
  value: unknown,
): Promise<ActionResult<{ row: GridRow }>> {
  const started = performance.now();
  try {
    const { user, db } = await context('trackers.upsert');
    const tracker = await mustTracker(db, trackerId);
    const field = tracker.fields.find((f) => f.key === key);
    if (!field) return { ok: false, error: 'Esa columna no se edita.' };
    if (!UUID_RE.test(rowId)) return { ok: false, error: 'Esa fila ya no existe.' };
    const entry = await readTrackerEntry(db, tracker.id, rowId);
    if (!entry) return { ok: false, error: 'Esa fila ya no está en la tabla.' };
    const before = entry.values[key] ?? null;
    const saved = await upsertRow(db, {
      tracker,
      rowId,
      values: merged(tracker.fields, entry.values, { [key]: value }),
      label: keptLabel(tracker.fields, entry),
      userId: user.id,
    });
    await audit(db, user.id, 'trackers.upsert', started, {
      tracker: tracker.slug,
      rowIds: [rowId],
      fields: [key],
      changes: { [key]: { from: before, to: saved.values[key] ?? null } },
    });
    await resyncWork(db, user.organization.id, tracker.slug);
    return { ok: true, row: trackerGridRow(saved) };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo guardar el cambio.') };
  }
}

export async function bulkEditTrackerRows(
  trackerId: string,
  rowIds: string[],
  key: string,
  value: unknown,
): Promise<ActionResult<{ changed: number }>> {
  const started = performance.now();
  try {
    const { user, db } = await context('trackers.upsert');
    const tracker = await mustTracker(db, trackerId);
    const field = tracker.fields.find((f) => f.key === key);
    if (!field) return { ok: false, error: 'Esa columna no se edita.' };
    const ids = [
      ...new Set((Array.isArray(rowIds) ? rowIds : []).filter((id) => UUID_RE.test(id))),
    ];
    if (!ids.length) return { ok: false, error: 'Marca al menos una fila.' };
    if (ids.length > MAX_BULK)
      return { ok: false, error: `Son demasiadas de una vez (máximo ${MAX_BULK}).` };
    const { data, error } = await db
      .from('tracker_rows')
      .select('id, label, values')
      .eq('tracker_id', tracker.id)
      .in('id', ids);
    if (error) throw error;
    const rows = (data ?? []) as Array<{
      id: string;
      label: string;
      values: Record<string, string | number>;
    }>;
    let changed = 0;
    for (const entry of rows) {
      await upsertRow(db, {
        tracker,
        rowId: entry.id,
        values: merged(tracker.fields, entry.values ?? {}, { [key]: value }),
        label: keptLabel(tracker.fields, { label: entry.label, values: entry.values ?? {} }),
        userId: user.id,
      });
      changed += 1;
    }
    await audit(db, user.id, 'trackers.upsert', started, {
      tracker: tracker.slug,
      rowIds: rows.map((r) => r.id),
      fields: [key],
      bulk: true,
      count: changed,
    });
    await resyncWork(db, user.organization.id, tracker.slug);
    revalidatePath(`/trackers/${tracker.slug}`);
    return { ok: true, changed };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo aplicar el cambio a todas.') };
  }
}

export async function createTrackerRow(
  trackerId: string,
  values: Record<string, unknown>,
): Promise<ActionResult<{ row: GridRow }>> {
  const started = performance.now();
  try {
    const { user, db } = await context('trackers.upsert');
    const tracker = await mustTracker(db, trackerId);
    const saved = await upsertRow(db, {
      tracker,
      values: merged(tracker.fields, {}, values && typeof values === 'object' ? values : {}),
      userId: user.id,
    });
    await audit(db, user.id, 'trackers.upsert', started, {
      tracker: tracker.slug,
      rowIds: [saved.id],
      created: true,
    });
    await resyncWork(db, user.organization.id, tracker.slug);
    return { ok: true, row: trackerGridRow(saved) };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo crear la fila.') };
  }
}

export async function deleteTrackerRows(
  trackerId: string,
  rowIds: string[],
): Promise<ActionResult<{ removed: number }>> {
  const started = performance.now();
  try {
    const { user, db } = await context('trackers.remove');
    const tracker = await mustTracker(db, trackerId);
    const ids = [
      ...new Set((Array.isArray(rowIds) ? rowIds : []).filter((id) => UUID_RE.test(id))),
    ];
    if (!ids.length) return { ok: false, error: 'Marca al menos una fila.' };
    if (ids.length > MAX_BULK)
      return { ok: false, error: `Son demasiadas de una vez (máximo ${MAX_BULK}).` };
    const { data, error } = await db
      .from('tracker_rows')
      .delete()
      .eq('tracker_id', tracker.id)
      .in('id', ids)
      .select('id');
    if (error) throw error;
    const removed = (data ?? []).length;
    await audit(db, user.id, 'trackers.remove', started, {
      tracker: tracker.slug,
      rowIds: ids.slice(0, 200),
      count: removed,
    });
    await resyncWork(db, user.organization.id, tracker.slug);
    revalidatePath(`/trackers/${tracker.slug}`);
    return { ok: true, removed };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudieron borrar.') };
  }
}

// ---------------------------------------------------------------------------
// Columnas y tablas
// ---------------------------------------------------------------------------

function toFieldType(type: string): TrackerFieldType | null {
  if ((TRACKER_FIELD_TYPES as string[]).includes(type)) return type as TrackerFieldType;
  if (type === 'status') return 'select';
  if (type === 'long_text') return 'text';
  return null;
}

export async function addTrackerColumn(
  trackerId: string,
  column: { label: string; type: string; options?: string[]; required?: boolean },
): Promise<ActionResult<{ column: GridColumn }>> {
  const started = performance.now();
  try {
    const { user, db } = await context('trackers.define');
    const tracker = await mustTracker(db, trackerId);
    const label = String(column?.label ?? '')
      .trim()
      .slice(0, 60);
    if (!label) return { ok: false, error: 'Ponle un nombre a la columna.' };
    const type = toFieldType(String(column?.type ?? ''));
    if (!type)
      return { ok: false, error: 'Las tablas tienen texto, número, plata, fecha u opciones.' };
    if (tracker.fields.length >= MAX_TRACKER_FIELDS)
      return { ok: false, error: `Una tabla tiene hasta ${MAX_TRACKER_FIELDS} columnas.` };
    if (tracker.fields.some((f) => f.label.toLowerCase() === label.toLowerCase()))
      return { ok: false, error: `Ya hay una columna «${label}».` };
    const options = [
      ...new Set((column.options ?? []).map((o) => String(o).trim().slice(0, 80)).filter(Boolean)),
    ].slice(0, MAX_SELECT_OPTIONS);
    const field: TrackerField = {
      key: fieldKeyFrom(
        label,
        tracker.fields.map((f) => f.key),
      ),
      label,
      type,
      required: Boolean(column.required),
      ...(type === 'select' ? { options } : {}),
    };
    if (!FIELD_KEY_PATTERN.test(field.key))
      return { ok: false, error: 'Ese nombre no sirve como columna.' };
    const fields = trackerFieldsSchema.parse([...tracker.fields, field]);
    await defineTracker(db, {
      slug: tracker.slug,
      name: tracker.name,
      description: tracker.description,
      fields,
      userId: user.id,
    });
    await audit(db, user.id, 'trackers.define', started, {
      tracker: tracker.slug,
      addedField: field.key,
      type,
    });
    revalidatePath(`/trackers/${tracker.slug}`);
    const [gridColumn] = trackerColumns([field], { withUpdated: false });
    const col: GridColumn = { ...(gridColumn as GridColumn), pinned: false, primary: false };
    return { ok: true, column: col };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo agregar la columna.') };
  }
}

export async function createTracker(
  input: NewTrackerInput,
): Promise<ActionResult<{ slug: string; id: string; keys: string[] }>> {
  const started = performance.now();
  try {
    const { user, db } = await context('trackers.define');
    const name = String(input?.name ?? '')
      .trim()
      .slice(0, 80);
    if (!name) return { ok: false, error: 'Ponle un nombre a la tabla.' };
    const raw = Array.isArray(input?.fields) ? input.fields : [];
    if (!raw.length) return { ok: false, error: 'Una tabla necesita al menos una columna.' };
    const taken: string[] = [];
    const fields: TrackerField[] = raw.slice(0, MAX_TRACKER_FIELDS).map((f) => {
      const type = toFieldType(String(f.type)) ?? 'text';
      const label =
        String(f.label ?? '')
          .trim()
          .slice(0, 60) || 'Columna';
      const key = fieldKeyFrom(label, taken);
      taken.push(key);
      const options = [
        ...new Set((f.options ?? []).map((o) => String(o).trim().slice(0, 80)).filter(Boolean)),
      ].slice(0, MAX_SELECT_OPTIONS);
      return {
        key,
        label,
        type,
        required: Boolean(f.required),
        ...(type === 'select' ? { options } : {}),
      };
    });
    const parsed = trackerFieldsSchema.safeParse(fields);
    if (!parsed.success)
      return {
        ok: false,
        error: parsed.error.issues[0]?.message ?? 'Revisa las columnas de la tabla.',
      };
    const { data: slugs, error } = await db.from('trackers').select('slug').limit(1000);
    if (error) throw error;
    const slug = slugFromName(
      name,
      ((slugs ?? []) as Array<{ slug: string }>).map((s) => s.slug),
    );
    const { tracker, created } = await defineTracker(db, {
      slug,
      name,
      description: String(input.description ?? '')
        .trim()
        .slice(0, 500),
      fields: parsed.data,
      userId: user.id,
    });
    if (!created) return { ok: false, error: 'Ya existe una tabla con ese nombre.' };
    await audit(db, user.id, 'trackers.define', started, {
      tracker: tracker.slug,
      created: true,
      fields: fields.length,
    });
    revalidatePath('/trackers');
    return { ok: true, slug: tracker.slug, id: tracker.id, keys: fields.map((f) => f.key) };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo crear la tabla.') };
  }
}

/**
 * Filas importadas de un CSV/Excel, en lotes. Cada fila pasa por la misma
 * validación que `trackers.upsert` (`shapeValues`); la que no pasa se cuenta
 * con su número y su motivo, y las demás entran.
 */
export async function importTrackerRows(
  trackerId: string,
  rows: Array<Record<string, string | number>>,
): Promise<ActionResult<{ inserted: number; errors: Array<{ row: number; message: string }> }>> {
  const started = performance.now();
  try {
    const { user, db } = await context('trackers.upsert');
    const tracker = await mustTracker(db, trackerId);
    const list = Array.isArray(rows) ? rows.slice(0, MAX_IMPORT) : [];
    const errors: Array<{ row: number; message: string }> = [];
    const inserts: Array<Record<string, unknown>> = [];
    for (const [i, raw] of list.entries()) {
      try {
        const values = shapeValues(tracker.fields, merged(tracker.fields, {}, raw ?? {}));
        inserts.push({
          tracker_id: tracker.id,
          label: rowLabel(tracker.fields, values),
          values,
          created_by: user.id,
        });
      } catch (err) {
        errors.push({ row: i + 1, message: message(err, 'Fila inválida.') });
      }
    }
    let inserted = 0;
    for (let i = 0; i < inserts.length; i += 500) {
      const chunk = inserts.slice(i, i + 500);
      const { error } = await db.from('tracker_rows').insert(chunk);
      if (error) throw error;
      inserted += chunk.length;
    }
    await audit(db, user.id, 'trackers.upsert', started, {
      tracker: tracker.slug,
      imported: inserted,
      rejected: errors.length,
    });
    await resyncWork(db, user.organization.id, tracker.slug);
    revalidatePath(`/trackers/${tracker.slug}`);
    revalidatePath('/trackers');
    return { ok: true, inserted, errors: errors.slice(0, 50) };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudieron importar las filas.') };
  }
}

/** Un Excel (o CSV) subido → las filas de su primera hoja, como texto. */
export async function readSpreadsheetFile(
  form: FormData,
): Promise<ActionResult<{ rows: string[][]; sheet: string }>> {
  try {
    await requireSession();
    const file = form.get('file');
    if (!(file instanceof File)) return { ok: false, error: 'Elige un archivo.' };
    if (file.size > 8 * 1024 * 1024) return { ok: false, error: 'El archivo pesa más de 8 MB.' };
    const name = file.name.toLowerCase();
    const mime = name.endsWith('.csv') ? 'text/csv' : name.endsWith('.xlsx') ? XLSX_MIME : '';
    if (!mime) return { ok: false, error: 'Sube un .xlsx o un .csv.' };
    const sheets = (await parseDocument(Buffer.from(await file.arrayBuffer()), mime)).tables ?? [];
    const first = sheets.find((s) => s.rows.some((r) => r.some((c) => c !== null && c !== '')));
    if (!first) return { ok: false, error: 'El archivo no tiene filas.' };
    const rows = first.rows
      .slice(0, 5001)
      .map((r) =>
        r.map((c) =>
          c === null || c === undefined ? '' : typeof c === 'number' ? String(c) : String(c),
        ),
      )
      .filter((r) => r.some((c) => c.trim() !== ''));
    return { ok: true, rows, sheet: first.name };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo leer el archivo.') };
  }
}

// ---------------------------------------------------------------------------
// Leer: páginas en el servidor e historial
// ---------------------------------------------------------------------------

export async function queryTrackerRows(
  trackerId: string,
  view: GridView,
  page: { offset: number; limit: number },
): Promise<ActionResult<GridQueryResult>> {
  try {
    const user = await requireSession();
    const db = getOrgScopedClient(user.organization.id);
    const tracker = await mustTracker(db, trackerId);
    const columns = trackerColumns(tracker.fields);
    const entries = await readTrackerEntries(db, tracker.id, { limit: QUERY_CAP });
    const result = applyView(entries.map(trackerGridRow), columns, normalizeView(columns, view));
    const offset = Math.max(0, Math.floor(page?.offset ?? 0));
    const limit = Math.max(1, Math.min(Math.floor(page?.limit ?? 500), 2000));
    return { ok: true, rows: result.rows.slice(offset, offset + limit), total: result.rows.length };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudieron traer las filas.') };
  }
}

export async function trackerRowHistory(
  trackerId: string,
  rowId: string,
): Promise<ActionResult<{ entries: HistoryEntry[] }>> {
  try {
    const user = await requireSession();
    const db = getOrgScopedClient(user.organization.id);
    const tracker = await mustTracker(db, trackerId);
    if (!UUID_RE.test(rowId)) return { ok: false, error: 'Esa fila ya no existe.' };
    const entry = await readTrackerEntry(db, tracker.id, rowId);
    if (!entry) return { ok: false, error: 'Esa fila ya no está en la tabla.' };
    const [audits, viewEvents] = await Promise.all([
      db
        .from('audit_events')
        .select('user_id, metadata, created_at')
        .in('tool_id', ['trackers.upsert'])
        .eq('status', 'ok')
        .contains('metadata', { rowIds: [rowId] })
        .order('created_at', { ascending: false })
        .limit(30),
      db
        .from('custom_view_events')
        .select('actor, kind, changes, created_at')
        .eq('tracker_row_id', rowId)
        .order('created_at', { ascending: false })
        .limit(30),
    ]);
    if (audits.error) throw audits.error;
    if (viewEvents.error) throw viewEvents.error;
    const auditRows = (audits.data ?? []) as Array<{
      user_id: string;
      metadata: Record<string, unknown>;
      created_at: string;
    }>;
    const eventRows = (viewEvents.data ?? []) as Array<{
      actor: string | null;
      kind: string;
      changes: Record<string, { from?: unknown; to?: unknown }>;
      created_at: string;
    }>;
    const names = await readPeopleNames(db, [
      ...auditRows.map((a) => a.user_id),
      ...eventRows.map((e) => e.actor ?? ''),
      entry.created_by ?? '',
    ]);
    const label = (key: string) => tracker.fields.find((f) => f.key === key)?.label ?? key;
    const show = (v: unknown) =>
      v === null || v === undefined || v === '' ? 'vacío' : `«${String(v)}»`;
    const describeChanges = (
      changes: Record<string, { from?: unknown; to?: unknown }> | undefined,
      keys?: unknown,
    ) => {
      if (changes && Object.keys(changes).length)
        return Object.entries(changes)
          .map(([k, c]) => `${label(k)}: ${show(c?.from)} → ${show(c?.to)}`)
          .join(' · ');
      if (Array.isArray(keys) && keys.length)
        return `Cambió ${keys.map((k) => label(String(k))).join(', ')}`;
      return 'Editó la fila';
    };
    const entries: HistoryEntry[] = [
      ...auditRows.map((a) => ({
        at: a.created_at,
        who: names.get(a.user_id) ?? 'Alguien',
        what: a.metadata?.created
          ? 'Creó la fila'
          : a.metadata?.bulk
            ? `${describeChanges(undefined, a.metadata.fields)} (en bloque)`
            : describeChanges(
                a.metadata?.changes as Record<string, { from?: unknown; to?: unknown }>,
                a.metadata?.fields,
              ),
      })),
      ...eventRows.map((e) => ({
        at: e.created_at,
        who: e.actor ? (names.get(e.actor) ?? 'Alguien') : 'Alguien desde una vista pública',
        what: `${e.kind === 'move' ? 'Movió la tarjeta' : e.kind === 'action' ? 'Usó un botón' : 'Editó desde una vista'}${
          Object.keys(e.changes ?? {}).length ? `: ${describeChanges(e.changes)}` : ''
        }`,
      })),
    ];
    if (!entries.some((e) => e.what === 'Creó la fila'))
      entries.push({
        at: entry.created_at,
        who: entry.created_by
          ? (names.get(entry.created_by) ?? 'Alguien')
          : entry.external_key
            ? 'La sincronización'
            : 'Cortex',
        what: entry.external_key ? 'La trajo la sincronización' : 'Creó la fila',
      });
    entries.sort((a, b) => b.at.localeCompare(a.at));
    return { ok: true, entries: entries.slice(0, 40) };
  } catch (err) {
    return { ok: false, error: message(err, 'No se pudo leer el historial.') };
  }
}

// ---------------------------------------------------------------------------
// Sincronizar ahora
// ---------------------------------------------------------------------------

export async function syncTrackerNow(
  kind: 'table_sync' | 'drive_folder',
  syncId: string,
): Promise<ActionResult<{ message: string }>> {
  const started = performance.now();
  try {
    const { user, db } = await context('trackers.retry_sync');
    if (kind !== 'table_sync' && kind !== 'drive_folder')
      return { ok: false, error: 'No sé qué sincronizar.' };
    if (!UUID_RE.test(syncId)) return { ok: false, error: 'Esa sincronización ya no existe.' };
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
      markdown: string;
    };
    await audit(db, user.id, 'trackers.retry_sync', started, { kind, syncId, queued: out.queued });
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
