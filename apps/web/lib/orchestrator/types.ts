/**
 * Shapes shared by the orchestrator engine, its HTTP surface and the live
 * console. Deliberately free of server-only imports: the browser reducer in
 * app/(app)/orchestrator/[id]/_components imports from here too.
 */

/**
 * `interrupted` is the fourth ending, added by migration 0070: the run stopped
 * signalling and nobody knows how it ended. It is deliberately not folded into
 * `failed` (which blames the work for an infrastructure death) or `cancelled`
 * (which blames the person). See lib/orchestrator/liveness.ts.
 */
export type RunStatus =
  | 'planning'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export type EventKind =
  | 'plan'
  | 'task_start'
  | 'tool_call'
  | 'tool_result'
  | 'message'
  | 'task_done'
  | 'error'
  | 'run_done';

/** A run is done when nothing else will ever be appended to its event log. */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  'completed',
  'failed',
  'cancelled',
  'interrupted',
];

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

export interface RunView {
  id: string;
  objective: string;
  status: RunStatus;
  summary: string | null;
  totalTokens: number;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  /**
   * Last moment the run was observably alive (migration 0070). The screen reads
   * it to avoid claiming "ejecutando" over something that stopped talking —
   * see lib/orchestrator/liveness.ts.
   */
  lastHeartbeatAt: string | null;
}

export interface TaskView {
  id: string;
  seq: number;
  title: string;
  instruction: string;
  status: TaskStatus;
  dependsOn: number[];
  agentLabel: string | null;
  allowedTools: string[];
  result: string | null;
  error: string | null;
  tokens: number;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface EventView {
  id: number;
  kind: EventKind;
  taskId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

/** `tool_call` payload — what the sub-agent asked a tool to do. */
export interface ToolCallPayload {
  callId: string;
  toolId: string;
  /** Arguments, JSON-stringified and capped. Never the raw object: a single
   *  document-fetch argument can be megabytes. */
  args: string;
}

/** `tool_result` payload — how that call ended. */
export interface ToolResultPayload {
  callId: string;
  toolId: string;
  ok: boolean;
  /** Capped preview of the result (or the error message when `ok` is false). */
  preview: string;
  durationMs: number;
}

export const RUN_COLUMNS =
  'id, organization_id, user_id, objective, status, plan, summary, total_tokens, started_at, finished_at, created_at, last_heartbeat_at';

export const TASK_COLUMNS =
  'id, run_id, seq, title, instruction, status, depends_on, agent_label, allowed_tools, result, error, tokens, started_at, finished_at';

export function toRunView(row: Record<string, unknown>): RunView {
  return {
    id: row.id as string,
    objective: row.objective as string,
    status: row.status as RunStatus,
    summary: (row.summary as string | null) ?? null,
    totalTokens: (row.total_tokens as number | null) ?? 0,
    startedAt: (row.started_at as string | null) ?? null,
    finishedAt: (row.finished_at as string | null) ?? null,
    createdAt: row.created_at as string,
    lastHeartbeatAt: (row.last_heartbeat_at as string | null) ?? null,
  };
}

export function toTaskView(row: Record<string, unknown>): TaskView {
  return {
    id: row.id as string,
    seq: row.seq as number,
    title: row.title as string,
    instruction: (row.instruction as string | null) ?? '',
    status: row.status as TaskStatus,
    dependsOn: ((row.depends_on as number[] | null) ?? []).filter((n) => Number.isInteger(n)),
    agentLabel: (row.agent_label as string | null) ?? null,
    allowedTools: (row.allowed_tools as string[] | null) ?? [],
    result: (row.result as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    tokens: (row.tokens as number | null) ?? 0,
    startedAt: (row.started_at as string | null) ?? null,
    finishedAt: (row.finished_at as string | null) ?? null,
  };
}

export function toEventView(row: Record<string, unknown>): EventView {
  return {
    id: Number(row.id),
    kind: row.kind as EventKind,
    taskId: (row.task_id as string | null) ?? null,
    payload: (row.payload as Record<string, unknown> | null) ?? {},
    createdAt: row.created_at as string,
  };
}
