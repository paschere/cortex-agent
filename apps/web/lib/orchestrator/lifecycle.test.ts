import { beforeEach, describe, expect, it } from 'vitest';
import {
  type LifecycleBuilder,
  type LifecycleDb,
  claimRun,
  heartbeat,
  interruptRun,
  resetHeartbeatThrottle,
  settleUnfinishedTasks,
} from './lifecycle';
import { INTERRUPTED_SUMMARY, STALE_AFTER_MS } from './liveness';

/**
 * A database that behaves like the real one rather than like a Map.
 *
 * Every guard in this module lives in a WHERE clause, so the fake evaluates the
 * filters and writes in ONE synchronous critical section, with the awaits either
 * side of it. An implementation that read a row, went away, and wrote it back
 * would pass a Map-based test and still start the same run twice under two
 * events a millisecond apart — this fake fails it.
 */

interface RunRow {
  id: string;
  organization_id: string;
  status: string;
  claimed_at: string | null;
  last_heartbeat_at: string;
  finished_at: string | null;
  summary: string | null;
  objective: string;
  total_tokens: number;
}

interface TaskRow {
  id: string;
  run_id: string;
  status: string;
  error: string | null;
  finished_at: string | null;
}

interface EventRow {
  run_id: string;
  kind: string;
  payload: Record<string, unknown>;
}

type Filter = [op: 'eq' | 'in' | 'lt' | 'is', column: string, value: unknown];

