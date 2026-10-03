import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchCustomToolById } from '../../custom-tools/store';
import { type CustomToolRow, MAX_TOOLS_PER_ORG } from '../../custom-tools/types';
import { type TrackerField, trackerFieldsSchema } from '../../trackers/schema';
import { TRACKER_COLUMNS, type TrackerRow, defineTracker } from '../../trackers/store';
import { unknownFilterFields } from './filter';
import { type LookupPlan, lookupToday, planLookup } from './plan';
import {
  type LookupFetcher,
  type LookupPreview,
  describeCredentialProblem,
  previewLookup,
} from './run';
import { describeTemplateProblem, templateFields } from './template';
import { bogotaDay } from './time';
import {
  DEFAULT_DAILY_CAP,
  DEFAULT_PER_RUN_CAP,
  LOOKUP_COLUMNS,
  type LookupFilter,
  type LookupFilterInput,
  type LookupMappingEntry,
  type LookupNear,
  type LookupNearInput,
  type RowLookupRow,
  lookupFilterSchema,
  lookupMappingSchema,
  lookupNearSchema,
} from './types';

type Db = SupabaseClient;

const BUILTIN_FIELDS = new Set(['hoy', 'ahora']);

export interface LookupInput {
  name: string;
  urlTemplate: string;
  /** Nombre o id de una herramienta propia que guarda la llave (opcional). */
  credential?: string;
  mapping: Array<LookupMappingEntry & { label?: string }>;
  filter?: LookupFilterInput;
  baseIntervalMinutes?: number;
  near?: LookupNearInput | null;
  dailyCap?: number;
  perRunCap?: number;
}

/** Una herramienta propia por nombre, slug o id (sin su llave). */
export async function resolveCredential(
  db: Db,
  ref: string,
): Promise<Pick<CustomToolRow, 'id' | 'name' | 'slug'>> {
  const { data, error } = await db
    .from('custom_tools')
    .select('id, name, slug, enabled')
    .order('slug', { ascending: true })
    .limit(MAX_TOOLS_PER_ORG);
  if (error) throw error;
  const all = (data ?? []) as Array<{ id: string; name: string; slug: string; enabled: boolean }>;
  const wanted = ref.trim().toLowerCase();
  const rows = all.filter(
    (r) =>
      r.id === ref ||
      r.slug.toLowerCase() === wanted ||
      r.name.toLowerCase().includes(wanted) ||
      r.slug.toLowerCase().includes(wanted),
  );
  const exact = rows.find(
    (r) => r.id === ref || r.slug.toLowerCase() === wanted || r.name.toLowerCase() === wanted,
  );
  const pick = exact ?? (rows.length === 1 ? rows[0] : undefined);
  if (!pick) {
    if (!rows.length)
      throw new NotFoundError(
        `No encontré una herramienta propia llamada «${ref}». La credencial se conecta primero en Herramientas propias (admin).`,
      );
    throw new ValidationError(
      `Hay varias credenciales que se llaman parecido: ${rows.map((r) => `«${r.name}»`).join(', ')}. Dime cuál.`,
    );
  }
  if (!pick.enabled) throw new ValidationError(`La herramienta «${pick.name}» está desactivada.`);
  return pick;
}

/** Los campos de la URL que la tabla no tiene (y no son `hoy`/`ahora`). */
export function unknownTemplateFields(urlTemplate: string, fields: TrackerField[]): string[] {
  return templateFields(urlTemplate)
    .map((t) => t.name)
    .filter((name, i, all) => all.indexOf(name) === i)
    .filter((name) => !BUILTIN_FIELDS.has(name) && !fields.some((f) => f.key === name));
}

/**
 * Todo lo que se puede comprobar de una configuración sin llamar a la API.
 * Lanza `ValidationError` con el motivo en español.
 */
export function validateLookup(
  tracker: TrackerRow,
  input: LookupInput,
  credentialTool: CustomToolRow | null,
): { filter: LookupFilter; near: LookupNear | null; mapping: LookupMappingEntry[] } {
  const problem = describeTemplateProblem(input.urlTemplate);
  if (problem) throw new ValidationError(problem);
  const unknownUrl = unknownTemplateFields(input.urlTemplate, tracker.fields);
  if (unknownUrl.length)
    throw new ValidationError(
      `La dirección usa ${unknownUrl.map((f) => `{${f}}`).join(', ')}, que no son columnas de ${tracker.name}. Columnas: ${tracker.fields.map((f) => f.key).join(', ')}.`,
    );
  const mapping = lookupMappingSchema.parse(
    input.mapping.map(({ path, field, translate }) => ({ path, field, translate })),
  );
  const filter = lookupFilterSchema.parse(input.filter ?? { match: 'all', filters: [] });
  const unknownFilter = unknownFilterFields(filter, tracker.fields);
  if (unknownFilter.length)
    throw new ValidationError(
      `El filtro usa ${unknownFilter.map((f) => `«${f}»`).join(', ')}, que no son columnas de ${tracker.name}.`,
    );
  const near = input.near ? lookupNearSchema.parse(input.near) : null;
  if (near && !tracker.fields.some((f) => f.key === near.field))
    throw new ValidationError(
      `La regla «cerca de» usa «${near.field}», que no es una columna de ${tracker.name}.`,
    );
  if (credentialTool) {
    const bad = describeCredentialProblem(credentialTool, input.urlTemplate);
    if (bad) throw new ValidationError(bad);
  }
  return { filter, near, mapping };
}

