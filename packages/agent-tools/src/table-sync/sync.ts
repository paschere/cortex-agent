import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SheetData, SheetValue } from '../kb/spreadsheets';
import { type TrackerField, rowLabel, trackerFieldsSchema } from '../trackers/schema';
import { TRACKER_COLUMNS, type TrackerRow, defineTracker, shapeValues } from '../trackers/store';
import { dayOfCell, headerKey, inferSheetFields } from '../views/feed-sources';

/**
 * UNA FUENTE QUE LLENA UNA TABLA SOLA (migración 0161).
 *
 * Una hoja o una API conectada en el Feed, leída cada `interval_minutes`, cuyas
 * filas entran a una tabla de la empresa: nuevas se agregan, las que cambiaron
 * se actualizan, identificadas por sus campos CLAVE (vuelo + fecha). Lo que
 * sale de la fuente no se borra de la tabla.
 *
 * Este archivo es el motor: planear (puro) y aplicar (con el handle del
 * espacio). Refrescar la fuente —llamar la API, leer la hoja— es de la capa web
 * (lib/feed/api-source.ts), que tiene las credenciales; el trabajo programado
 * refresca y después llama `applyTrackerSync` con la captura nueva.
 */

export const SYNC_ROW_CAP = 1000;
const TZ = 'America/Bogota';

export interface TrackerSyncRow {
  id: string;
  organization_id?: string;
  source_id: string;
  sheet_index: number;
  tracker_id: string;
  mapping: Record<string, string>;
  key_fields: string[];
  interval_minutes: number;
  notify: boolean;
  enabled: boolean;
  created_by: string;
  next_run_at: string;
  last_run_at: string | null;
  last_status: 'ok' | 'error' | null;
  last_error: string | null;
  last_inserted: number;
  last_updated: number;
  last_skipped: number;
}

export const SYNC_COLUMNS =
  'id, source_id, sheet_index, tracker_id, mapping, key_fields, interval_minutes, notify, enabled, created_by, next_run_at, last_run_at, last_status, last_error, last_inserted, last_updated, last_skipped';

// ---------------------------------------------------------------------------
// Celdas → valores de la tabla
// ---------------------------------------------------------------------------

const HAS_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/** «2026-09-25T15:05:00Z» → «2026-09-25 10:05» en Bogotá. */
export function bogotaDateTime(text: string): string | null {
  const t = Date.parse(text);
  if (Number.isNaN(t)) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(t));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour') === '24' ? '00' : get('hour')}:${get('minute')}`;
}

/**
 * Los campos de una tabla NUEVA a partir de la fuente. Igual que la vista del
 * Feed, con dos cambios para que la sincronización no se trabe:
 *   - una columna con hora («2026-09-25T15:05Z») es TEXTO en hora de Bogotá, no
 *     fecha: una llegada sin hora no sirve;
 *   - las opciones de un campo de opciones se amplían solas cuando la fuente
 *     trae un valor nuevo (ver `applyTrackerSync`), así que no se rechaza nada
 *     por un estado que la primera lectura no vio.
 */
export function fieldsFromSheet(sheet: SheetData): {
  fields: TrackerField[];
  mapping: Record<string, string>;
} {
  const header = sheet.rows[0] ?? [];
  const data = sheet.rows.slice(1, 201);
  const shape = inferSheetFields(header, data);
  const mapping: Record<string, string> = {};
  const fields = shape.fields.slice(0, 20).map((field, i) => {
    const col = shape.columns[i] ?? i;
    mapping[field.key] = String(header[col] ?? '');
    const timed = data.some(
      (r) => typeof r[col] === 'string' && HAS_TIME.test(String(r[col]).trim()),
    );
    return field.type === 'date' && timed ? { ...field, type: 'text' as const } : field;
  });
  return { fields, mapping };
}

function cellFor(field: TrackerField, cell: SheetValue | undefined): string | number | undefined {
  if (cell === null || cell === undefined) return undefined;
  if (typeof cell === 'boolean') return cell ? 'Sí' : 'No';
  const text = String(cell).trim();
  if (!text) return undefined;
  switch (field.type) {
    case 'number':
    case 'money': {
      const n = typeof cell === 'number' ? cell : Number(text.replace(/\s/g, '').replace(',', '.'));
      return Number.isFinite(n) ? n : undefined;
    }
    case 'date':
      return dayOfCell(text) ?? undefined;
    default:
      return HAS_TIME.test(text)
        ? (bogotaDateTime(text) ?? text.slice(0, 400))
        : text.slice(0, 400);
  }
}