function makeDb(options: { runs?: Partial<RunRow>[]; tasks?: Partial<TaskRow>[] } = {}) {
  const runs: RunRow[] = (options.runs ?? [{}]).map((r, index) => ({
    id: `run-${index + 1}`,
    organization_id: 'org-1',
    status: 'planning',
    claimed_at: null,
    last_heartbeat_at: new Date().toISOString(),
    finished_at: null,
    summary: null,
    objective: 'Averigua algo importante',
    total_tokens: 0,
    ...r,
  }));
  const tasks: TaskRow[] = (options.tasks ?? []).map((t, index) => ({
    id: `task-${index + 1}`,
    run_id: 'run-1',
    status: 'pending',
    error: null,
    finished_at: null,
    ...t,
  }));
  const events: EventRow[] = [];

  const matches = (row: Record<string, unknown>, filters: Filter[]): boolean =>
    filters.every(([op, column, value]) => {
      const actual = row[column];
      if (op === 'eq') return actual === value;
      if (op === 'in') return (value as unknown[]).includes(actual);
      if (op === 'is') return actual === value;
      // `lt` on the ISO timestamps this module compares.
      return String(actual) < String(value);
    });

  const client: LifecycleDb = {
    from(table: string) {
      const rows: Record<string, unknown>[] =
        table === 'orchestration_runs'
          ? (runs as unknown as Record<string, unknown>[])
          : table === 'orchestration_tasks'
            ? (tasks as unknown as Record<string, unknown>[])
            : [];
      let mode: 'select' | 'update' | 'insert' = 'select';
      let values: Record<string, unknown> = {};
      const filters: Filter[] = [];

      const settle = () => {
        if (mode === 'insert') {
          if (table === 'orchestration_events') {
            events.push({
              run_id: values.run_id as string,
              kind: values.kind as string,
              payload: (values.payload as Record<string, unknown>) ?? {},
            });
          }
          return { data: [values], error: null };
        }
        const hit = rows.filter((row) => matches(row, filters));
        if (mode === 'select') return { data: hit.map((row) => ({ ...row })), error: null };
        // The critical section: match and write with nothing awaited between.
        for (const row of hit) Object.assign(row, values);
        return { data: hit.map((row) => ({ ...row })), error: null };
      };

      const builder: LifecycleBuilder = {
        select() {
          return builder;
        },
        update(next) {
          mode = 'update';
          values = next;
          return builder;
        },
        insert(next) {
          mode = 'insert';
          values = next;
          return builder;
        },
        eq(column, value) {
          filters.push(['eq', column, value]);
          return builder;
        },
        in(column, value) {
          filters.push(['in', column, value]);
          return builder;
        },
        lt(column, value) {
          filters.push(['lt', column, value]);
          return builder;
        },
        is(column, value) {
          filters.push(['is', column, value]);
          return builder;
        },
        maybeSingle() {
          const result = settle();
          const list = result.data as unknown[];
          return Promise.resolve({ data: list[0] ?? null, error: result.error });
        },
        // biome-ignore lint/suspicious/noThenProperty: supabase-js query builders are thenables; the fake must be one to stand in for them.
        then(onFulfilled, onRejected) {
          return Promise.resolve(settle()).then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
  };

  return { client, runs, tasks, events };
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

beforeEach(() => resetHeartbeatThrottle());

describe('claimRun', () => {
  it('claims a fresh run and stamps it', async () => {
    const db = makeDb();
    const result = await claimRun(db.client, 'run-1', '2026-08-04T10:00:00.000Z');

    expect(result.claimed).toBe(true);
    expect(db.runs[0]?.claimed_at).toBe('2026-08-04T10:00:00.000Z');
    expect(db.runs[0]?.last_heartbeat_at).toBe('2026-08-04T10:00:00.000Z');
  });

  it('lets exactly one of two concurrent workers start the same run', async () => {
    const db = makeDb();
    const [a, b] = await Promise.all([claimRun(db.client, 'run-1'), claimRun(db.client, 'run-1')]);

    expect([a, b].filter((r) => r.claimed)).toHaveLength(1);
    const loser = [a, b].find((r) => !r.claimed);
    expect(loser).toMatchObject({ claimed: false, reason: 'already_claimed' });
  });

  it('refuses a run somebody already took', async () => {
    const db = makeDb({ runs: [{ claimed_at: ago(1000) }] });
    expect(await claimRun(db.client, 'run-1')).toMatchObject({
      claimed: false,
      reason: 'already_claimed',
    });
  });

  it('refuses a run that was cancelled before the worker got to it', async () => {
    const db = makeDb({ runs: [{ status: 'cancelled' }] });
    expect(await claimRun(db.client, 'run-1')).toMatchObject({
      claimed: false,
      reason: 'not_live',
    });
  });

  it('reports a missing run rather than throwing', async () => {
    const db = makeDb({ runs: [] });
    expect(await claimRun(db.client, 'nope')).toMatchObject({
      claimed: false,
      reason: 'not_found',
    });
  });
});

describe('heartbeat', () => {
  it('advances the run while it is alive', async () => {
    const db = makeDb({ runs: [{ last_heartbeat_at: ago(STALE_AFTER_MS) }] });
    const now = Date.now();
    await heartbeat(db.client, 'run-1', { now });

    expect(db.runs[0]?.last_heartbeat_at).toBe(new Date(now).toISOString());
  });

  it('throttles, so a tool-happy sub-agent does not double the write volume', async () => {
    const db = makeDb({ runs: [{ last_heartbeat_at: ago(STALE_AFTER_MS) }] });
    const now = Date.now();
    await heartbeat(db.client, 'run-1', { now });
    const first = db.runs[0]?.last_heartbeat_at;
    await heartbeat(db.client, 'run-1', { now: now + 1_000 });

    expect(db.runs[0]?.last_heartbeat_at).toBe(first);
  });

  it('never revives a run that already ended', async () => {
    const db = makeDb({ runs: [{ status: 'interrupted', last_heartbeat_at: ago(60_000) }] });
    const before = db.runs[0]?.last_heartbeat_at;
    await heartbeat(db.client, 'run-1', { force: true });

    expect(db.runs[0]?.last_heartbeat_at).toBe(before);
  });
});

describe('interruptRun', () => {
  it('closes a run that has stopped giving signals', async () => {
    const db = makeDb({
      runs: [{ status: 'running', last_heartbeat_at: ago(4 * 60 * 60_000), total_tokens: 1200 }],
      tasks: [{ status: 'running' }, { status: 'pending' }, { status: 'completed' }],
    });

    expect(await interruptRun(db.client, 'run-1')).toBe(true);
    expect(db.runs[0]?.status).toBe('interrupted');
    expect(db.runs[0]?.finished_at).not.toBeNull();
    expect(db.runs[0]?.summary).toBe(INTERRUPTED_SUMMARY);

    // The manifest stops spinning too: no task is left claiming to be working.
    expect(db.tasks.map((t) => t.status)).toEqual(['failed', 'skipped', 'completed']);

    // And the console hears about it, because the log is what it reads.
    expect(db.events.map((e) => e.kind)).toEqual(['error', 'run_done']);
    expect(db.events[1]?.payload).toMatchObject({ status: 'interrupted', totalTokens: 1200 });
  });

  it('leaves a run that is still beating completely alone', async () => {
    const db = makeDb({
      runs: [{ status: 'running', last_heartbeat_at: ago(30_000) }],
      tasks: [{ status: 'running' }],
    });

    expect(await interruptRun(db.client, 'run-1')).toBe(false);
    expect(db.runs[0]?.status).toBe('running');
    expect(db.tasks[0]?.status).toBe('running');
    expect(db.events).toHaveLength(0);
  });

  it('is idempotent: a second sweep closes nothing and writes no second report', async () => {
    const db = makeDb({
      runs: [{ status: 'running', last_heartbeat_at: ago(STALE_AFTER_MS + 60_000) }],
      tasks: [{ status: 'running' }],
    });

    expect(await interruptRun(db.client, 'run-1')).toBe(true);
    expect(await interruptRun(db.client, 'run-1')).toBe(false);
    expect(db.events).toHaveLength(2);
  });

  it('only one of two sweeps running at once closes the run', async () => {
    const db = makeDb({
      runs: [{ status: 'running', last_heartbeat_at: ago(STALE_AFTER_MS + 60_000) }],
    });
    const [a, b] = await Promise.all([
      interruptRun(db.client, 'run-1'),
      interruptRun(db.client, 'run-1'),
    ]);

    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it('does not touch a run a person cancelled', async () => {
    const db = makeDb({
      runs: [{ status: 'cancelled', last_heartbeat_at: ago(STALE_AFTER_MS + 60_000) }],
    });

    expect(await interruptRun(db.client, 'run-1')).toBe(false);
    expect(db.runs[0]?.status).toBe('cancelled');
  });
});

describe('settleUnfinishedTasks', () => {
  it('says which of the two things happened to each sub-agent', async () => {
    const db = makeDb({ tasks: [{ status: 'running' }, { status: 'pending' }] });
    const settled = await settleUnfinishedTasks(db.client, 'run-1', 'cancelled');

    expect(settled).toBe(2);
    expect(db.tasks[0]?.error).toMatch(/Detuviste la ejecución mientras/);
    expect(db.tasks[1]?.error).toMatch(/antes de que a este subagente le llegara el turno/);
  });

  it('never rewrites a task that finished on its own', async () => {
    const db = makeDb({ tasks: [{ status: 'completed' }, { status: 'failed' }] });
    expect(await settleUnfinishedTasks(db.client, 'run-1', 'interrupted')).toBe(0);
    expect(db.tasks.map((t) => t.error)).toEqual([null, null]);
  });

  it('is scoped to one run', async () => {
    const db = makeDb({
      tasks: [{ status: 'running' }, { status: 'running', run_id: 'run-2' }],
    });
    await settleUnfinishedTasks(db.client, 'run-1', 'interrupted');

    expect(db.tasks[0]?.status).toBe('failed');
    expect(db.tasks[1]?.status).toBe('running');
  });
});
