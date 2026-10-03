import { ForbiddenError, type UUID, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { writeAuditEvent } from '../audit';
import { isCompanyManager } from '../directory/store';
import {
  type CloseStatus,
  OVERRIDE_MINUTES,
  PeriodLockedError,
  isLocked,
  isPeriod,
  periodLabel,
  periodOf,
} from './shape';

/**
 * EL CANDADO DE UN MES CERRADO (migración 0192).
 *
 * Cerrar un mes bloquea los cambios que HACE CORTEX con fecha de ese mes:
 * anotar o recategorizar un movimiento del libro, escribir en el programa
 * contable, marcar una tarea del cierre. No bloquea lo que llega solo (un
 * extracto tardío, la sincronización del programa): eso es la realidad
 * llegando tarde, y se ve al reabrir.
 *
 * Es un candado BLANDO: un administrador abre una ventana de cambios de
 * `OVERRIDE_MINUTES` con su motivo, y todo queda en `close_events` y en la
 * auditoría. Cada intento detenido también se anota (`bloqueado`), para que el
 * contador vea quién quiso tocar un mes cerrado.
 */

export const PERIOD_COLUMNS =
  'id, period, status, started_by, started_at, closed_by, closed_at, reopened_by, reopened_at, reopen_reason, override_until, override_by, override_reason, summary, created_at, updated_at';

export interface ClosePeriodRow {
  id: string;
  period: string;
  status: CloseStatus;
  started_by: string | null;
  started_at: string | null;
  closed_by: string | null;
  closed_at: string | null;
  reopened_by: string | null;
  reopened_at: string | null;
  reopen_reason: string | null;
  override_until: string | null;
  override_by: string | null;
  override_reason: string | null;
  summary: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export async function getClosePeriod(
  db: SupabaseClient,
  period: string,
): Promise<ClosePeriodRow | null> {
  const { data, error } = await db
    .from('close_periods')
    .select(PERIOD_COLUMNS)
    .eq('period', period)
    .maybeSingle();
  if (error) throw error;
  return (data as ClosePeriodRow | null) ?? null;
}

export async function recordCloseEvent(
  db: SupabaseClient,
  input: {
    period: string;
    kind: 'cerrado' | 'reabierto' | 'ventana' | 'tarea' | 'bloqueado';
    userId?: string | null;
    detail?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const { error } = await db.from('close_events').insert({
    period: input.period,
    kind: input.kind,
    user_id: input.userId ?? null,
    detail: input.detail?.slice(0, 1000) ?? null,
    metadata: input.metadata ?? {},
  });
  if (error) throw error;
}

/** ¿Está cerrado (sin ventana abierta) el mes de este día? */
export async function isDayLocked(
  db: SupabaseClient,
  day: string,
  now: Date = new Date(),
): Promise<boolean> {
  return isLocked(await getClosePeriod(db, periodOf(day)), now);
}

/**
 * Lanza `PeriodLockedError` si el mes de `day` está cerrado; anota el intento.
 * `action` completa la frase: «no se puede ${action} con fecha de ese mes».
 */
export async function assertPeriodOpen(
  db: SupabaseClient,
  day: string,
  opts: { action: string; userId?: string | null; now?: Date },
): Promise<void> {
  const period = periodOf(day);
  if (!isPeriod(period)) return;
  const row = await getClosePeriod(db, period);
  if (!isLocked(row, opts.now ?? new Date())) return;
  await recordCloseEvent(db, {
    period,
    kind: 'bloqueado',
    userId: opts.userId ?? null,
    detail: `Se intentó ${opts.action}.`,
  }).catch(() => undefined);
  throw new PeriodLockedError(period, opts.action);
}

/**
 * Abrir una ventana de cambios en un mes cerrado: sólo un administrador o
 * dueño, con motivo. Dura `OVERRIDE_MINUTES`.
 */
export async function openOverrideWindow(
  db: SupabaseClient,
  input: { period: string; userId: string; reason: string; now?: Date },
): Promise<ClosePeriodRow> {
  if (!(await isCompanyManager(db, input.userId)))
    throw new ForbiddenError(
      'Sólo un administrador o dueño puede abrir cambios en un mes cerrado.',
    );
  const reason = input.reason.trim();
  if (reason.length < 5) throw new ValidationError('Di por qué hay que cambiar un mes cerrado.');
  const row = await getClosePeriod(db, input.period);
  if (!row || row.status !== 'cerrado')
    throw new ValidationError(`${periodLabel(input.period)} no está cerrado.`);
  const until = new Date(
    (input.now ?? new Date()).getTime() + OVERRIDE_MINUTES * 60_000,
  ).toISOString();
  const { data, error } = await db
    .from('close_periods')
    .update({
      override_until: until,
      override_by: input.userId,
      override_reason: reason.slice(0, 500),
      updated_at: new Date().toISOString(),
    })
    .eq('id', row.id)
    .select(PERIOD_COLUMNS)
    .single();
  if (error) throw error;
  await recordCloseEvent(db, {
    period: input.period,
    kind: 'ventana',
    userId: input.userId,
    detail: reason,
    metadata: { until },
  });
  await writeAuditEvent({
    db,
    userId: input.userId as UUID,
    toolId: 'close.override',
    input: { period: input.period, reason },
    status: 'ok',
    latencyMs: 0,
    surface: 'web',
    decision: 'confirmed',
    metadata: { until },
  });
  return data as ClosePeriodRow;
}
