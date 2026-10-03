import { NotFoundError, type UUID, ValidationError, logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { writeAuditEvent } from '../../audit';
import { executeCustomTool } from '../../custom-tools/execute';
import { fetchCustomToolById } from '../../custom-tools/store';
import type { CustomToolRow } from '../../custom-tools/types';
import { type TrackerField, trackerFieldsSchema } from '../../trackers/schema';
import {
  TRACKER_COLUMNS,
  type TrackerRow,
  defineTracker,
  shapeValues,
  upsertRow,
} from '../../trackers/store';
import {
  type LookupPlan,
  type PlanRowInput,
  type PlanState,
  type PlannedCall,
  mapResponse,
  nextAtAfter,
  nextResetMs,
  planLookup,
} from './plan';
import { hostOfTemplate } from './template';
import { MINUTE } from './time';
import type { LookupStateRow, LookupStatus, RowLookupRow } from './types';

/**
 * EL EJECUTOR DE UNA CONSULTA POR FILA.
 *
 * Una vuelta (cada 5 minutos, desde el trabajo `table-sync`):
 *
 *   1. lee la tabla, el estado de cada fila y la credencial;
 *   2. pide el plan al planificador puro (`plan.ts`): qué filas, con qué
 *      dirección, respetando filtro, ventana, topes del día y de la corrida;
 *   3. llama la API con unos pocos hilos, con tiempo máximo por llamada y para
 *      toda la vuelta; un 429 o un 401/403 DETIENEN la vuelta (insistir sólo
 *      gasta cuota) y cada fallo espacia el reintento de esa fila;
 *   4. escribe en la tabla sólo las columnas del mapeo, sobre lo que la fila
 *      tenga en ese instante (si alguien editó otra columna, no se pisa) y deja
 *      una fila de auditoría por cambio, que el historial de la fila muestra;
 *   5. agenda la próxima vuelta de cada fila y actualiza el contador del día.
 *
 * La llave de la credencial se descifra dentro de `executeCustomTool` y nunca
 * sale de ahí: ni el estado, ni los avisos, ni el resultado la contienen.
 */

/** Cuántas filas de la tabla se miran por vuelta. */
const TABLE_SCAN = 5000;
const STATE_CHUNK = 200;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_DEADLINE_MS = 40_000;
const CALL_TIMEOUT_MS = 15_000;
const RESPONSE_MAX_CHARS = 1_000_000;

export type LookupHttpResult =
  | { ok: true; data: unknown }
  | { ok: false; status: number | null; message: string; retryAfterMs?: number };

export type LookupFetcher = (
  url: string,
  credential: CustomToolRow | null,
) => Promise<LookupHttpResult>;

const PUBLIC_ROW: CustomToolRow = {
  id: 'row-lookup-public',
  organization_id: '',
  slug: 'consulta',
  name: 'la consulta',
  description: '',
  input_schema: null,
  http_method: 'GET',
  url_template: '',
  headers: null,
  body_encoding: 'none',
  body_template: null,
  auth_type: 'none',
  auth_header_name: null,
  auth_username: null,
  auth_secret_encrypted: null,
  response_path: null,
  response_max_chars: RESPONSE_MAX_CHARS,
  timeout_ms: CALL_TIMEOUT_MS,
  allow_insecure_http: false,
  follow_redirects: false,
  requires_confirmation: false,
  rate_limit_per_minute: 60,
  enabled: true,
};

/** Segundos o fecha HTTP de un encabezado Retry-After, en ms. */
function retryAfterMs(value: string | undefined, nowMs: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
}

/**
 * La llamada real: GET con la herramienta propia como credencial (su llave
 * cifrada, sus encabezados, su guardia contra direcciones internas). La
 * dirección ya viene armada y codificada.
 */
export const defaultLookupFetcher: LookupFetcher = async (url, credential) => {
  const base = credential ?? PUBLIC_ROW;
  const row: CustomToolRow = {
    ...base,
    http_method: 'GET',
    url_template: url,
    body_encoding: 'none',
    body_template: null,
    response_path: null,
    response_max_chars: RESPONSE_MAX_CHARS,
    timeout_ms: Math.min(base.timeout_ms || CALL_TIMEOUT_MS, 20_000),
    requires_confirmation: false,
  };
  const { result, detail } = await executeCustomTool(row, {});
  if (result.ok) return { ok: true, data: result.data };
  return {
    ok: false,
    status: result.status,
    message: (result.message ?? 'La API no respondió.').slice(0, 300),
    retryAfterMs: retryAfterMs(detail.response?.headers['retry-after'], Date.now()),
  };
};

/**
 * Por qué una credencial no sirve para esta dirección, o null si sirve. La
 * llave sólo viaja al MISMO servidor que la herramienta propia: una consulta
 * no puede mandar la llave de una API a otro dominio.
 */
export function describeCredentialProblem(
  tool: Pick<CustomToolRow, 'name' | 'http_method' | 'url_template' | 'enabled'>,
  urlTemplate: string,
): string | null {
  if (!tool.enabled) return `La herramienta «${tool.name}» está desactivada.`;
  if (tool.http_method !== 'GET')
    return `«${tool.name}» no es de lectura (GET): una consulta automática sólo puede leer.`;
  const toolHost = hostOfTemplate(tool.url_template);
  const host = hostOfTemplate(urlTemplate);
  if (!toolHost || !host || toolHost.includes('{') || toolHost !== host)
    return `La llave de «${tool.name}» sólo se envía a ${toolHost ?? 'su propio servidor'}, y esta dirección va a ${host ?? 'otro'}. Usa la misma API o conecta otra credencial.`;
  return null;
}

export interface LookupNotice {
  title: string;
  body: string;
  dedupeKey: string;
}

export interface LookupRunOutcome {
  status: LookupStatus;
  calls: number;
  updated: number;
  unchanged: number;
  errors: number;
  skipped: LookupPlan['skipped'];
  capped: LookupPlan['capped'];
  message: string | null;
  notices: LookupNotice[];
}

export interface RunOptions {
  now?: () => number;
  fetcher?: LookupFetcher;
  concurrency?: number;
  deadlineMs?: number;
}

type Db = SupabaseClient;

async function readTable(db: Db, trackerId: string): Promise<PlanRowInput[]> {
  const { data, error } = await db
    .from('tracker_rows')
    .select('id, values')
    .eq('tracker_id', trackerId)
    .order('updated_at', { ascending: false })
    .limit(TABLE_SCAN);
  if (error) throw error;
  return (
    (data ?? []) as Array<{ id: string; values: Record<string, string | number> | null }>
  ).map((r) => ({ id: r.id, values: r.values ?? {} }));
}

async function readStates(db: Db, lookupId: string): Promise<Map<string, PlanState>> {
  const { data, error } = await db
    .from('row_lookup_state')
    .select('row_id, next_at, fail_count')
    .eq('lookup_id', lookupId)
    .limit(TABLE_SCAN);
  if (error) throw error;
  return new Map(
    ((data ?? []) as Array<{ row_id: string; next_at: string; fail_count: number }>).map((s) => [
      s.row_id,
      { next_at: s.next_at, fail_count: s.fail_count },
    ]),
  );
}

async function loadCredential(db: Db, lookup: RowLookupRow): Promise<CustomToolRow | null> {
  if (!lookup.credential_tool_id) {
    if (lookup.credential_name)
      throw new NotFoundError(
        `La credencial «${lookup.credential_name}» de esta consulta ya no existe. Conéctala de nuevo y vuelve a crear la consulta.`,
      );
    return null;
  }
  const tool = await fetchCustomToolById(db, lookup.credential_tool_id);
  if (!tool)
    throw new NotFoundError('La credencial de esta consulta ya no existe o no se pudo leer.');
  const problem = describeCredentialProblem(tool, lookup.url_template);
  if (problem) throw new ValidationError(problem);
  return tool;
}

interface CallResult {
  call: PlannedCall;
  status: 'ok' | 'error' | 'no_data';
  values?: Record<string, string | number>;
  newOptions?: Record<string, string[]>;
  message?: string;
}

type LookupStateInsert = Omit<LookupStateRow, 'last_error'> & { last_error: string | null };

/** Una vuelta de la consulta. Nunca lanza por la API: lo que falle queda anotado. */
export async function runRowLookup(
  db: Db,
  lookup: RowLookupRow,
  opts: RunOptions = {},
): Promise<LookupRunOutcome> {
  const clock = opts.now ?? Date.now;
  const fetcher = opts.fetcher ?? defaultLookupFetcher;
  const startedAt = clock();
  const deadline = startedAt + (opts.deadlineMs ?? DEFAULT_DEADLINE_MS);

  const { data: t, error: tError } = await db
    .from('trackers')
    .select(TRACKER_COLUMNS)
    .eq('id', lookup.tracker_id)
    .maybeSingle();
  if (tError) throw tError;
  if (!t) throw new NotFoundError('La tabla de esta consulta ya no existe.');
  let tracker = t as unknown as TrackerRow;

  const [rows, states] = await Promise.all([readTable(db, tracker.id), readStates(db, lookup.id)]);
  const plan = planLookup(lookup, tracker.fields, rows, states, startedAt);

  let credential: CustomToolRow | null = null;
  const notices: LookupNotice[] = [];
  // Se asigna dentro de los hilos: un objeto evita que TS lo dé por `null`.
  const flow: { failure: { message: string; nextMs: number; notify: boolean } | null } = {
    failure: null,
  };
  const results: CallResult[] = [];
  let calls = 0;

  try {
    credential = plan.calls.length ? await loadCredential(db, lookup) : null;
  } catch (err) {
    flow.failure = {
      message: err instanceof Error ? err.message : 'La credencial no sirve.',
      nextMs: 60 * MINUTE,
      notify: true,
    };
  }

  if (!flow.failure && plan.calls.length) {
    let stopped = false;
    let cursor = 0;
    const worker = async () => {
      while (!stopped) {
        const index = cursor++;
        const call = plan.calls[index];
        if (!call) return;
        if (clock() > deadline) {
          stopped = true;
          return;
        }
        calls += 1;
        let http: LookupHttpResult;
        try {
          http = await fetcher(call.url, credential);
        } catch (err) {
          http = {
            ok: false,
            status: null,
            message: err instanceof Error ? err.message : 'Falló la consulta.',
          };
        }
        if (http.ok) {
          const mapped = mapResponse(http.data, lookup.mapping, tracker.fields);
          results.push(
            Object.keys(mapped.values).length
              ? { call, status: 'ok', values: mapped.values, newOptions: mapped.newOptions }
              : {
                  call,
                  status: 'no_data',
                  message: `La respuesta no trae ${mapped.absent.map((p) => `«${p}»`).join(', ')}.`,
                },
          );
          continue;
        }
        if (http.status === 429) {
          stopped = true;
          flow.failure = {
            message: 'La API pidió esperar (429: demasiadas consultas). Reintento más tarde.',
            nextMs: Math.max(http.retryAfterMs ?? 0, 15 * MINUTE),
            notify: false,
          };
          results.push({ call, status: 'error', message: http.message });
          continue;
        }
        if (http.status === 401 || http.status === 403) {
          stopped = true;
          flow.failure = {
            message: `La API rechazó la credencial (${http.status}). Hay que revisarla antes de seguir.`,
            nextMs: 60 * MINUTE,
            notify: true,
          };
          results.push({ call, status: 'error', message: http.message });
          continue;
        }
        // Un 404 es «todavía no hay dato de esta fila»: se espacia, no es una falla.
        results.push({
          call,
          status: http.status === 404 ? 'no_data' : 'error',
          message: http.message,
        });
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(opts.concurrency ?? DEFAULT_CONCURRENCY, plan.calls.length) },
        worker,
      ),
    );
  }

  // Un valor nuevo en un campo de opciones amplía las opciones (como la sincronización).
  const extra: Record<string, string[]> = {};
  for (const r of results)
    for (const [key, list] of Object.entries(r.newOptions ?? {}))
      for (const v of list) {
        extra[key] ??= [];
        if (!extra[key]?.includes(v)) extra[key]?.push(v);
      }
  if (Object.keys(extra).length) {
    try {
      const fields: TrackerField[] = tracker.fields.map((f) =>
        extra[f.key]
          ? {
              ...f,
              options: [...new Set([...(f.options ?? []), ...(extra[f.key] ?? [])])].slice(0, 30),
            }
          : f,
      );
      const { tracker: updated } = await defineTracker(db, {
        slug: tracker.slug,
        name: tracker.name,
        description: tracker.description,
        fields: trackerFieldsSchema.parse(fields),
        userId: lookup.created_by,
      });
      tracker = updated;
    } catch (err) {
      logger.warn({ err, lookupId: lookup.id }, 'row lookup: no se pudieron ampliar las opciones');
    }
  }

  const now = clock();
  const stateRows: LookupStateInsert[] = [];
  let updated = 0;
  let unchanged = 0;

  for (const r of results) {
    const previous = states.get(r.call.rowId);
    let finalValues: Record<string, unknown> | null = null;
    if (r.status === 'ok' && r.values) {
      try {
        const written = await writeRow(db, tracker, r.call.rowId, r.values, lookup);
        finalValues = written.values;
        if (written.changed) updated += 1;
        else unchanged += 1;
      } catch (err) {
        r.status = 'error';
        r.message = err instanceof Error ? err.message : 'No se pudo escribir la fila.';
      }
    }
    const failCount = r.status === 'ok' ? 0 : (previous?.fail_count ?? 0) + 1;
    const rowValues = finalValues ?? rows.find((row) => row.id === r.call.rowId)?.values ?? {};
    stateRows.push({
      lookup_id: lookup.id,
      row_id: r.call.rowId,
      next_at: new Date(nextAtAfter(lookup, rowValues, now, failCount)).toISOString(),
      last_at: new Date(now).toISOString(),
      last_status: r.status,
      last_error: r.status === 'ok' ? null : (r.message ?? '').slice(0, 300) || null,
      fail_count: failCount,
    });
  }
  const errors = results.filter((r) => r.status === 'error').length;
  const failure = flow.failure;

  for (let i = 0; i < stateRows.length; i += STATE_CHUNK) {
    const { error } = await db
      .from('row_lookup_state')
      .upsert(stateRows.slice(i, i + STATE_CHUNK), { onConflict: 'lookup_id,row_id' });
    if (error)
      logger.warn({ err: error, lookupId: lookup.id }, 'row lookup: no se guardó el estado');
  }

  const capped = plan.capped;
  const status: LookupStatus =
    failure || (calls > 0 && errors === calls) ? 'error' : capped ? 'capped' : 'ok';
  const firstError = results.find((r) => r.status === 'error')?.message ?? null;
  const message: string | null =
    failure?.message ??
    (status === 'error' ? firstError : null) ??
    (capped === 'daily'
      ? `Llegó al tope de ${lookup.daily_cap} consultas de hoy; se retoma mañana (hora de Bogotá).`
      : capped === 'run'
        ? `Quedaron ${plan.deferred} filas para la próxima vuelta (tope de ${lookup.per_run_cap} por vuelta).`
        : null);

  if (capped === 'daily')
    notices.push({
      title: 'Consultas automáticas: tope del día alcanzado',
      body: `«${lookup.name}» hizo ${plan.callsToday + calls} de ${lookup.daily_cap} consultas hoy. Se retoman mañana; si necesitas más, sube el tope.`,
      dedupeKey: `row_lookup_cap:${lookup.id}:${plan.day}`,
    });
  if (failure?.notify)
    notices.push({
      title: 'Una consulta automática dejó de funcionar',
      body: `«${lookup.name}»: ${failure.message}`,
      dedupeKey: `row_lookup_auth:${lookup.id}:${plan.day}`,
    });

  // Cuándo vuelve a correr la consulta entera.
  let nextRunMs: number;
  if (failure) nextRunMs = now + failure.nextMs;
  else if (capped === 'daily') nextRunMs = nextResetMs(now);
  else {
    const candidates = [plan.nextDueMs, ...stateRows.map((s) => Date.parse(s.next_at))].filter(
      (v): v is number => v !== null && Number.isFinite(v),
    );
    const soonest = candidates.length ? Math.min(...candidates) : Number.POSITIVE_INFINITY;
    // Mínimo 5 minutos (el reloj del trabajo) y máximo 15, para ver filas nuevas.
    nextRunMs =
      capped === 'run'
        ? now + 5 * MINUTE
        : Math.min(Math.max(soonest, now + 5 * MINUTE), now + 15 * MINUTE);
  }

  const { error: markError } = await db
    .from('row_lookups')
    .update({
      calls_day: plan.day,
      calls_today: plan.callsToday + calls,
      last_run_at: new Date(now).toISOString(),
      last_status: status,
      last_error: message ? message.slice(0, 500) : null,
      last_calls: calls,
      last_updated: updated,
      next_run_at: new Date(nextRunMs).toISOString(),
      updated_at: new Date(now).toISOString(),
    })
    .eq('id', lookup.id);
  if (markError)
    logger.warn({ err: markError, lookupId: lookup.id }, 'row lookup: no se anotó la corrida');

  return {
    status,
    calls,
    updated,
    unchanged,
    errors,
    skipped: plan.skipped,
    capped,
    message,
    notices,
  };
}

