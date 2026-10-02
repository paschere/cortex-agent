import { randomUUID } from 'node:crypto';
import { logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { toolErrorMessage } from '../tool-error';
import type { ActionRow, VerifyOutcome } from './types';

/**
 * EL RECLAMO: QUIÉN EJECUTA UNA ACCIÓN, Y SÓLO UNO (migración 0168).
 *
 * Una fila por (empresa, clave) en `action_idempotency`. Ejecutar exige
 * RECLAMARLA, y el reclamo es una sola sentencia en cada camino:
 *
 *   · la primera vez, un `insert`: si dos procesos llegan a la vez, la
 *     restricción única deja entrar a uno y al otro le devuelve 23505;
 *   · las siguientes, un `update … where key = … and attempt_id = <el que leí>
 *     and status = <el que leí>`: compare-and-swap. Si otro proceso tocó la fila
 *     entre la lectura y la escritura, el `attempt_id` ya no es el mismo y la
 *     escritura no toca nada.
 *
 * Un leer-y-luego-escribir pasaría todas las pruebas hechas con un Map y
 * ejecutaría dos veces con dos workers reales; por eso las dos decisiones que
 * importan viven en un WHERE y no en un `if`.
 *
 * QUÉ PASA SI LA TABLA NO RESPONDE. La guardia se abre (`unguarded`) y la
 * acción corre como corría antes de que existiera esta tabla: una base de datos
 * sin la migración aplicada, o caída un instante, no puede dejar a nadie sin
 * poder mandar un correo. Queda escrito en la auditoría, así que «se ejecutó
 * sin guardia» nunca es silencioso.
 */

const TABLE = 'action_idempotency';

/** Cuánto puede durar una ejecución antes de darla por muerta. */
export const STALE_IN_FLIGHT_MS = 10 * 60_000;

/** Lo que cabe del resultado guardado. Lo demás se resume, no se trunca a medias. */
const MAX_RESULT_BYTES = 8_000;

const ROW_COLUMNS =
  'key,tool_id,status,attempt_id,attempts,claimed_at,finished_at,window_ends_at,result,result_summary,verification,verification_detail';

export type ClaimOutcome =
  /** Esta llamada ejecuta. `repeatOf` = la vez anterior que salió bien, si se repite a sabiendas. */
  | { kind: 'claimed'; attemptId: string; repeatOf: ActionRow | null }
  /** Ya se hizo dentro de la ventana: devolver lo de entonces. */
  | { kind: 'replay'; row: ActionRow }
  /** Otro proceso la está ejecutando ahora mismo. */
  | { kind: 'in_flight'; row: ActionRow }
  /** Un intento anterior no terminó y no se sabe si el efecto ocurrió. */
  | { kind: 'unknown'; row: ActionRow }
  /** La tabla no respondió: se ejecuta sin guardia, y se dice. */
  | { kind: 'unguarded'; reason: string };

export interface ClaimInput {
  key: string;
  toolId: string;
  userId: string;
  conversationId?: string | null;
  scope?: string | null;
  windowMs: number;
  /** La persona pidió repetirla a sabiendas. Nunca salta una ejecución en vuelo. */
  allowRepeat: boolean;
  now?: Date;
  staleMs?: number;
}

function isUniqueViolation(error: { code?: string; message?: string } | null): boolean {
  return Boolean(
    error &&
      (error.code === '23505' || /duplicate key|unique constraint/i.test(error.message ?? '')),
  );
}

/** Lectura por clave. `undefined` = la tabla no respondió; `null` = no hay fila. */
export async function readAction(
  db: SupabaseClient,
  key: string,
): Promise<ActionRow | null | undefined> {
  try {
    const { data, error } = await db.from(TABLE).select(ROW_COLUMNS).eq('key', key).maybeSingle();
    if (error) {
      logger.warn({ err: error }, 'action_idempotency read failed');
      return undefined;
    }
    return (data as ActionRow | null) ?? null;
  } catch (err) {
    logger.warn({ err }, 'action_idempotency read threw');
    return undefined;
  }
}

/** ¿Sigue valiendo lo hecho? Dentro de la ventana que se fijó al terminar. */
export function withinWindow(row: ActionRow, now: Date): boolean {
  return (
    row.status === 'succeeded' &&
    row.window_ends_at !== null &&
    new Date(row.window_ends_at).getTime() > now.getTime()
  );
}

export function isStale(row: ActionRow, now: Date, staleMs = STALE_IN_FLIGHT_MS): boolean {
  return now.getTime() - new Date(row.claimed_at).getTime() > staleMs;
}

/**
 * Qué haría un reclamo con esta fila, sin escribir nada. Lo usan el reclamo
 * mismo y la mirada previa de `runTool` (antes de pedir confirmación: no tiene
 * sentido pedirle a alguien que apruebe algo que ya se hizo).
 */
export function judge(
  row: ActionRow,
  opts: { allowRepeat: boolean; now: Date; staleMs?: number },
): 'replay' | 'in_flight' | 'unknown' | 'takeover' {
  if (row.status === 'in_flight') {
    if (!isStale(row, opts.now, opts.staleMs)) return 'in_flight';
    return opts.allowRepeat ? 'takeover' : 'unknown';
  }
  if (withinWindow(row, opts.now) && !opts.allowRepeat) return 'replay';
  return 'takeover';
}

export async function claimAction(db: SupabaseClient, input: ClaimInput): Promise<ClaimOutcome> {
  const now = input.now ?? new Date();
  try {
    // Tres vueltas bastan: cada una sólo se repite porque OTRO proceso movió la
    // fila, y si eso pasa tres veces seguidas lo honesto es decir «en vuelo».
    for (let round = 0; round < 3; round++) {
      const attemptId = randomUUID();
      const { error: insertError } = await db.from(TABLE).insert({
        key: input.key,
        tool_id: input.toolId,
        user_id: input.userId,
        conversation_id: input.conversationId ?? null,
        scope: input.scope ?? null,
        status: 'in_flight',
        attempt_id: attemptId,
        attempts: 1,
        claimed_at: now.toISOString(),
      });
      if (!insertError) return { kind: 'claimed', attemptId, repeatOf: null };
      if (!isUniqueViolation(insertError)) {
        logger.warn({ err: insertError }, 'action_idempotency claim insert failed');
        return { kind: 'unguarded', reason: toolErrorMessage(insertError) };
      }

      const read = await readAction(db, input.key);
      if (read === undefined) return { kind: 'unguarded', reason: 'lectura fallida' };
      if (read === null) continue; // la purgaron entre medias: volver a insertar
      // Una copia: lo leído es el testigo del CAS y el «la vez anterior» del
      // aviso, y ninguno de los dos puede cambiar porque la fila cambie después.
      const row: ActionRow = { ...read };

      const verdict = judge(row, { allowRepeat: input.allowRepeat, now, staleMs: input.staleMs });
      if (verdict === 'replay') return { kind: 'replay', row };
      if (verdict === 'in_flight') return { kind: 'in_flight', row };
      if (verdict === 'unknown') return { kind: 'unknown', row };

      // Compare-and-swap sobre lo que se acaba de leer.
      const { data: taken, error: takeError } = await db
        .from(TABLE)
        .update({
          status: 'in_flight',
          attempt_id: attemptId,
          attempts: (row.attempts ?? 1) + 1,
          claimed_at: now.toISOString(),
          user_id: input.userId,
          conversation_id: input.conversationId ?? null,
          finished_at: null,
          error: null,
          verification: null,
          verification_detail: null,
        })
        .eq('key', input.key)
        .eq('attempt_id', row.attempt_id)
        .eq('status', row.status)
        .select('key')
        .maybeSingle();
      if (takeError) {
        logger.warn({ err: takeError }, 'action_idempotency takeover failed');
        return { kind: 'unguarded', reason: toolErrorMessage(takeError) };
      }
      if (taken) {
        return {
          kind: 'claimed',
          attemptId,
          repeatOf: row.status === 'succeeded' ? row : null,
        };
      }
    }
    const row = await readAction(db, input.key);
    return row
      ? { kind: 'in_flight', row }
      : { kind: 'unguarded', reason: 'sin fila tras reintentos' };
  } catch (err) {
    logger.warn({ err }, 'action_idempotency claim threw');
    return { kind: 'unguarded', reason: toolErrorMessage(err) };
  }
}

/** El resultado, guardado sólo si cabe entero. Un JSON cortado a medias no sirve. */
function storableResult(result: unknown): unknown {
  try {
    const json = JSON.stringify(result);
    if (json === undefined || json.length > MAX_RESULT_BYTES) return null;
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export async function settleSuccess(
  db: SupabaseClient,
  input: {
    key: string;
    attemptId: string;
    windowMs: number;
    result: unknown;
    summary: string | null;
    verification: VerifyOutcome | null;
    now?: Date;
  },
): Promise<void> {
  const now = input.now ?? new Date();
  try {
    const { error } = await db
      .from(TABLE)
      .update({
        status: 'succeeded',
        finished_at: now.toISOString(),
        window_ends_at: new Date(now.getTime() + input.windowMs).toISOString(),
        result: storableResult(input.result),
        result_summary: input.summary?.slice(0, 300) ?? null,
        verification: input.verification?.status ?? null,
        verification_detail: input.verification?.detail.slice(0, 300) ?? null,
      })
      .eq('key', input.key)
      .eq('attempt_id', input.attemptId);
    if (error) logger.warn({ err: error }, 'action_idempotency settle success failed');
  } catch (err) {
    logger.warn({ err }, 'action_idempotency settle success threw');
  }
}

export async function settleFailure(
  db: SupabaseClient,
  input: { key: string; attemptId: string; error: string; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date();
  try {
    const { error } = await db
      .from(TABLE)
      .update({
        status: 'failed',
        finished_at: now.toISOString(),
        error: input.error.slice(0, 500),
      })
      .eq('key', input.key)
      .eq('attempt_id', input.attemptId);
    if (error) logger.warn({ err: error }, 'action_idempotency settle failure failed');
  } catch (err) {
    logger.warn({ err }, 'action_idempotency settle failure threw');
  }
}
