import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type EventView,
  RUN_COLUMNS,
  type RunView,
  TASK_COLUMNS,
  type TaskStatus,
  type TaskView,
  toEventView,
  toRunView,
  toTaskView,
} from './types';

/**
 * Every read the orchestrator surface does, in one place.
 *
 * The `organizationId` argument is not optional anywhere a run is fetched by
 * id: tenant scoping belongs in the query, so that forgetting it is a type
 * error rather than a cross-workspace leak nobody notices.
 */

export interface RunSummaryRow extends RunView {
  taskCount: number;
  taskStatuses: TaskStatus[];
}

export async function listRuns(
  db: SupabaseClient,
  organizationId: string,
  limit = 40,
): Promise<RunSummaryRow[]> {
  const { data } = await db
    .from('orchestration_runs')
    .select(`${RUN_COLUMNS}, orchestration_tasks(status)`)
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .limit(limit);

  return ((data ?? []) as Record<string, unknown>[]).map((row) => {
    const statuses = ((row.orchestration_tasks as Array<{ status: string }> | null) ?? []).map(
      (t) => t.status as TaskStatus,
    );
    return { ...toRunView(row), taskCount: statuses.length, taskStatuses: statuses };
  });
}

export async function loadRun(
  db: SupabaseClient,
  runId: string,
  organizationId: string,
): Promise<RunView | null> {
  const { data } = await db
    .from('orchestration_runs')
    .select(RUN_COLUMNS)
    .eq('id', runId)
    .eq('organization_id', organizationId)
    .maybeSingle();
  return data ? toRunView(data as Record<string, unknown>) : null;
}

export async function loadTasks(db: SupabaseClient, runId: string): Promise<TaskView[]> {
  const { data } = await db
    .from('orchestration_tasks')
    .select(TASK_COLUMNS)
    .eq('run_id', runId)
    .order('seq', { ascending: true });
  return ((data ?? []) as Record<string, unknown>[]).map(toTaskView);
}

/**
 * The event log after `afterId`, oldest first.
 *
 * Ordered and paged by `id` rather than `created_at` because bigserial is the
 * only thing that is strictly monotonic here — several sub-agents append
 * concurrently and their clocks are the same millisecond often enough to matter.
 */
export async function loadEvents(
  db: SupabaseClient,
  runId: string,
  afterId = 0,
  limit = 500,
): Promise<EventView[]> {
  const { data } = await db
    .from('orchestration_events')
    .select('id, run_id, task_id, kind, payload, created_at')
    .eq('run_id', runId)
    .gt('id', afterId)
    .order('id', { ascending: true })
    .limit(limit);
  return ((data ?? []) as Record<string, unknown>[]).map(toEventView);
}