/**
 * Escribe en la fila sólo las columnas del mapeo que cambiaron, sobre los
 * valores que la fila tiene AHORA (se vuelven a leer): una columna que alguien
 * del equipo editó mientras la API respondía no se pisa. Camino de escritura:
 * `upsertRow`, el mismo de `trackers.upsert`. Deja su fila de auditoría.
 */
async function writeRow(
  db: Db,
  tracker: TrackerRow,
  rowId: string,
  mapped: Record<string, string | number>,
  lookup: RowLookupRow,
): Promise<{ changed: boolean; values: Record<string, unknown> }> {
  const { data, error } = await db
    .from('tracker_rows')
    .select('id, values')
    .eq('id', rowId)
    .eq('tracker_id', tracker.id)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError('La fila ya no está en la tabla.');
  const current = ((data as { values: Record<string, string | number> | null }).values ??
    {}) as Record<string, string | number>;
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [key, value] of Object.entries(mapped))
    if (String(current[key] ?? '') !== String(value))
      changes[key] = { from: current[key] ?? null, to: value };
  if (!Object.keys(changes).length) return { changed: false, values: current };

  const known = Object.fromEntries(
    Object.entries(current).filter(([k]) => tracker.fields.some((f) => f.key === k)),
  );
  const next = {
    ...known,
    ...Object.fromEntries(Object.entries(changes).map(([k, c]) => [k, c.to])),
  };
  // Valida antes de escribir: un valor que la columna no acepta falla aquí.
  shapeValues(tracker.fields, next);
  const started = Date.now();
  await upsertRow(db, { tracker, rowId, values: next, userId: lookup.created_by });
  await writeAuditEvent({
    db,
    userId: lookup.created_by as UUID,
    toolId: 'trackers.row_lookup',
    input: { lookupId: lookup.id, rowId },
    status: 'ok',
    latencyMs: Date.now() - started,
    surface: 'schedule',
    decision: 'allowed',
    metadata: {
      from: 'consulta automática',
      lookupId: lookup.id,
      lookup: lookup.name,
      rowIds: [rowId],
      changes,
      fields: Object.keys(changes),
    },
  });
  return { changed: true, values: next };
}

