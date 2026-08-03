import { describe, expect, it } from 'vitest';
import { type ClaimDbClient, type ClaimQueryBuilder, claimDevTask } from './claim';
import type { DevTask } from './types';

function makeTask(overrides: Partial<DevTask> = {}): DevTask {
  return {
    id: 'task-1',
    external_id: 'linear-uuid',
    external_identifier: 'ENG-1',
    external_url: null,
    title: 'Do the thing',
    description: null,
    repository_id: 'repo-1',
    repository_key: 'cortex-agent',
    requester_name: null,
    requester_email: null,
    status: 'queued',
    attempt_count: 0,
    max_attempts: 3,
    ...overrides,
  };
}

interface RecordedUpdate {
  values: Record<string, unknown>;
  filters: Array<[string, unknown]>;
}

/**
 * A Supabase stub with one row and real compare-and-set semantics: the update
 * only lands if every `.eq()` filter still matches the stored row. That is the
 * behaviour the guard depends on, so the stub has to model it faithfully rather
 * than just recording calls.
 */
function makeDb(initial: DevTask | null) {
  let row: DevTask | null = initial ? { ...initial } : null;
  const updates: RecordedUpdate[] = [];

  const client: ClaimDbClient = {
    from(table: string) {
      if (table !== 'dev_tasks') throw new Error(`unexpected table ${table}`);
      let mode: 'select' | 'update' = 'select';
      let values: Record<string, unknown> = {};
      const filters: Array<[string, unknown]> = [];

      const matches = (candidate: DevTask | null): candidate is DevTask =>
        candidate !== null &&
        filters.every(
          ([col, val]) => (candidate as unknown as Record<string, unknown>)[col] === val,
        );

      const settle = () => {
        if (mode === 'select') {
          return { data: matches(row) ? [{ ...(row as DevTask) }] : [], error: null };
        }
        updates.push({ values, filters: [...filters] });
        if (!matches(row)) return { data: [], error: null };
        row = { ...(row as DevTask), ...(values as Partial<DevTask>) };
        return { data: [{ ...row }], error: null };
      };

      const builder: ClaimQueryBuilder = {
        select() {
          return builder;
        },
        update(next) {
          mode = 'update';
          values = next;
          return builder;
        },
        eq(column, value) {
          filters.push([column, value]);
          return builder;
        },
        maybeSingle() {
          const result = settle();
          const rows = result.data as unknown[];
          return Promise.resolve({ data: rows[0] ?? null, error: result.error });
        },
        // biome-ignore lint/suspicious/noThenProperty: supabase-js query builders are thenables; the stub must be one to stand in for them.
        then(onFulfilled, onRejected) {
          return Promise.resolve(settle()).then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
  };

  return { client, updates, current: () => row };
}

describe('claimDevTask', () => {
  it('claims a queued task and moves it to running', async () => {
    const db = makeDb(makeTask());
    const result = await claimDevTask(db.client, 'task-1', '2026-07-27T00:00:00.000Z');

    expect(result.claimed).toBe(true);
    if (!result.claimed) throw new Error('unreachable');
    expect(result.task.status).toBe('running');
    expect(result.task.attempt_count).toBe(1);
    expect(db.current()?.status).toBe('running');
  });

  it('guards the write on both status and attempt_count', async () => {
    const db = makeDb(makeTask());
    await claimDevTask(db.client, 'task-1');

    const update = db.updates[0];
    expect(update?.filters).toEqual([
      ['id', 'task-1'],
      ['status', 'queued'],
      ['attempt_count', 0],
    ]);
    expect(update?.values.status).toBe('running');
    expect(update?.values.attempt_count).toBe(1);
  });

  it('lets exactly one of two concurrent workers win', async () => {
    const db = makeDb(makeTask());
    const [a, b] = await Promise.all([
      claimDevTask(db.client, 'task-1'),
      claimDevTask(db.client, 'task-1'),
    ]);

    const winners = [a, b].filter((r) => r.claimed);
    expect(winners).toHaveLength(1);
    expect(db.current()?.attempt_count).toBe(1);
  });

  it('refuses a task another worker is already running', async () => {
    const db = makeDb(makeTask({ status: 'running', attempt_count: 1 }));
    const result = await claimDevTask(db.client, 'task-1');

    expect(result).toMatchObject({ claimed: false, reason: 'not_claimable' });
    expect(db.updates).toHaveLength(0);
  });

  it('refuses a task that already finished', async () => {
    const db = makeDb(makeTask({ status: 'done' }));
    expect(await claimDevTask(db.client, 'task-1')).toMatchObject({
      claimed: false,
      reason: 'not_claimable',
    });
  });

  it('refuses to burn the last attempt twice', async () => {
    const db = makeDb(makeTask({ attempt_count: 3, max_attempts: 3 }));
    const result = await claimDevTask(db.client, 'task-1');

    expect(result).toMatchObject({ claimed: false, reason: 'attempts_exhausted' });
    expect(db.updates).toHaveLength(0);
  });

  it('allows the final permitted attempt', async () => {
    const db = makeDb(makeTask({ attempt_count: 2, max_attempts: 3 }));
    const result = await claimDevTask(db.client, 'task-1');

    expect(result.claimed).toBe(true);
    if (!result.claimed) throw new Error('unreachable');
    expect(result.task.attempt_count).toBe(3);
  });

  it('reports a missing task rather than throwing', async () => {
    const db = makeDb(null);
    expect(await claimDevTask(db.client, 'task-1')).toMatchObject({
      claimed: false,
      reason: 'not_found',
      task: null,
    });
  });

  it('surfaces a database error instead of silently not claiming', async () => {
    const client: ClaimDbClient = {
      from() {
        const builder = {
          select: () => builder,
          update: () => builder,
          eq: () => builder,
          maybeSingle: () => Promise.resolve({ data: null, error: { message: 'boom' } }),
          // biome-ignore lint/suspicious/noThenProperty: see above.
          then: (onFulfilled: never) =>
            Promise.resolve({ data: null, error: { message: 'boom' } }).then(onFulfilled),
        } as unknown as ClaimQueryBuilder;
        return builder;
      },
    };
    await expect(claimDevTask(client, 'task-1')).rejects.toThrow(/boom/);
  });
});