/** Agrega como texto las columnas del mapeo que la tabla aún no tiene. */
async function ensureMappingFields(
  db: Db,
  tracker: TrackerRow,
  mapping: Array<LookupMappingEntry & { label?: string }>,
  userId: string,
): Promise<{ tracker: TrackerRow; added: string[] }> {
  const extra: TrackerField[] = [];
  for (const m of mapping) {
    if (tracker.fields.some((f) => f.key === m.field) || extra.some((f) => f.key === m.field))
      continue;
    extra.push({
      key: m.field,
      label: (m.label ?? m.field).slice(0, 60),
      type: 'text',
      required: false,
    });
  }
  if (!extra.length) return { tracker, added: [] };
  if (tracker.fields.length + extra.length > 20)
    throw new ValidationError(
      'La tabla ya tiene demasiadas columnas para agregar las del mapeo (máximo 20).',
    );
  const { tracker: updated } = await defineTracker(db, {
    slug: tracker.slug,
    name: tracker.name,
    description: tracker.description,
    fields: trackerFieldsSchema.parse([...tracker.fields, ...extra]),
    userId,
  });
  return { tracker: updated, added: extra.map((f) => f.label) };
}

export async function trackerBySlug(db: Db, slug: string): Promise<TrackerRow> {
  const { data, error } = await db
    .from('trackers')
    .select(TRACKER_COLUMNS)
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError(`No hay una tabla «${slug}».`);
  return data as unknown as TrackerRow;
}

export async function createRowLookup(
  db: Db,
  input: LookupInput & {
    trackerSlug: string;
    actorId: string;
    /** Probar con una fila antes de dejarla activa; si la prueba falla, queda en pausa. */
    probe?: boolean;
    fetcher?: LookupFetcher;
  },
): Promise<{
  lookup: RowLookupRow;
  tracker: TrackerRow;
  added: string[];
  preview: LookupPreview | null;
}> {
  let tracker = await trackerBySlug(db, input.trackerSlug);
  let credentialTool: CustomToolRow | null = null;
  let credentialName: string | null = null;
  if (input.credential) {
    const ref = await resolveCredential(db, input.credential);
    credentialTool = await fetchCustomToolById(db, ref.id);
    credentialName = ref.name;
    if (!credentialTool) throw new NotFoundError(`No pude leer la herramienta «${ref.name}».`);
  }
  // Las columnas nuevas del mapeo se agregan antes de validar el filtro/ventana.
  const ensured = await ensureMappingFields(db, tracker, input.mapping, input.actorId);
  tracker = ensured.tracker;
  const checked = validateLookup(tracker, input, credentialTool);
  const baseInterval = input.baseIntervalMinutes ?? 30;
  if (!Number.isInteger(baseInterval) || baseInterval < 5 || baseInterval > 1440)
    throw new ValidationError('El intervalo va de 5 a 1440 minutos.');
  // Una prueba con una fila: si la API contesta mal, se guarda en pausa en vez
  // de gastar el tope del día repitiendo una dirección equivocada.
  const preview = input.probe
    ? await previewLookup(db, {
        tracker,
        spec: {
          url_template: input.urlTemplate.trim(),
          filter: checked.filter,
          mapping: checked.mapping,
          credential_tool_id: credentialTool?.id ?? null,
        },
        fetcher: input.fetcher,
      })
    : null;
  const failedProbe = Boolean(preview && preview.calls > 0 && !preview.ok);
  const today = bogotaDay(Date.now());
  const { data, error } = await db
    .from('row_lookups')
    .insert({
      calls_today: preview?.calls ?? 0,
      calls_day: preview?.calls ? today : null,
      tracker_id: tracker.id,
      name: input.name.trim().slice(0, 80),
      url_template: input.urlTemplate.trim(),
      credential_tool_id: credentialTool?.id ?? null,
      credential_name: credentialName,
      mapping: checked.mapping,
      filter: checked.filter,
      base_interval_minutes: baseInterval,
      near: checked.near,
      daily_cap: input.dailyCap ?? DEFAULT_DAILY_CAP,
      per_run_cap: input.perRunCap ?? DEFAULT_PER_RUN_CAP,
      enabled: !failedProbe,
      created_by: input.actorId,
      next_run_at: new Date().toISOString(),
    })
    .select(LOOKUP_COLUMNS)
    .single();
  if (error) {
    if ((error as { code?: string }).code === '23505')
      throw new ValidationError(
        `Ya hay una consulta «${input.name}» en ${tracker.name}. Usa otro nombre.`,
      );
    throw error;
  }
  return { lookup: data as unknown as RowLookupRow, tracker, added: ensured.added, preview };
}