export interface PlannedRow {
  key: string;
  values: Record<string, string | number>;
  line: number;
}

/**
 * Qué filas de la fuente van a la tabla, puro. Una fila sin algún campo clave
 * no tiene identidad y se salta (contada): sin clave, correr dos veces la
 * duplicaría. Dos filas con la misma clave: gana la última de la fuente.
 */
export function planSync(
  sheet: SheetData,
  fields: TrackerField[],
  mapping: Record<string, string>,
  keyFields: string[],
): {
  rows: PlannedRow[];
  skipped: number;
  missingHeaders: string[];
  newOptions: Record<string, string[]>;
} {
  const header = (sheet.rows[0] ?? []).map((h) => String(h ?? '').trim());
  const colOf = new Map<string, number>();
  const missingHeaders: string[] = [];
  for (const [fieldKey, source] of Object.entries(mapping)) {
    const col = header.indexOf(String(source).trim());
    if (col < 0) missingHeaders.push(source);
    else colOf.set(fieldKey, col);
  }
  const byKey = new Map<string, PlannedRow>();
  const newOptions: Record<string, Set<string>> = {};
  let skipped = 0;
  const body = sheet.rows.slice(1, SYNC_ROW_CAP + 1);
  body.forEach((row, i) => {
    const values: Record<string, string | number> = {};
    for (const field of fields) {
      const col = colOf.get(field.key);
      if (col === undefined) continue;
      const v = cellFor(field, row[col]);
      if (v === undefined) continue;
      values[field.key] = v;
      if (field.type === 'select' && !field.options?.includes(String(v))) {
        newOptions[field.key] ??= new Set();
        newOptions[field.key]?.add(String(v).slice(0, 80));
      }
    }
    const parts = keyFields.map((k) => values[k]);
    if (parts.some((p) => p === undefined || p === '')) {
      skipped += 1;
      return;
    }
    const key = parts
      .map((p) => String(p))
      .join(' | ')
      .slice(0, 400);
    byKey.set(key, { key, values, line: i + 2 });
  });
  return {
    rows: [...byKey.values()],
    skipped,
    missingHeaders,
    newOptions: Object.fromEntries(Object.entries(newOptions).map(([k, v]) => [k, [...v]])),
  };
}

