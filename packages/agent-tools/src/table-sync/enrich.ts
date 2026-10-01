import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SheetData } from '../kb/spreadsheets';
import { type TrackerField, rowLabel, trackerFieldsSchema } from '../trackers/schema';
import { TRACKER_COLUMNS, type TrackerRow, defineTracker, shapeValues } from '../trackers/store';
import { dayOfCell, headerKey } from '../views/feed-sources';
import {
  SYNC_COLUMNS,
  type SyncOutcome,
  type TrackerSyncRow,
  latestSourceSheet,
  markSyncRun,
  planSync,
} from './sync';

/**
 * UNA FUENTE QUE ESCRIBE EN FILAS QUE YA EXISTEN (migración 0163).
 *
 * El caso que lo pidió: la tabla «Guías» se llena desde el Drive del socio
 * extranjero, y la API de vuelos tiene que escribir en cada guía si su vuelo
 * ya aterrizó. Agregar los vuelos como filas llenaría la tabla con todo el
 * tablero del aeropuerto; lo que sirve es CRUZAR: las columnas de cruce de la
 * fuente (vuelo, fecha) contra los valores de las filas, y escribir en las que
 * coinciden sólo las columnas que se piden (estado del vuelo, hora de
 * llegada). Un vuelo con tres guías actualiza las tres. Nunca agrega filas.
 *
 * EL CRUCE TOLERA CÓMO SE ESCRIBE UN VUELO: mayúsculas, sin espacios ni
 * guiones, y sin ceros a la izquierda en el número («av 009» = «AV9»). Lo que
 * NO resuelve es IATA contra ICAO («AV9» frente a «AVA9»): eso se elige al
 * escoger la columna de la fuente.
 */

/** Cómo se compara una parte de la clave, según el tipo del campo. */
export function matchPart(value: unknown, type: TrackerField['type'] | undefined): string {
  if (value === undefined || value === null) return '';
  const text = String(value).trim();
  if (!text) return '';
  if (type === 'date') return dayOfCell(text) ?? text.slice(0, 10);
  if (type === 'number' || type === 'money') {
    const n = Number(text.replace(',', '.'));
    return Number.isFinite(n) ? String(n) : text;
  }
  return text
    .toUpperCase()
    .replace(/[\s\-_.]+/g, '')
    .replace(/(?<=[A-Z])0+(?=\d)/g, '');
}

function keyOf(
  values: Record<string, unknown>,
  keys: string[],
  fields: TrackerField[],
): string | null {
  const parts = keys.map((k) => matchPart(values[k], fields.find((f) => f.key === k)?.type));
  return parts.some((p) => !p) ? null : parts.join('|');
}

/** Cuántas filas de la tabla se cruzan por corrida. */
const TABLE_SCAN = 5000;

export async function applyUpdateOnly(
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
  const tracker = t as unknown as TrackerRow;

  const plan = planSync(sheet, tracker.fields, sync.mapping, sync.key_fields);
  if (plan.missingHeaders.length)
    throw new ValidationError(
      `La fuente ya no trae ${plan.missingHeaders.map((h) => `«${h}»`).join(', ')}. Revisa la sincronización.`,
    );
  const setFields = Object.keys(sync.mapping).filter((k) => !sync.key_fields.includes(k));

  // Lo que dice la fuente, por clave normalizada.
  const incoming = new Map<string, Record<string, string | number>>();
  for (const row of plan.rows) {
    const key = keyOf(row.values, sync.key_fields, tracker.fields);
    if (key) incoming.set(key, row.values);
  }

  const { data: rows, error } = await db
    .from('tracker_rows')
    .select('id, values')
    .eq('tracker_id', tracker.id)
    .order('updated_at', { ascending: false })
    .limit(TABLE_SCAN);
  if (error) throw error;

  const outcome: SyncOutcome = {
    inserted: 0,
    updated: 0,
    unchanged: 0,
    skipped: plan.skipped,
    newLabels: [],
    changedLabels: [],
  };
  for (const row of (rows ?? []) as Array<{
    id: string;
    values: Record<string, string | number>;
  }>) {
    const key = keyOf(row.values ?? {}, sync.key_fields, tracker.fields);
    const source = key ? incoming.get(key) : undefined;
    if (!source) continue;
    const patch: Record<string, string | number> = {};
    for (const field of setFields) {
      const v = source[field];
      if (v !== undefined && String(row.values?.[field] ?? '') !== String(v)) patch[field] = v;
    }
    if (!Object.keys(patch).length) {
      outcome.unchanged += 1;
      continue;
    }
    const known = Object.fromEntries(
      Object.entries(row.values ?? {}).filter(([k]) => tracker.fields.some((f) => f.key === k)),
    );
    let values: Record<string, string | number>;
    try {
      values = shapeValues(tracker.fields, { ...known, ...patch });
    } catch {
      outcome.skipped += 1;
      continue;
    }
    const label = rowLabel(tracker.fields, values);
    const { error: updateError } = await db
      .from('tracker_rows')
      .update({ values, label, updated_at: new Date().toISOString() })
      .eq('id', row.id)
      .eq('tracker_id', tracker.id);
    if (updateError) throw updateError;
    outcome.updated += 1;
    outcome.changedLabels.push(label);
  }
  return outcome;
}

