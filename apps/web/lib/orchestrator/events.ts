import 'server-only';
import { logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { EventKind } from './types';

/**
 * The append-only log the live console tails.
 *
 * Every write is best-effort by design: the log is an observation of the run,
 * never part of it. A console that misses a line is a cosmetic problem; a
 * sub-agent that dies because its telemetry insert timed out is a real one.
 */
export async function emit(
  db: SupabaseClient,
  runId: string,
  taskId: string | null,
  kind: EventKind,
  payload: Record<string, unknown> = {},
): Promise<void> {
  try {
    const { error } = await db
      .from('orchestration_events')
      .insert({ run_id: runId, task_id: taskId, kind, payload });
    if (error) throw new Error(error.message);
  } catch (err) {
    logger.error('orchestrator: could not append event', {
      runId,
      kind,
      error: (err as Error).message,
    });
  }
}

/** Caps a string for storage in an event payload, marking the cut. */
export function preview(value: unknown, max: number): string {
  const text =
    typeof value === 'string'
      ? value
      : (() => {
          try {
            return JSON.stringify(value) ?? String(value);
          } catch {
            // Circular or otherwise unserialisable tool output — the shape is
            // still worth showing, so fall back to the default coercion.
            return String(value);
          }
        })();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