// ---------------------------------------------------------------------------
// Probar con una fila
// ---------------------------------------------------------------------------

export interface LookupPreview {
  ok: boolean;
  rowId: string | null;
  rowLabel: string | null;
  url: string | null;
  /** Lo que la fila tiene hoy y lo que la API diría, por campo del mapeo. */
  fields: Array<{ field: string; label: string; current: string | null; next: string | null }>;
  message: string | null;
  calls: number;
}

/**
 * Una sola consulta de prueba, SIN escribir: arma la dirección con una fila
 * (la pedida, o la primera que cumpla el filtro y tenga todos los campos),
 * llama a la API y muestra lo que se escribiría. Sirve antes de guardar.
 */
export async function previewLookup(
  db: Db,
  input: {
    tracker: TrackerRow;
    spec: Pick<RowLookupRow, 'url_template' | 'filter' | 'mapping' | 'credential_tool_id'>;
    rowId?: string;
    now?: number;
    fetcher?: LookupFetcher;
  },
): Promise<LookupPreview> {
  const nowMs = input.now ?? Date.now();
  const empty: LookupPreview = {
    ok: false,
    rowId: null,
    rowLabel: null,
    url: null,
    fields: [],
    message: null,
    calls: 0,
  };
  const { renderLookupUrl } = await import('./template');
  const { matchesLookupFilter } = await import('./filter');
  const rows = await readTable(db, input.tracker.id);
  const pool = input.rowId ? rows.filter((r) => r.id === input.rowId) : rows;
  if (input.rowId && !pool.length) return { ...empty, message: 'Esa fila ya no está en la tabla.' };
  let chosen: { row: PlanRowInput; url: string } | null = null;
  const problems: string[] = [];
  for (const row of pool) {
    if (
      !input.rowId &&
      !matchesLookupFilter(input.spec.filter, input.tracker.fields, row.values, nowMs)
    )
      continue;
    const url = renderLookupUrl(input.spec.url_template, row.values, nowMs);
    if (url.ok) {
      chosen = { row, url: url.url };
      break;
    }
    if (problems.length < 1)
      problems.push(`Falta ${url.missing.map((m) => `«${m}»`).join(', ')} en la fila.`);
  }
  if (!chosen)
    return {
      ...empty,
      message: pool.length
        ? (problems[0] ??
          'Ninguna fila cumple el filtro ahora mismo, así que no hay con qué probar.')
        : 'La tabla no tiene filas con las que probar.',
    };

  let credential: CustomToolRow | null = null;
  if (input.spec.credential_tool_id) {
    credential = await fetchCustomToolById(db, input.spec.credential_tool_id);
    if (!credential) return { ...empty, message: 'La credencial ya no existe o no se pudo leer.' };
    const problem = describeCredentialProblem(credential, input.spec.url_template);
    if (problem) return { ...empty, message: problem };
  }
  const http = await (input.fetcher ?? defaultLookupFetcher)(chosen.url, credential).catch(
    (err): LookupHttpResult => ({
      ok: false,
      status: null,
      message: err instanceof Error ? err.message : 'Falló la consulta.',
    }),
  );
  const label = input.tracker.fields[0]
    ? String(chosen.row.values[input.tracker.fields[0].key] ?? '')
    : '';
  const base = {
    ...empty,
    rowId: chosen.row.id,
    rowLabel: label || null,
    url: chosen.url,
    calls: 1,
  };
  if (!http.ok) return { ...base, message: http.message };
  const mapped = mapResponse(http.data, input.spec.mapping, input.tracker.fields);
  const fields = input.spec.mapping.map((m) => {
    const field = input.tracker.fields.find((f) => f.key === m.field);
    const value = mapped.values[m.field];
    return {
      field: m.field,
      label: field?.label ?? m.field,
      current: chosen.row.values[m.field] === undefined ? null : String(chosen.row.values[m.field]),
      next: value === undefined ? null : String(value),
    };
  });
  return {
    ...base,
    ok: Object.keys(mapped.values).length > 0,
    fields,
    message: Object.keys(mapped.values).length
      ? null
      : `La respuesta no trae ${mapped.absent.map((p) => `«${p}»`).join(', ')}. Revisa los caminos.`,
  };
}
