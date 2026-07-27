/**
 * The claim guard.
 *
 * Two workers must never run the same task. The guard is a compare-and-set:
 * read the row, then UPDATE it filtered on both the status AND the exact
 * `attempt_count` we read. The database decides who wins — a loser matches
 * zero rows and stops. There is no read-then-blind-write window.
 *
 * The CAS on `attempt_count` (rather than status alone) is what lets the same
 * statement increment the counter, so a task that crashes mid-run and is
 * requeued still cannot be retried past `max_attempts`.
 *
 * This sits BEHIND Inngest's per-task concurrency key. Two layers because they
 * fail differently: Inngest's is scoped to its own scheduler and would not stop
 * a manually re-sent event or a second deployment, while the DB guard cannot by
 * itself tell "running" from "crashed while running".
 */

import type { DevTask } from './types';

/**
 * The narrow slice of the supabase-js query builder the guard uses, declared
 * structurally so the guard is testable against a stub with no live database.
 * Call sites pass the service client through a single documented cast.
 */
export interface ClaimQueryBuilder extends PromiseLike<ClaimResponse> {
  select(columns: string): ClaimQueryBuilder;
  update(values: Record<string, unknown>): ClaimQueryBuilder;
  eq(column: string, value: unknown): ClaimQueryBuilder;
  maybeSingle(): PromiseLike<ClaimResponse>;
}

export interface ClaimResponse {
  data: unknown;
  error: { message: string } | null;
}

export interface ClaimDbClient {
  from(table: string): ClaimQueryBuilder;
}

export type ClaimFailure = 'not_found' | 'not_claimable' | 'attempts_exhausted' | 'lost_race';

export type ClaimResult =
  | { claimed: true; task: DevTask }
  | { claimed: false; reason: ClaimFailure; task: DevTask | null };

/** Columns the executor reads. Kept in one place so both queries agree. */
export const DEV_TASK_COLUMNS =
  'id, external_id, external_identifier, external_url, title, description, ' +
  'repository_id, repository_key, requester_name, requester_email, status, ' +
  'attempt_count, max_attempts';

/** Move a task from `queued` to `running`, or report why we could not. */
export async function claimDevTask(
  db: ClaimDbClient,
  taskId: string,
  nowIso: string = new Date().toISOString(),
): Promise<ClaimResult> {
  const read = await db.from('dev_tasks').select(DEV_TASK_COLUMNS).eq('id', taskId).maybeSingle();
  if (read.error) throw new Error(`Failed to read dev task ${taskId}: ${read.error.message}`);

  const current = read.data as DevTask | null;
  if (!current) return { claimed: false, reason: 'not_found', task: null };
  if (current.status !== 'queued') {
    return { claimed: false, reason: 'not_claimable', task: current };
  }

  const attempt = current.attempt_count + 1;
  if (attempt > current.max_attempts) {
    return { claimed: false, reason: 'attempts_exhausted', task: current };
  }

  const claim = await db
    .from('dev_tasks')
    .update({
      status: 'running',
      attempt_count: attempt,
      started_at: nowIso,
      updated_at: nowIso,
      error: null,
    })
    .eq('id', taskId)
    // The guard: both predicates must still hold at write time. Whoever gets
    // here second matches nothing, because the winner already moved both.
    .eq('status', 'queued')
    .eq('attempt_count', current.attempt_count)
    .select(DEV_TASK_COLUMNS);

  if (claim.error) throw new Error(`Failed to claim dev task ${taskId}: ${claim.error.message}`);

  const rows = (claim.data ?? []) as DevTask[];
  const claimed = rows[0];
  if (!claimed) return { claimed: false, reason: 'lost_race', task: current };

  return { claimed: true, task: claimed };
}
