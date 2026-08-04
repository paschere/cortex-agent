import type { EventView, RunStatus, RunView, TaskStatus, TaskView } from './types';

/**
 * The live console's state machine.
 *
 * The browser never re-fetches the run: it folds the append-only event log into
 * a view model, exactly once per event. Keeping that fold here — pure, and
 * outside React — is what makes it testable, and what lets the same function
 * replay the log the server already rendered and then keep going with the
 * events arriving over SSE.
 *
 * Events are idempotent by id: a reconnect that replays a window is harmless.
 */

export interface ToolCallEntry {
  callId: string;
  toolId: string;
  args: string;
  /** Null while the call is still in flight. */
  ok: boolean | null;
  preview: string | null;
  durationMs: number | null;
}

export interface ConsoleState {
  run: RunView;
  tasks: TaskView[];
  /** Tool calls per task id, in the order they were made. */
  toolCalls: Record<string, ToolCallEntry[]>;
  /** A run-level failure, i.e. one that happened outside any single task. */
  error: string | null;
  lastEventId: number;
}

function asString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' ? value : null;
}

function asNumber(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function taskFromPayload(raw: unknown): TaskView | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.id !== 'string' || typeof t.seq !== 'number') return null;
  return {
    id: t.id,
    seq: t.seq,
    title: typeof t.title === 'string' ? t.title : `Task ${t.seq}`,
    instruction: typeof t.instruction === 'string' ? t.instruction : '',
    status: (typeof t.status === 'string' ? t.status : 'pending') as TaskStatus,
    dependsOn: Array.isArray(t.dependsOn) ? (t.dependsOn as number[]).filter(Number.isInteger) : [],
    agentLabel: typeof t.agentLabel === 'string' ? t.agentLabel : null,
    allowedTools: Array.isArray(t.allowedTools) ? (t.allowedTools as string[]) : [],
    result: typeof t.result === 'string' ? t.result : null,
    error: typeof t.error === 'string' ? t.error : null,
    tokens: typeof t.tokens === 'number' ? t.tokens : 0,
    startedAt: typeof t.startedAt === 'string' ? t.startedAt : null,
    finishedAt: typeof t.finishedAt === 'string' ? t.finishedAt : null,
  };
}

function patchTask(
  state: ConsoleState,
  taskId: string | null,
  patch: Partial<TaskView>,
): TaskView[] {
  if (!taskId) return state.tasks;
  return state.tasks.map((t) => (t.id === taskId ? { ...t, ...patch } : t));
}

export function initialConsoleState(
  run: RunView,
  tasks: TaskView[],
  events: EventView[],
): ConsoleState {
  const base: ConsoleState = { run, tasks, toolCalls: {}, error: null, lastEventId: 0 };
  return events.reduce(applyEvent, base);
}

export function applyEvent(state: ConsoleState, event: EventView): ConsoleState {
  // Replayed window after a reconnect, or an out-of-order delivery.
  if (event.id <= state.lastEventId) return state;
  const next: ConsoleState = { ...state, lastEventId: event.id };
  const payload = event.payload ?? {};
  const taskId = event.taskId ?? asString(payload, 'taskId');

  switch (event.kind) {
    case 'plan': {
      const planned = Array.isArray(payload.tasks)
        ? (payload.tasks as unknown[]).map(taskFromPayload).filter((t): t is TaskView => t !== null)
        : [];
      if (planned.length === 0) return next;
      // Merged rather than replaced: the plan event can arrive after a task has
      // already started (server render, then SSE from an earlier cursor), and
      // resetting everything to "pending" would make the console flicker
      // backwards.
      const known = new Map(state.tasks.map((t) => [t.id, t]));
      next.tasks = planned.map((t) => ({ ...t, ...(known.get(t.id) ?? {}) }));
      return next;
    }

    case 'task_start': {
      const allowedTools = Array.isArray(payload.allowedTools)
        ? (payload.allowedTools as string[])
        : undefined;
      next.tasks = patchTask(next, taskId, {
        status: 'running',
        startedAt: asString(payload, 'startedAt') ?? new Date(event.createdAt).toISOString(),
        ...(allowedTools ? { allowedTools } : {}),
      });
      return next;
    }

    case 'tool_call': {
      const callId = asString(payload, 'callId');
      const toolId = asString(payload, 'toolId');
      if (!taskId || !callId || !toolId) return next;
      const existing = next.toolCalls[taskId] ?? [];
      if (existing.some((c) => c.callId === callId)) return next;
      next.toolCalls = {
        ...next.toolCalls,
        [taskId]: [
          ...existing,
          {
            callId,
            toolId,
            args: asString(payload, 'args') ?? '',
            ok: null,
            preview: null,
            durationMs: null,
          },
        ],
      };
      return next;
    }

    case 'tool_result': {
      const callId = asString(payload, 'callId');
      if (!taskId || !callId) return next;
      const existing = next.toolCalls[taskId] ?? [];
      next.toolCalls = {
        ...next.toolCalls,
        [taskId]: existing.map((c) =>
          c.callId === callId
            ? {
                ...c,
                ok: payload.ok !== false,
                preview: asString(payload, 'preview'),
                durationMs: asNumber(payload, 'durationMs'),
              }
            : c,
        ),
      };
      return next;
    }

    case 'message': {
      const text = asString(payload, 'text');
      if (text) next.tasks = patchTask(next, taskId, { result: text });
      return next;
    }

    case 'task_done': {
      // Built key by key: a spread carrying `result: undefined` would wipe the
      // text the preceding `message` event already put on screen, because
      // `{...task, result: undefined}` still writes the key.
      const patch: Partial<TaskView> = {
        status: (asString(payload, 'status') ?? 'completed') as TaskStatus,
        finishedAt: asString(payload, 'finishedAt') ?? new Date(event.createdAt).toISOString(),
      };
      const result = asString(payload, 'result');
      if (result !== null) patch.result = result;
      const error = asString(payload, 'error');
      if (error !== null) patch.error = error;
      const tokens = asNumber(payload, 'tokens');
      if (tokens !== null) patch.tokens = tokens;
      next.tasks = patchTask(next, taskId, patch);
      return next;
    }

    case 'error': {
      const message = asString(payload, 'message') ?? 'Something went wrong.';
      if (taskId) next.tasks = patchTask(next, taskId, { error: message });
      else next.error = message;
      return next;
    }

    case 'run_done': {
      next.run = {
        ...next.run,
        status: (asString(payload, 'status') ?? 'completed') as RunStatus,
        summary: asString(payload, 'summary') ?? next.run.summary,
        totalTokens: asNumber(payload, 'totalTokens') ?? next.run.totalTokens,
        finishedAt: next.run.finishedAt ?? new Date(event.createdAt).toISOString(),
      };
      return next;
    }

    default:
      return next;
  }
}