/**
 * Configura «esta fuente actualiza estas columnas de esa tabla». Las columnas
 * a escribir que la tabla no tiene se le agregan como texto («Estado del
 * vuelo», «Llegada»), y las de cruce tienen que existir: cruzar por un campo
 * que no está es cruzar con nada.
 */
export async function createUpdateOnlySync(
  db: SupabaseClient,
  input: {
    sourceId: string;
    sheetIndex: number;
    actorId: string;
    tableSlug: string;
    match: Array<{ column: string; field: string }>;
    set: Array<{ column: string; field?: string; label?: string }>;
    intervalMinutes: number;
    notify: boolean;
  },
): Promise<{ sync: TrackerSyncRow; tracker: TrackerRow; outcome: SyncOutcome; added: string[] }> {
  const found = await latestSourceSheet(db, input.sourceId, input.actorId, input.sheetIndex);
  if (!found)
    throw new ValidationError(
      'Esa fuente no tiene una captura vigente con esa hoja. Actualízala en el Feed.',
    );
  const header = (found.sheet.rows[0] ?? []).map((h) => String(h ?? '').trim());
  const hasColumn = (c: string) => header.some((h) => h.toLowerCase() === c.trim().toLowerCase());
  const exact = (c: string) => header.find((h) => h.toLowerCase() === c.trim().toLowerCase()) ?? c;
  for (const c of [...input.match.map((m) => m.column), ...input.set.map((s) => s.column)])
    if (!hasColumn(c))
      throw new ValidationError(
        `«${c}» no es una columna de la fuente. Columnas: ${header.slice(0, 30).join(', ')}.`,
      );

  const { data: t, error } = await db
    .from('trackers')
    .select(TRACKER_COLUMNS)
    .eq('slug', input.tableSlug)
    .maybeSingle();
  if (error) throw error;
  if (!t) throw new NotFoundError(`No hay una tabla «${input.tableSlug}».`);
  let tracker = t as unknown as TrackerRow;

  for (const m of input.match)
    if (!tracker.fields.some((f) => f.key === m.field))
      throw new ValidationError(
        `«${m.field}» no es un campo de ${tracker.name}. Campos: ${tracker.fields.map((f) => f.key).join(', ')}.`,
      );

  const taken = new Set(tracker.fields.map((f) => f.key));
  const added: string[] = [];
  const setMapping: Array<{ field: string; column: string }> = [];
  const extra: TrackerField[] = [];
  for (const s of input.set) {
    let field = s.field && tracker.fields.some((f) => f.key === s.field) ? s.field : undefined;
    if (!field) {
      field =
        s.field && /^[a-z][a-z0-9_]{0,31}$/.test(s.field) && !taken.has(s.field)
          ? s.field
          : headerKey(s.column, 0, taken);
      taken.add(field);
      extra.push({
        key: field,
        label: (s.label ?? s.column).slice(0, 60),
        type: 'text',
        required: false,
      });
      added.push(s.label ?? s.column);
    }
    setMapping.push({ field, column: exact(s.column) });
  }
  if (extra.length) {
    const { tracker: updated } = await defineTracker(db, {
      slug: tracker.slug,
      name: tracker.name,
      description: tracker.description,
      fields: trackerFieldsSchema.parse([...tracker.fields, ...extra]),
      userId: input.actorId,
    });
    tracker = updated;
  }

  const mapping: Record<string, string> = {};
  for (const m of input.match) mapping[m.field] = exact(m.column);
  for (const s of setMapping) mapping[s.field] = s.column;

  const { data, error: upsertError } = await db
    .from('tracker_syncs')
    .upsert(
      {
        source_id: input.sourceId,
        sheet_index: input.sheetIndex,
        tracker_id: tracker.id,
        mapping,
        key_fields: input.match.map((m) => m.field),
        interval_minutes: input.intervalMinutes,
        notify: input.notify,
        enabled: true,
        created_by: input.actorId,
        mode: 'update_only',
        next_run_at: new Date(Date.now() + input.intervalMinutes * 60_000).toISOString(),
      },
      { onConflict: 'organization_id,source_id,sheet_index,tracker_id' },
    )
    .select(SYNC_COLUMNS)
    .single();
  if (upsertError) throw upsertError;
  const sync = data as unknown as TrackerSyncRow;
  const outcome = await applyUpdateOnly(db, sync, found.sheet);
  await markSyncRun(db, sync, { ok: true, outcome });
  return { sync, tracker, outcome, added };
}
