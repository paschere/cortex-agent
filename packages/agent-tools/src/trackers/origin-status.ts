import { NotFoundError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type OriginStatus,
  REFRESH_MIN_INTERVAL_MS,
  type TrackerOrigin,
  originName,
  originsOf,
} from './origin';

/**
 * LA FRESCURA DE UNA TABLA SINCRONIZADA Y «ACTUALIZAR AHORA» (0237).
 *
 * La última lectura y su estado NO se copian a la tabla: viven donde ya están
 * (la conexión contable, `tracker_syncs`, `drive_folder_syncs`) y se leen por
 * el `ref` del origen. «Actualizar ahora» es lo que ya hacía cada una —adelantar
 * `next_run_at` y encolar la corrida—, con un tope de frecuencia y sin cambiar
 * la configuración.
 */

const TABLE_OF = {
  accounting: 'accounting_connections',
  sheet: 'tracker_syncs',
  drive_folder: 'drive_folder_syncs',
} as const;

const JOB_OF = {
  accounting: 'accounting/run',
  sheet: 'table-sync/run',
  drive_folder: 'drive-table/run',
} as const;

/** Una corrida pedida o vencida hace menos de esto sigue «actualizando». */
const RUNNING_WINDOW_MS = 10 * 60_000;

export interface SyncRowTimes {
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  next_run_at: string | null;
  enabled: boolean;
}

/** El estado visible de una conexión/sincronización, de sus columnas. Puro. */
export function statusOfSyncRow(row: SyncRowTimes | null, now: number = Date.now()): OriginStatus {
  if (!row) return { lastSyncAt: null, state: 'never' };
  const last = row.last_run_at ? new Date(row.last_run_at).getTime() : null;
  const due = row.next_run_at ? new Date(row.next_run_at).getTime() : null;
  // Pedida (o vencida) y todavía sin una lectura posterior a ese momento.
  const running =
    row.enabled &&
    due !== null &&
    due <= now &&
    now - due < RUNNING_WINDOW_MS &&
    (last === null || last < due);
  return {
    lastSyncAt: row.last_run_at,
    state: row.last_run_at === null ? 'never' : row.last_status === 'error' ? 'error' : 'ok',
    error: row.last_error,
    running,
  };
}

/** Segundos que faltan para poder pedir otra vez (0 = ya), o el motivo si ya corre. Puro. */
export function refreshDecision(
  row: SyncRowTimes,
  now: number = Date.now(),
): { ok: true } | { ok: false; reason: 'paused' | 'running' | 'too_soon'; waitSeconds: number } {
  if (!row.enabled) return { ok: false, reason: 'paused', waitSeconds: 0 };
  const status = statusOfSyncRow(row, now);
  if (status.running) return { ok: false, reason: 'running', waitSeconds: 0 };
  const last = row.last_run_at ? new Date(row.last_run_at).getTime() : 0;
  const left = REFRESH_MIN_INTERVAL_MS - (now - last);
  if (last && left > 0)
    return { ok: false, reason: 'too_soon', waitSeconds: Math.ceil(left / 1000) };
  return { ok: true };
}

const COLUMNS = 'id, last_run_at, last_status, last_error, next_run_at, enabled, created_by';

export interface OriginWithStatus {
  origin: TrackerOrigin;
  status: OriginStatus;
  /** Quién creó la sincronización (hojas y carpetas); la contable no tiene dueño por fila. */
  createdBy: string | null;
  enabled: boolean;
}

/** Los orígenes de una tabla con su última lectura. Una consulta por origen. */
export async function loadOriginStatuses(
  db: SupabaseClient,
  tracker: { origins?: unknown },
  now: number = Date.now(),
): Promise<OriginWithStatus[]> {
  const out: OriginWithStatus[] = [];
  for (const origin of originsOf(tracker)) {
    const { data } = await db
      .from(TABLE_OF[origin.kind])
      .select(COLUMNS)
      .eq('id', origin.ref)
      .maybeSingle();
    const row = (data ?? null) as (SyncRowTimes & { created_by?: string }) | null;
    out.push({
      origin,
      status: statusOfSyncRow(row, now),
      createdBy: row?.created_by ?? null,
      enabled: row?.enabled ?? false,
    });
  }
  return out;
}

export type RefreshResult =
  | { ok: true; queued: boolean; note: string }
  | { ok: false; error: string; waitSeconds?: number };

/**
 * Pide leer ya el origen: adelanta `next_run_at` y encola la corrida. Quien
 * llama decide ANTES si la persona puede (contable: administración; hoja y
 * carpeta: quien la creó o administra). Nunca lanza por «muy pronto»: lo dice.
 */
export async function requestOriginRefresh(
  db: SupabaseClient,
  origin: TrackerOrigin,
  deps: {
    organizationId: string;
    enqueueJob?: (name: string, data: Record<string, unknown>) => Promise<boolean>;
    now?: number;
  },
): Promise<RefreshResult> {
  const now = deps.now ?? Date.now();
  const table = TABLE_OF[origin.kind];
  const { data, error } = await db.from(table).select(COLUMNS).eq('id', origin.ref).maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError(`${originName(origin)} ya no está conectado.`);
  const decision = refreshDecision(data as SyncRowTimes, now);
  if (!decision.ok) {
    if (decision.reason === 'paused')
      return {
        ok: false,
        error: `La sincronización con ${originName(origin)} está en pausa. Reactívala primero.`,
      };
    if (decision.reason === 'running')
      return { ok: false, error: `Ya se está actualizando desde ${originName(origin)}.` };
    return {
      ok: false,
      error: `Se actualizó hace un momento. Vuelve a intentar en ${decision.waitSeconds} s.`,
      waitSeconds: decision.waitSeconds,
    };
  }
  const { error: updateError } = await db
    .from(table)
    .update({ next_run_at: new Date(now).toISOString() })
    .eq('id', origin.ref)
    .eq('enabled', true);
  if (updateError) throw updateError;
  const payload =
    origin.kind === 'accounting'
      ? { organizationId: deps.organizationId, connectionId: origin.ref }
      : { organizationId: deps.organizationId, syncId: origin.ref };
  const queued = Boolean(await deps.enqueueJob?.(JOB_OF[origin.kind], payload));
  return {
    ok: true,
    queued,
    note: queued
      ? `Actualizando desde ${originName(origin)}…`
      : 'Quedó para la próxima vuelta (en unos minutos).',
  };
}

/** Quien puede pedir «Actualizar ahora»: contable → administración; hoja/carpeta → quien la creó o administra. */
export function canRefreshOrigin(
  entry: Pick<OriginWithStatus, 'origin' | 'createdBy'>,
  who: { userId: string; canManage: boolean },
): boolean {
  if (who.canManage) return true;
  return entry.origin.kind !== 'accounting' && entry.createdBy === who.userId;
}
