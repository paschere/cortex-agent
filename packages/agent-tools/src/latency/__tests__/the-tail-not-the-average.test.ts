import { describe, expect, it } from 'vitest';
import { cacheBehaviour, percentile, report, stageDistributions, summarize } from '../read';
import type { StoredTurnLatency } from '../types';

/**
 * What ruins the experience is the nineteen-second turn, not the median one.
 *
 * These tests exist because the natural thing to reach for when asked "how fast
 * is it?" is an average, and an average is the one statistic that reliably
 * hides the answer. So they pin the arithmetic that replaces it: nearest-rank
 * percentiles over turns that really happened, a distribution that refuses to
 * pretend an empty sample is a fast one, and a cache hit rate counted in the
 * unit the cache actually works in.
 */

function turn(over: Partial<StoredTurnLatency> = {}): StoredTurnLatency {
  return {
    id: 'x',
    conversationId: 'c',
    messageId: null,
    createdAt: '2026-01-01T00:00:00Z',
    model: 'claude-sonnet-5',
    surface: 'web',
    firstVisibleMs: 1000,
    firstAnswerMs: 1200,
    totalMs: 5000,
    preludeMs: 300,
    stages: [],
    steps: 1,
    toolCalls: 0,
    toolMs: 0,
    promptTokens: 100,
    completionTokens: 50,
    cache: [],
    ...over,
  };
}

describe('percentiles name a turn that really happened', () => {
  it('is nearest-rank, so it never invents a latency nobody waited through', () => {
    // Interpolation would answer 1500 for p50 here. Nobody waited 1500 ms.
    expect(percentile([1000, 2000], 50)).toBe(1000);
    expect(percentile([1000, 2000], 100)).toBe(2000);
    expect(percentile([100, 200, 300, 400, 19_000], 95)).toBe(19_000);
  });

  it('distinguishes "nothing was measured" from "everything was instant"', () => {
    expect(percentile([], 95)).toBeNull();
    const empty = summarize([]);
    expect(empty.count).toBe(0);
    expect(empty.p95).toBeNull();
    expect(empty.max).toBeNull();
  });

  it('lets a bad turn show up where an average would bury it', () => {
    // One turn in fifty is catastrophic. The mean is ~1 164 ms, which reads as
    // a perfectly healthy product and is the reason the mean is not reported.
    const d = summarize([...Array.from({ length: 49 }, () => 800), 19_000]);
    expect(d.p50).toBe(800);
    expect(d.p99).toBe(19_000);
  });

  it('reports max as well as p99, because p99 can still miss the outlier', () => {
    // Exactly one turn in a hundred: nearest-rank p99 is the 99th smallest,
    // which is a fast one. The bad turn is real and somebody sat through it, so
    // `max` is reported alongside — a distribution with no ceiling on it is how
    // a tail gets argued away.
    const d = summarize([...Array.from({ length: 99 }, () => 800), 19_000]);
    expect(d.p99).toBe(800);
    expect(d.max).toBe(19_000);
  });

  it('reports no mean, and there is no field for one', () => {
    expect(Object.keys(summarize([1, 2, 3]))).toEqual(['count', 'p50', 'p90', 'p95', 'p99', 'max']);
  });
});

describe('stages', () => {
  it('sums a stage that ran twice in one turn before it enters the distribution', () => {
    const rows = [
      turn({
        stages: [
          { stage: 'retrieval', at: 0, ms: 300 },
          { stage: 'retrieval', at: 900, ms: 200 },
        ],
      }),
    ];
    const [retrieval] = stageDistributions(rows);
    // 500, not two samples of 300 and 200 — the unit is "what this stage cost
    // that turn", which is the question anybody asks of it.
    expect(retrieval?.p50).toBe(500);
    expect(retrieval?.count).toBe(1);
  });

  it('orders stages by their tail, because that is the one worth looking at', () => {
    const rows = [
      turn({
        stages: [
          { stage: 'setup', at: 0, ms: 50 },
          { stage: 'model', at: 50, ms: 4000 },
          { stage: 'retrieval', at: 50, ms: 600 },
        ],
      }),
    ];
    expect(stageDistributions(rows).map((s) => s.stage)).toEqual(['model', 'retrieval', 'setup']);
  });
});

describe('the prompt cache, counted per model round-trip', () => {
  it('does not report a tool-calling turn as a miss because its first step wrote', () => {
    const rows = [
      turn({
        steps: 3,
        cache: [
          { read: 0, written: 49_000, promptTokens: 300 },
          { read: 49_000, written: 0, promptTokens: 120 },
          { read: 49_000, written: 0, promptTokens: 140 },
        ],
      }),
    ];
    const c = cacheBehaviour(rows);
    expect(c.steps).toBe(3);
    expect(c.readSteps).toBe(2);
    expect(c.writeSteps).toBe(1);
    // Two hits in three. Counted per turn this would have been zero in one.
    expect(c.hitRate).toBeCloseTo(2 / 3);
    expect(c.tokensRead).toBe(98_000);
  });

  it('separates a step that wrote from a step that did neither', () => {
    const c = cacheBehaviour([
      turn({ cache: [{ read: 0, written: 0, promptTokens: 40 }] }),
      turn({ cache: [{ read: 0, written: 5000, promptTokens: 40 }] }),
    ]);
    expect(c.coldSteps).toBe(1);
    expect(c.writeSteps).toBe(1);
    expect(c.hitRate).toBe(0);
  });

  it('an empty sample has a hit rate of zero and says so without dividing by it', () => {
    expect(cacheBehaviour([]).hitRate).toBe(0);
  });
});

describe('the whole report', () => {
  it('drops turns that produced nothing visible rather than scoring them as zero', () => {
    const r = report([
      turn({ firstVisibleMs: 900, firstAnswerMs: null }),
      turn({ firstVisibleMs: null, firstAnswerMs: null, totalMs: 30_000 }),
    ]);
    expect(r.turns).toBe(2);
    expect(r.firstVisible.count).toBe(1);
    expect(r.firstAnswer.count).toBe(0);
    // The turn that showed nothing still counts in the total, which is where a
    // request that hung for thirty seconds belongs.
    expect(r.total.count).toBe(2);
    expect(r.total.max).toBe(30_000);
  });
});
