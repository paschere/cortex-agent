/**
 * The four writes that decide whether a run is alive, and who owns it.
 *
 * Every one of them is a CONDITIONAL UPDATE whose guard lives in the WHERE
 * clause, never a read followed by a write. That is the whole design: two
 * workers can both read "this run is unclaimed", and both can read "this run
 * has been silent for twenty minutes" — only the database can decide which of
 * them acted first. A read-then-write would pass any test built on a Map and
 * still start the same run twice in production.
 *
 *   claimRun        planning + unclaimed → claimed. Exactly one worker wins.
 *   heartbeat       "still alive", throttled per process so the event log's
 *                   write volume does not double.
 *   interruptRun    live + silent past the cutoff → interrupted. Idempotent:
 *                   the second caller matches zero rows and does nothing.
 *   settleTasks     the sub-agent rows a dead run left mid-air.
 *
 * Typed against a narrow structural interface rather than SupabaseClient so it
 * can be tested against a stub that models compare-and-set faithfully, with no
 * live database. Call sites pass a scoped client through one documented cast —
 * the same shape lib/dev-tasks and packages/agent-tools/src/dev/claim.ts use.
 */

import {
  CANCELLED_PENDING_TASK_ERROR,
  CANCELLED_TASK_ERROR,
  HEARTBEAT_INTERVAL_MS,
  INTERRUPTED_EVENT_MESSAGE,
  INTERRUPTED_SUMMARY,
  INTERRUPTED_TASK_ERROR,
  SKIPPED_TASK_ERROR,
  staleCutoffIso,
} from './liveness';
import type { RunStatus } from './types';

// ---------------------------------------------------------------------------
// The slice of supabase-js this module uses
// ---------------------------------------------------------------------------

export interface LifecycleResponse {
  data: unknown;
  error: { message: string } | null;
}

export interface LifecycleBuilder extends PromiseLike<LifecycleResponse> {
  select(columns?: string): LifecycleBuilder;
  update(values: Record<string, unknown>): LifecycleBuilder;
  insert(values: Record<string, unknown>): LifecycleBuilder;
  eq(column: string, value: unknown): LifecycleBuilder;
  in(column: string, values: unknown[]): LifecycleBuilder;
  lt(column: string, value: unknown): LifecycleBuilder;
  is(column: string, value: unknown): LifecycleBuilder;
  maybeSingle(): PromiseLike<LifecycleResponse>;
}

export interface LifecycleDb {
  from(table: string): LifecycleBuilder;
}

/** Statuses a run can be in while work is expected to be happening. */
const LIVE: readonly RunStatus[] = ['planning', 'running'];

