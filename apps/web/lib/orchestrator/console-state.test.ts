import { describe, expect, it } from 'vitest';
import { type ConsoleState, applyEvent, initialConsoleState } from './console-state';
import type { EventView, RunView, TaskView } from './types';

const run: RunView = {
  id: 'run-1',
  objective: 'Do the thing',
  status: 'running',
  summary: null,
  totalTokens: 0,
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const task: TaskView = {
  id: 'task-1',
  seq: 1,
  title: 'Research',
  instruction: 'Look it up',
  status: 'pending',
  dependsOn: [],
  agentLabel: 'Researcher',
  allowedTools: ['web.search'],
  result: null,
  error: null,
  tokens: 0,
  startedAt: null,
  finishedAt: null,
};

let nextId = 0;
function event(
  kind: EventView['kind'],
  payload: Record<string, unknown>,
  taskId: string | null = null,
): EventView {
  return {
    id: ++nextId,
    kind,
    taskId,
    payload,
    createdAt: '2026-01-01T00:00:10.000Z',
  };
}

function base(): ConsoleState {
  return initialConsoleState(run, [task], []);
}

describe('applyEvent', () => {
  it('ignores events at or behind the cursor, so a replayed window is harmless', () => {
    const state = applyEvent(base(), event('task_start', {}, 'task-1'));
    const replayed = applyEvent(state, {
      ...event('task_done', { status: 'failed' }, 'task-1'),
      id: 1,
    });
    expect(replayed).toBe(state);
  });

  it('tracks a tool call from dispatch to result', () => {
    let state = base();
    state = applyEvent(
      state,
      event('tool_call', { callId: 'c1', toolId: 'web.search', args: '{"q":"x"}' }, 'task-1'),
    );
    expect(state.toolCalls['task-1']?.[0]).toMatchObject({ toolId: 'web.search', ok: null });

    state = applyEvent(
      state,
      event(
        'tool_result',
        { callId: 'c1', ok: true, preview: '3 hits', durationMs: 120 },
        'task-1',
      ),
    );
    expect(state.toolCalls['task-1']?.[0]).toMatchObject({
      ok: true,
      preview: '3 hits',
      durationMs: 120,
    });
    expect(state.toolCalls['task-1']).toHaveLength(1);
  });

  it('marks a failed tool call without dropping it', () => {
    let state = applyEvent(
      base(),
      event('tool_call', { callId: 'c1', toolId: 'web.search', args: '{}' }, 'task-1'),
    );
    state = applyEvent(
      state,
      event('tool_result', { callId: 'c1', ok: false, preview: 'boom' }, 'task-1'),
    );
    expect(state.toolCalls['task-1']?.[0]?.ok).toBe(false);
  });

  it('keeps the streamed text when task_done carries no result', () => {
    let state = applyEvent(base(), event('message', { text: 'the answer' }, 'task-1'));
    state = applyEvent(
      state,
      event('task_done', { status: 'failed', error: 'timed out' }, 'task-1'),
    );
    expect(state.tasks[0]?.result).toBe('the answer');
    expect(state.tasks[0]?.error).toBe('timed out');
    expect(state.tasks[0]?.status).toBe('failed');
  });

  it('does not rewind a task that already started when the plan event arrives late', () => {
    let state = applyEvent(base(), event('task_start', {}, 'task-1'));
    state = applyEvent(state, event('plan', { tasks: [{ ...task, status: 'pending' }] }));
    expect(state.tasks[0]?.status).toBe('running');
  });

  it('separates run-level failures from task-level ones', () => {
    const runLevel = applyEvent(base(), event('error', { message: 'planner died' }));
    expect(runLevel.error).toBe('planner died');
    expect(runLevel.tasks[0]?.error).toBeNull();

    const taskLevel = applyEvent(base(), event('error', { message: 'tool died' }, 'task-1'));
    expect(taskLevel.error).toBeNull();
    expect(taskLevel.tasks[0]?.error).toBe('tool died');
  });

  it('closes the run on run_done', () => {
    const state = applyEvent(
      base(),
      event('run_done', { status: 'completed', summary: '# Report', totalTokens: 4200 }),
    );
    expect(state.run.status).toBe('completed');
    expect(state.run.summary).toBe('# Report');
    expect(state.run.totalTokens).toBe(4200);
    expect(state.run.finishedAt).not.toBeNull();
  });
});