function sameValues(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (String(a[k] ?? '') !== String(b[k] ?? '')) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Aplicar
// ---------------------------------------------------------------------------

export interface SyncOutcome {
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
  newLabels: string[];
  changedLabels: string[];
}

/**
 * Aplica una captura a la tabla. `db` es el handle del espacio. Idempotente:
 * la clave externa es única por tabla, así que dos corridas con la misma
 * captura no cambian nada la segunda vez.
 */
export async function applyTrackerSync(
  db: SupabaseClient,
  sync: Pick<TrackerSyncRow, 'tracker_id' | 'mapping' | 'key_fields' | 'created_by'>,
  sheet: SheetData,
): Promise<SyncOutcome> {
  const { data: t, error: tError } = await db
    .from('trackers')
    .select(TRACKER_COLUMNS)
    .eq('id', sync.tracker_id)
    .maybeSingle();
  if (tError) throw tError;
  if (!t) throw new NotFoundError('La tabla de esta sincronización ya no existe.');
  let tracker = t as unknown as TrackerRow;

  let plan = planSync(sheet, tracker.fields, sync.mapping, sync.key_fields);
  if (plan.missingHeaders.length)
    throw new ValidationError(
      `La fuente ya no trae ${plan.missingHeaders.map((h) => `«${h}»`).join(', ')}. Revisa la sincronización.`,
    );

  // Un estado que la primera lectura no vio amplía las opciones en vez de
  // rechazar la fila. Tope de 30, el del esquema.
  if (Object.keys(plan.newOptions).length) {
    const fields = tracker.fields.map((f) =>
      plan.newOptions[f.key]
        ? { ...f, options: [...(f.options ?? []), ...(plan.newOptions[f.key] ?? [])].slice(0, 30) }
        : f,
    );
    const parsed = trackerFieldsSchema.parse(fields);
    const { tracker: updated } = await defineTracker(db, {
      slug: tracker.slug,
      name: tracker.name,
      description: tracker.description,
      fields: parsed,
      userId: sync.created_by,
    });
    tracker = updated;
    plan = planSync(sheet, tracker.fields, sync.mapping, sync.key_fields);
  }

  const outcome: SyncOutcome = {
    inserted: 0,
    updated: 0,
    unchanged: 0,
    skipped: plan.skipped,
    newLabels: [],
    changedLabels: [],
  };
  for (let i = 0; i < plan.rows.length; i += 200) {
    const chunk = plan.rows.slice(i, i + 200);
    const { data: existing, error } = await db
      .from('tracker_rows')
      .select('id, external_key, values')
      .eq('tracker_id', tracker.id)
      .in(
        'external_key',
        chunk.map((r) => r.key),
      );
    if (error) throw error;
    const byKey = new Map(
      (
        (existing ?? []) as Array<{
          id: string;
          external_key: string;
          values: Record<string, unknown>;
        }>
      ).map((r) => [r.external_key, r]),
    );
    for (const row of chunk) {
      let values: Record<string, string | number>;
      try {
        values = shapeValues(tracker.fields, row.values);
      } catch {
        outcome.skipped += 1;
        continue;
      }
      const label = rowLabel(tracker.fields, values);
      const found = byKey.get(row.key);
      if (!found) {
        const { error: insertError } = await db.from('tracker_rows').insert({
          tracker_id: tracker.id,
          label,
          values,
          external_key: row.key,
          created_by: sync.created_by,
        });
        // Otra corrida la insertó entre la lectura y ésta: no es un error.
        if (insertError && (insertError as { code?: string }).code !== '23505') throw insertError;
        if (!insertError) {
          outcome.inserted += 1;
          outcome.newLabels.push(label);
        }
      } else if (!sameValues(found.values ?? {}, values)) {
        const { error: updateError } = await db
          .from('tracker_rows')
          .update({ label, values, updated_at: new Date().toISOString() })
          .eq('id', found.id)
          .eq('tracker_id', tracker.id);
        if (updateError) throw updateError;
        outcome.updated += 1;
        outcome.changedLabels.push(label);
      } else outcome.unchanged += 1;
    }
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Crear una sincronización
// ---------------------------------------------------------------------------

/** La captura vigente de una fuente, sólo si es de `actorId` y no venció. */
export async function latestSourceSheet(
  db: SupabaseClient,
  sourceId: string,
  actorId: string,
  sheetIndex: number,
): Promise<{ sheet: SheetData; sourceName: string } | null> {
  const { data: source, error } = await db
    .from('feed_sources')
    .select('id, name, latest_attachment_id')
    .eq('id', sourceId)
    .eq('actor_id', actorId)
    .maybeSingle();
  if (error) throw error;
  const s = source as { name: string; latest_attachment_id: string | null } | null;
  if (!s?.latest_attachment_id) return null;
  const { data: capture, error: cError } = await db
    .from('chat_attachments')
    .select('feed_tables')
    .eq('id', s.latest_attachment_id)
    .eq('created_by', actorId)
    .gt('purge_at', new Date().toISOString())
    .maybeSingle();
  if (cError) throw cError;
  const tables = (capture as { feed_tables: SheetData[] | null } | null)?.feed_tables;
  const sheet = tables?.[sheetIndex];
  return sheet ? { sheet, sourceName: s.name } : null;
}

export async function createTrackerSync(
  db: SupabaseClient,
  input: {
    sourceId: string;
    sheetIndex: number;
    actorId: string;
    tracker: { slug: string; name: string; description?: string };
    keyColumns: string[];
    intervalMinutes: number;
    notify: boolean;
  },
): Promise<{
  sync: TrackerSyncRow;
  tracker: TrackerRow;
  createdTracker: boolean;
  outcome: SyncOutcome;
}> {
  const found = await latestSourceSheet(db, input.sourceId, input.actorId, input.sheetIndex);
  if (!found)
    throw new ValidationError(
      'Esa fuente no tiene una captura vigente con esa hoja. Actualízala en el Feed y vuelve a intentar.',
    );
  const header = (found.sheet.rows[0] ?? []).map((h) => String(h ?? '').trim());

  const { data: existingTracker, error: tError } = await db
    .from('trackers')
    .select(TRACKER_COLUMNS)
    .eq('slug', input.tracker.slug)
    .maybeSingle();
  if (tError) throw tError;

  let tracker: TrackerRow;
  let mapping: Record<string, string>;
  let createdTracker = false;
  if (existingTracker) {
    tracker = existingTracker as unknown as TrackerRow;
    // Una tabla que ya existe se llena por nombre de encabezado igual a su
    // etiqueta o a su clave; lo que no calce se queda vacío.
    const taken = new Set<string>();
    const byKey = new Map(header.map((h, i) => [headerKey(h, i, taken), h]));
    mapping = {};
    for (const f of tracker.fields) {
      const h = header.find((x) => x.toLowerCase() === f.label.toLowerCase()) ?? byKey.get(f.key);
      if (h) mapping[f.key] = h;
    }
    if (!Object.keys(mapping).length)
      throw new ValidationError(
        `Ninguna columna de la fuente coincide con los campos de «${tracker.name}». Crea una tabla nueva desde la fuente.`,
      );
  } else {
    const inferred = fieldsFromSheet(found.sheet);
    if (!inferred.fields.length) throw new ValidationError('La fuente no tiene columnas legibles.');
    const { tracker: created } = await defineTracker(db, {
      slug: input.tracker.slug,
      name: input.tracker.name,
      description: input.tracker.description ?? `Se llena sola desde «${found.sourceName}».`,
      fields: trackerFieldsSchema.parse(inferred.fields),
      userId: input.actorId,
    });
    tracker = created;
    mapping = inferred.mapping;
    createdTracker = true;
  }

  // Las columnas clave se dicen como en la fuente («flight.iata»); se guardan
  // como campos de la tabla.
  const keyFields = input.keyColumns.map((col) => {
    const entry = Object.entries(mapping).find(
      ([field, source]) =>
        source.toLowerCase() === col.trim().toLowerCase() || field === col.trim().toLowerCase(),
    );
    if (!entry)
      throw new ValidationError(
        `«${col}» no es una columna de la fuente. Columnas: ${header.slice(0, 30).join(', ')}.`,
      );
    return entry[0];
  });

  const { data, error } = await db
    .from('tracker_syncs')
    .upsert(
      {
        source_id: input.sourceId,
        sheet_index: input.sheetIndex,
        tracker_id: tracker.id,
        mapping,
        key_fields: keyFields,
        interval_minutes: input.intervalMinutes,
        notify: input.notify,
        enabled: true,
        created_by: input.actorId,
        next_run_at: new Date(Date.now() + input.intervalMinutes * 60_000).toISOString(),
      },
      { onConflict: 'organization_id,source_id,sheet_index,tracker_id' },
    )
    .select(SYNC_COLUMNS)
    .single();
  if (error) throw error;
  const sync = data as unknown as TrackerSyncRow;
  // La primera carga, ya, con la captura vigente.
  const outcome = await applyTrackerSync(db, sync, found.sheet);
  await markSyncRun(db, sync, { ok: true, outcome });
  return { sync, tracker, createdTracker, outcome };
}

export async function markSyncRun(
  db: SupabaseClient,
  sync: Pick<TrackerSyncRow, 'id' | 'interval_minutes'>,
  result: { ok: true; outcome: SyncOutcome } | { ok: false; error: string },
): Promise<void> {
  const now = Date.now();
  await db
    .from('tracker_syncs')
    .update({
      last_run_at: new Date(now).toISOString(),
      next_run_at: new Date(now + sync.interval_minutes * 60_000).toISOString(),
      last_status: result.ok ? 'ok' : 'error',
      last_error: result.ok ? null : result.error.slice(0, 500),
      ...(result.ok
        ? {
            last_inserted: result.outcome.inserted,
            last_updated: result.outcome.updated,
            last_skipped: result.outcome.skipped,
          }
        : {}),
    })
    .eq('id', sync.id);
}

export async function listTrackerSyncs(db: SupabaseClient): Promise<TrackerSyncRow[]> {
  const { data, error } = await db
    .from('tracker_syncs')
    .select(SYNC_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []) as unknown as TrackerSyncRow[];
}
