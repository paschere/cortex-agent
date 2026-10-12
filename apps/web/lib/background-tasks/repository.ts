import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { type TaskApproval, type TaskStatus, parseApprovals, parseStatus } from './status';

/** La fila de `background_tasks` en la forma que usa el resto del código. */
export interface TaskRecord {
  id: string;
  organizationId: string;
  userId: string;
  conversationId: string | null;
  title: string;
  prompt: string;
  mode: 'new' | 'continue';
  status: TaskStatus;
  segment: number;
  stepsCount: number;
  tokensIn: number;
  tokensOut: number;
  approvals: TaskApproval[];
  result: string | null;
  error: string | null;
  retryOf: string | null;
  cancelRequestedAt: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  deadlineAt: string | null;
  heartbeatAt: string | null;
  updatedAt: string;
}

export const TASK_COLUMNS =
  'id, organization_id, user_id, conversation_id, title, prompt, mode, status, segment, steps_count, tokens_in, tokens_out, pending_approvals, result, error, retry_of, cancel_requested_at, queued_at, started_at, finished_at, deadline_at, heartbeat_at, updated_at';

export function taskFromRow(row: Record<string, unknown>): TaskRecord {
  const str = (k: string) => (typeof row[k] === 'string' ? (row[k] as string) : null);
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    userId: row.user_id as string,
    conversationId: str('conversation_id'),
    title: (row.title as string) ?? '',
    prompt: (row.prompt as string) ?? '',
    mode: row.mode === 'continue' ? 'continue' : 'new',
    status: parseStatus(row.status),
    segment: Number(row.segment ?? 0),
    stepsCount: Number(row.steps_count ?? 0),
    tokensIn: Number(row.tokens_in ?? 0),
    tokensOut: Number(row.tokens_out ?? 0),
    approvals: parseApprovals(row.pending_approvals),
    result: str('result'),
    error: str('error'),
    retryOf: str('retry_of'),
    cancelRequestedAt: str('cancel_requested_at'),
    queuedAt: row.queued_at as string,
    startedAt: str('started_at'),
    finishedAt: str('finished_at'),
    deadlineAt: str('deadline_at'),
    heartbeatAt: str('heartbeat_at'),
    updatedAt: row.updated_at as string,
  };
}

export async function loadTask(db: SupabaseClient, id: string): Promise<TaskRecord | null> {
  const { data, error } = await db
    .from('background_tasks')
    .select(TASK_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`background_tasks read failed: ${error.message}`);
  return data ? taskFromRow(data as Record<string, unknown>) : null;
}

/** El nombre del trabajo en la cola (services/jobs/src/manifest.ts + lib/jobs-registry.ts). */
export const TASK_RUN_JOB = 'tasks/run';
export const TASK_SWEEP_JOB = 'tasks/sweep';

/** Un título corto a partir del pedido: la primera línea, sin relleno. */
export function titleFromPrompt(prompt: string): string {
  const first = prompt.replace(/\s+/g, ' ').trim();
  return first.length > 80 ? `${first.slice(0, 79).trimEnd()}…` : first || 'Tarea';
}
