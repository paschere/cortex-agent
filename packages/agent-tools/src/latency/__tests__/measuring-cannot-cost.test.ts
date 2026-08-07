import { describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from '../../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../tenancy/scoped-client';
import { TurnClock } from '../clock';

/**
 * THE PROPERTY THIS MODULE STANDS OR FALLS ON.
 *
 * Instrumenting a slow product is only defensible if the instrument is free.
 * The failure mode is specific and easy to reach: one `await` on an insert in
 * the wrong place, and every answer in the product pays a database round-trip
 * to record that answers are expensive. It would also be nearly invisible —
 * the numbers would still look plausible, just uniformly worse, and the
 * measurement would be measuring itself.
 *
 * So these tests do not check that the durations are correct. They check that
 * the clock cannot reach the database until the turn is over, that timing a
 * promise does not change what the promise does, and that a failed write is
 * swallowed rather than surfacing on a turn that already succeeded.
 */

const ORG = 'org-acme';

function scoped(rows: Record<string, Record<string, unknown>[]> = {}) {
  const fake = createFakeSupabase({ turn_latencies: [], ...rows });
  return { fake, db: createOrgScopedClient(fake.client, ORG) };
}

function clock(startedAt?: number) {
  return new TurnClock({
    organizationId: ORG,
    conversationId: 'conv-1',
    userId: 'user-1',
    agentId: 'agent-1',
    model: 'claude-sonnet-5',
    startedAt,
  });
}

describe('the clock cannot slow the turn down', () => {
  it('touches no database until save, however much is recorded', async () => {
    const { fake, db } = scoped();
    const c = clock();

    c.setup();
    await c.span('retrieval', Promise.resolve('hits'));
    const close = c.open('selection');
    close();
    c.handedToModel();
    c.visible('reasoning');
    c.visible('answer');
    c.toolFinished(120);
    c.modelStep({ promptTokens: 10 }, { anthropic: { cacheReadInputTokens: 5 } });
    c.finished({ promptTokens: 10, completionTokens: 4 });

    // Everything above is the whole life of a turn. Nothing has been written.
    expect(fake.tables.turn_latencies).toHaveLength(0);

    await c.save(db, { messageId: null });
    expect(fake.tables.turn_latencies).toHaveLength(1);
  });

  it('returns the timed promise untouched, value and rejection alike', async () => {
    const c = clock();
    const sentinel = { rows: [1, 2, 3] };
    await expect(c.span('retrieval', Promise.resolve(sentinel))).resolves.toBe(sentinel);

    const boom = new Error('voyage is down');
    await expect(c.span('selection', Promise.reject(boom))).rejects.toBe(boom);

    // A stage that failed is still a fact about the turn — a retrieval that
    // timed out is precisely the turn worth finding — so both were recorded.
    const stages = c.snapshot().stages.map((s) => s.stage);
    expect(stages).toContain('retrieval');
    expect(stages).toContain('selection');
  });

  it('never lets a failed write reach a turn that already succeeded', async () => {
    const { db } = scoped();
    const c = clock();
    c.finished();

    // The table exists for the tenancy client but the write itself explodes —
    // a lagging migration, a lock, a column that is not there yet.
    const exploding = {
      from: () => ({
        insert: () => {
          throw new Error('relation "turn_latencies" does not exist');
        },
      }),
    } as unknown as typeof db;

    await expect(c.save(exploding, { messageId: null })).resolves.toBeUndefined();
  });
});

describe('what the clock reports', () => {
  it('separates the first visible character from the first character of the answer', () => {
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValue(1000);
    const c = clock(1000);

    now.mockReturnValue(1200);
    c.handedToModel();
    now.mockReturnValue(3200);
    c.visible('reasoning'); // the reasoning trail starts
    now.mockReturnValue(9400);
    c.visible('answer'); // the answer itself, six seconds later
    now.mockReturnValue(15000);
    c.finished();

    const m = c.snapshot();
    expect(m.firstVisibleMs).toBe(2200);
    expect(m.firstAnswerMs).toBe(8400);
    expect(m.preludeMs).toBe(200);
    expect(m.totalMs).toBe(14000);
    now.mockRestore();
  });

  it('records when a stage started, so concurrent stages do not read as sequential', async () => {
    const c = clock();
    // Two stages opened at the same moment and awaited together — which is what
    // the chat route does with retrieval and tool selection.
    const a = c.open('retrieval');
    const b = c.open('selection');
    await Promise.all([Promise.resolve(), Promise.resolve()]);
    a();
    b();

    const stages = c.snapshot().stages;
    const retrieval = stages.find((s) => s.stage === 'retrieval');
    const selection = stages.find((s) => s.stage === 'selection');
    // Same start offset is the signature of work that really ran at once. If
    // this ever reads as "selection began where retrieval ended", the two have
    // silently gone back to being sequential.
    expect(retrieval?.at).toBe(selection?.at);
  });

  it('keeps one cache entry per model round-trip rather than one per turn', () => {
    const c = clock();
    // A tool-calling turn: the first request writes the prefix, the next two
    // read it. Folding these into one figure would report the turn as a miss.
    c.modelStep({ promptTokens: 300 }, { anthropic: { cacheCreationInputTokens: 49_000 } });
    c.modelStep({ promptTokens: 120 }, { anthropic: { cacheReadInputTokens: 49_000 } });
    c.modelStep({ promptTokens: 140 }, { anthropic: { cacheReadInputTokens: 49_000 } });
    c.finished();

    const m = c.snapshot();
    expect(m.steps).toBe(3);
    expect(m.cache.map((s) => s.read > 0)).toEqual([false, true, true]);
    expect(m.cache[0]?.written).toBe(49_000);
  });

  it('reads provider metadata defensively — an absent bag is not a crash', () => {
    const c = clock();
    c.modelStep(undefined, undefined);
    c.modelStep({ promptTokens: 5 }, { openai: { somethingElse: 1 } });
    expect(c.snapshot().cache).toEqual([
      { read: 0, written: 0, promptTokens: 0 },
      { read: 0, written: 0, promptTokens: 5 },
    ]);
  });

  it('counts a tool that failed, because the turn waited for it either way', () => {
    const c = clock();
    c.toolFinished(11_000);
    c.toolFinished(400);
    c.finished();
    const m = c.snapshot();
    expect(m.toolCalls).toBe(2);
    expect(m.toolMs).toBe(11_400);
  });
});