export interface LookupPatch {
  name?: string;
  urlTemplate?: string;
  mapping?: Array<LookupMappingEntry & { label?: string }>;
  filter?: LookupFilterInput;
  baseIntervalMinutes?: number;
  near?: LookupNearInput | null;
  dailyCap?: number;
  perRunCap?: number;
  enabled?: boolean;
}

/** Una consulta por id o por nombre (dentro de una tabla, si se dice). */
export async function findRowLookup(
  db: Db,
  ref: string,
  trackerSlug?: string,
): Promise<RowLookupRow> {
  const byId = /^[0-9a-f-]{36}$/i.test(ref);
  let q = db.from('row_lookups').select(LOOKUP_COLUMNS);
  if (trackerSlug) {
    const tracker = await trackerBySlug(db, trackerSlug);
    q = q.eq('tracker_id', tracker.id);
  }
  const { data, error } = await (byId
    ? q.eq('id', ref)
    : q.ilike('name', `%${ref.replace(/[%_]/g, '')}%`)
  ).limit(5);
  if (error) throw error;
  const rows = (data ?? []) as unknown as RowLookupRow[];
  const exact = rows.find((r) => r.id === ref || r.name.toLowerCase() === ref.toLowerCase());
  const pick = exact ?? (rows.length === 1 ? rows[0] : undefined);
  if (!pick) {
    if (!rows.length) throw new NotFoundError(`No encontré una consulta automática «${ref}».`);
    throw new ValidationError(
      `Hay varias consultas que se llaman parecido: ${rows.map((r) => `«${r.name}»`).join(', ')}. Dime cuál.`,
    );
  }
  return pick;
}

export async function updateRowLookup(
  db: Db,
  lookup: RowLookupRow,
  patch: LookupPatch,
  actorId: string,
): Promise<{ lookup: RowLookupRow; added: string[] }> {
  const { data: t, error: tError } = await db
    .from('trackers')
    .select(TRACKER_COLUMNS)
    .eq('id', lookup.tracker_id)
    .maybeSingle();
  if (tError) throw tError;
  if (!t) throw new NotFoundError('La tabla de esta consulta ya no existe.');
  let tracker = t as unknown as TrackerRow;

  const touchesConfig =
    patch.urlTemplate !== undefined ||
    patch.mapping !== undefined ||
    patch.filter !== undefined ||
    patch.near !== undefined;
  let added: string[] = [];
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined) update.name = patch.name.trim().slice(0, 80);
  if (patch.enabled !== undefined) {
    update.enabled = patch.enabled;
    // Al reanudar, que toque en la próxima vuelta.
    if (patch.enabled) update.next_run_at = new Date().toISOString();
  }
  if (patch.dailyCap !== undefined) {
    if (!Number.isInteger(patch.dailyCap) || patch.dailyCap < 1 || patch.dailyCap > 100000)
      throw new ValidationError('El tope diario va de 1 a 100.000 consultas.');
    update.daily_cap = patch.dailyCap;
    update.next_run_at = new Date().toISOString();
  }
  if (patch.perRunCap !== undefined) {
    if (!Number.isInteger(patch.perRunCap) || patch.perRunCap < 1 || patch.perRunCap > 1000)
      throw new ValidationError('El tope por vuelta va de 1 a 1.000 consultas.');
    update.per_run_cap = patch.perRunCap;
  }
  if (patch.baseIntervalMinutes !== undefined) {
    if (
      !Number.isInteger(patch.baseIntervalMinutes) ||
      patch.baseIntervalMinutes < 5 ||
      patch.baseIntervalMinutes > 1440
    )
      throw new ValidationError('El intervalo va de 5 a 1440 minutos.');
    update.base_interval_minutes = patch.baseIntervalMinutes;
  }
  if (touchesConfig) {
    const merged: LookupInput = {
      name: lookup.name,
      urlTemplate: patch.urlTemplate ?? lookup.url_template,
      mapping: patch.mapping ?? lookup.mapping,
      filter: patch.filter ?? lookup.filter,
      near: patch.near === undefined ? lookup.near : patch.near,
    };
    if (patch.mapping) {
      const ensured = await ensureMappingFields(db, tracker, patch.mapping, actorId);
      tracker = ensured.tracker;
      added = ensured.added;
    }
    const tool = lookup.credential_tool_id
      ? await fetchCustomToolById(db, lookup.credential_tool_id)
      : null;
    const checked = validateLookup(tracker, merged, tool);
    if (patch.urlTemplate !== undefined) update.url_template = merged.urlTemplate.trim();
    if (patch.mapping !== undefined) update.mapping = checked.mapping;
    if (patch.filter !== undefined) update.filter = checked.filter;
    if (patch.near !== undefined) update.near = checked.near;
  }
  const { data, error } = await db
    .from('row_lookups')
    .update(update)
    .eq('id', lookup.id)
    .select(LOOKUP_COLUMNS)
    .maybeSingle();
  if (error) {
    if ((error as { code?: string }).code === '23505')
      throw new ValidationError('Ya hay otra consulta con ese nombre en esta tabla.');
    throw error;
  }
  if (!data) throw new NotFoundError('Esa consulta ya no existe.');
  // Cambió la dirección, el mapeo o la ventana: que todas las filas vuelvan a tocar.
  if (touchesConfig) {
    const { error: clearError } = await db
      .from('row_lookup_state')
      .delete()
      .eq('lookup_id', lookup.id);
    if (clearError) throw clearError;
  }
  return { lookup: data as unknown as RowLookupRow, added };
}