function rowsOf(response: LifecycleResponse): Record<string, unknown>[] {
  return (response.data ?? []) as Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

export type ClaimFailure = 'not_found' | 'not_live' | 'already_claimed';

export type ClaimRunResult =
  | { claimed: true; run: { id: string; objective: string; status: RunStatus } }
  | { claimed: false; reason: ClaimFailure };

/**
 * Take ownership of a run, or report why we could not.
 *
 * Inngest's `concurrency: { key: event.data.runId, limit: 1 }` already stops a
 * second execution of the same event, but it cannot stop a manually re-sent
 * event, a second Inngest environment pointed at the same database, or the
 * older `after()` path still in flight during a deploy. Two layers, because
 * they fail differently — the same argument dev-task-run.ts makes.
 *
 * Guards, all in the WHERE clause: the run must still exist, must still be in a
 * live status (a cancel that landed first must win), and must be unclaimed.
 */
export async function claimRun(
  db: LifecycleDb,
  runId: string,
  nowIso: string = new Date().toISOString(),
): Promise<ClaimRunResult> {
  const claim = await db
    .from('orchestration_runs')
    .update({ claimed_at: nowIso, last_heartbeat_at: nowIso })
    .eq('id', runId)
    .in('status', LIVE as unknown as unknown[])
    .is('claimed_at', null)
    .select('id, objective, status');

  if (claim.error) throw new Error(`Could not claim run ${runId}: ${claim.error.message}`);

  const won = rowsOf(claim)[0];
  if (won) {
    return {
      claimed: true,
      run: {
        id: won.id as string,
        objective: (won.objective as string | null) ?? '',
        status: won.status as RunStatus,
      },
    };
  }

  // Nothing was claimed. Read the row back only to say WHY — this never
  // authorises anything, the claim above already refused.
  const read = await db
    .from('orchestration_runs')
    .select('id, status, claimed_at')
    .eq('id', runId)
    .maybeSingle();
  const row = (read.data ?? null) as Record<string, unknown> | null;
  if (!row) return { claimed: false, reason: 'not_found' };
  if (row.claimed_at != null) return { claimed: false, reason: 'already_claimed' };
  return { claimed: false, reason: 'not_live' };
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

/**
 * Last time this process touched each run. The throttle is per process, which
 * is exactly the right scope: only one worker executes a given run at a time
 * (see claimRun), so this is the whole picture for that run.
 */
const lastTouched = new Map<string, number>();

/** Testing seam — a fresh module state per case without exporting the Map. */
export function resetHeartbeatThrottle(): void {
  lastTouched.clear();
}

/**
 * Say the run is still alive.
 *
 * Called from `emit()`, so every plan, task boundary, tool call and tool result
 * counts as a sign of life without any code having to remember to report one —
 * and throttled to HEARTBEAT_INTERVAL_MS so a tool-happy sub-agent does not
 * double the write volume of the event log.
 *
 * Best-effort, like the log itself: a run must never die because its telemetry
 * write timed out. The cost of a dropped beat is at worst an early sweep, and
 * the sweep's threshold is thirty beats wide.
 */
export async function heartbeat(
  db: LifecycleDb,
  runId: string,
  options: { force?: boolean; now?: number } = {},
): Promise<void> {
  const now = options.now ?? Date.now();
  const previous = lastTouched.get(runId) ?? 0;
  if (!options.force && now - previous < HEARTBEAT_INTERVAL_MS) return;
  lastTouched.set(runId, now);

  try {
    await db
      .from('orchestration_runs')
      .update({ last_heartbeat_at: new Date(now).toISOString() })
      .eq('id', runId)
      .in('status', LIVE as unknown as unknown[])
      .select('id');
  } catch {
    // Deliberately swallowed. See above.
  }
}

// ---------------------------------------------------------------------------
// Settling the tasks a stopped run left behind
// ---------------------------------------------------------------------------

export type SettleReason = 'interrupted' | 'cancelled';

const SETTLE_TEXT: Record<SettleReason, { running: string; pending: string }> = {
  interrupted: { running: INTERRUPTED_TASK_ERROR, pending: SKIPPED_TASK_ERROR },
  cancelled: { running: CANCELLED_TASK_ERROR, pending: CANCELLED_PENDING_TASK_ERROR },
};

/**
 * Close the sub-agent rows a stopped run left mid-air.
 *
 * Without this the manifest keeps a spinner on a card whose sub-agent died with
 * the process — the same lie as the run pill, one level down. `running` becomes
 * `failed` because that is the only non-terminal-looking status a task has and
 * the message says which kind of failure it was; `pending` becomes `skipped`,
 * which is what it actually is.
 *
 * A sub-agent that survives the cancel and finishes a moment later overwrites
 * its own row with the real result. That is the better outcome, so it is left
 * to win.
 */
export async function settleUnfinishedTasks(
  db: LifecycleDb,
  runId: string,
  reason: SettleReason,
  nowIso: string = new Date().toISOString(),
): Promise<number> {
  const text = SETTLE_TEXT[reason];
  let settled = 0;

  for (const [from, to, message] of [
    ['running', 'failed', text.running],
    ['pending', 'skipped', text.pending],
  ] as const) {
    const result = await db
      .from('orchestration_tasks')
      .update({ status: to, error: message, finished_at: nowIso })
      .eq('run_id', runId)
      .eq('status', from)
      .select('id');
    if (result.error) continue;
    settled += rowsOf(result).length;
  }

  return settled;
}

// ---------------------------------------------------------------------------
// Interrupt
// ---------------------------------------------------------------------------

/**
 * Declare a silent run interrupted — idempotent, and safe against a run that
 * comes back to life between the sweep's scan and its write.
 *
 * The freshness guard is repeated in the UPDATE rather than trusted from the
 * scan: several minutes of sweep can pass in between, and a run that beat once
 * in that window is alive and must not be closed. Whoever gets here second
 * matches zero rows and returns false, so a double sweep cannot write the
 * closing events twice.
 */
export async function interruptRun(
  db: LifecycleDb,
  runId: string,
  options: { now?: number; cutoffIso?: string } = {},
): Promise<boolean> {
  const now = options.now ?? Date.now();
  const cutoff = options.cutoffIso ?? staleCutoffIso(now);
  const nowIso = new Date(now).toISOString();

  const closed = await db
    .from('orchestration_runs')
    .update({
      status: 'interrupted' satisfies RunStatus,
      finished_at: nowIso,
      summary: INTERRUPTED_SUMMARY,
      last_heartbeat_at: nowIso,
    })
    .eq('id', runId)
    .in('status', LIVE as unknown as unknown[])
    .lt('last_heartbeat_at', cutoff)
    .select('id, total_tokens');

  if (closed.error) throw new Error(`Could not close run ${runId}: ${closed.error.message}`);

  const row = rowsOf(closed)[0];
  if (!row) return false;

  await settleUnfinishedTasks(db, runId, 'interrupted', nowIso);

  // The console is driven by the log, so a run closed behind its back has to
  // say so there too — otherwise an open console keeps waiting for a report
  // that will never be written.
  await db.from('orchestration_events').insert({
    run_id: runId,
    task_id: null,
    kind: 'error',
    payload: { message: INTERRUPTED_EVENT_MESSAGE },
  });
  await db.from('orchestration_events').insert({
    run_id: runId,
    task_id: null,
    kind: 'run_done',
    payload: {
      status: 'interrupted',
      summary: INTERRUPTED_SUMMARY,
      totalTokens: (row.total_tokens as number | null) ?? 0,
    },
  });

  return true;
}