export async function listRowLookups(db: Db, trackerId?: string): Promise<RowLookupRow[]> {
  let q = db
    .from('row_lookups')
    .select(LOOKUP_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(50);
  if (trackerId) q = q.eq('tracker_id', trackerId);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as RowLookupRow[];
}

export interface LookupStatusInfo {
  lookup: RowLookupRow;
  trackerName: string;
  callsToday: number;
  dueNow: number;
  deferred: number;
  skipped: LookupPlan['skipped'];
  nextDueAt: string | null;
  errors: Array<{ rowId: string; label: string; message: string; at: string | null }>;
}

/** Cómo va una consulta: lo gastado hoy, cuántas filas tocan ya y los últimos errores. */
export async function rowLookupStatus(
  db: Db,
  lookup: RowLookupRow,
  nowMs = Date.now(),
): Promise<LookupStatusInfo> {
  const { data: t, error: tError } = await db
    .from('trackers')
    .select(TRACKER_COLUMNS)
    .eq('id', lookup.tracker_id)
    .maybeSingle();
  if (tError) throw tError;
  const tracker = t as unknown as TrackerRow | null;
  const [rowsRes, statesRes] = await Promise.all([
    db
      .from('tracker_rows')
      .select('id, label, values')
      .eq('tracker_id', lookup.tracker_id)
      .order('updated_at', { ascending: false })
      .limit(5000),
    db
      .from('row_lookup_state')
      .select('row_id, next_at, fail_count, last_status, last_error, last_at')
      .eq('lookup_id', lookup.id)
      .limit(5000),
  ]);
  if (rowsRes.error) throw rowsRes.error;
  if (statesRes.error) throw statesRes.error;
  const rows = (rowsRes.data ?? []) as Array<{
    id: string;
    label: string;
    values: Record<string, string | number> | null;
  }>;
  const states = (statesRes.data ?? []) as Array<{
    row_id: string;
    next_at: string;
    fail_count: number;
    last_status: string | null;
    last_error: string | null;
    last_at: string | null;
  }>;
  const plan = planLookup(
    lookup,
    tracker?.fields ?? [],
    rows.map((r) => ({ id: r.id, values: r.values ?? {} })),
    new Map(states.map((s) => [s.row_id, { next_at: s.next_at, fail_count: s.fail_count }])),
    nowMs,
  );
  const labels = new Map(rows.map((r) => [r.id, r.label]));
  const errors = states
    .filter((s) => s.last_status === 'error' && s.last_error)
    .sort((a, b) => (b.last_at ?? '').localeCompare(a.last_at ?? ''))
    .slice(0, 5)
    .map((s) => ({
      rowId: s.row_id,
      label: labels.get(s.row_id) ?? 'fila',
      message: s.last_error ?? '',
      at: s.last_at,
    }));
  return {
    lookup,
    trackerName: tracker?.name ?? 'tabla',
    callsToday: lookupToday(lookup, nowMs).callsToday,
    dueNow: plan.calls.length + plan.deferred,
    deferred: plan.deferred,
    skipped: plan.skipped,
    nextDueAt: plan.nextDueMs ? new Date(plan.nextDueMs).toISOString() : null,
    errors,
  };
}
