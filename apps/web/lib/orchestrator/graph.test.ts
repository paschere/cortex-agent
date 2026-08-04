import { describe, expect, it } from 'vitest';
import { computeWaves, mapWithConcurrency, nextBatch, normalizeDependencies } from './graph';
import type { TaskStatus } from './types';

describe('normalizeDependencies', () => {
  it('keeps edges that point backwards', () => {
    expect(normalizeDependencies([[], [1], [1, 2]])).toEqual([[], [1], [1, 2]]);
  });

  it('drops forward edges, self-references and unknown seqs', () => {
    // Task 1 pointing at 2 would be a cycle; 2 pointing at itself a deadlock;
    // 3 pointing at 9 an edge to a task that does not exist.
    expect(normalizeDependencies([[2], [2], [9]])).toEqual([[], [], []]);
  });

  it('de-duplicates and sorts', () => {
    expect(normalizeDependencies([[], [], [2, 1, 2]])).toEqual([[], [], [1, 2]]);
  });
});

describe('computeWaves', () => {
  it('puts independent tasks in the same wave', () => {
    const waves = computeWaves([
      { seq: 1, dependsOn: [] },
      { seq: 2, dependsOn: [] },
      { seq: 3, dependsOn: [1, 2] },
    ]);
    expect(waves.get(1)).toBe(1);
    expect(waves.get(2)).toBe(1);
    expect(waves.get(3)).toBe(2);
  });

  it('follows the longest path, not the shortest', () => {
    const waves = computeWaves([
      { seq: 1, dependsOn: [] },
      { seq: 2, dependsOn: [1] },
      { seq: 3, dependsOn: [1, 2] },
    ]);
    expect(waves.get(3)).toBe(3);
  });
});

describe('nextBatch', () => {
  const nodes = [
    { seq: 1, dependsOn: [] },
    { seq: 2, dependsOn: [] },
    { seq: 3, dependsOn: [1] },
    { seq: 4, dependsOn: [3] },
  ];

  it('offers every root at once so they can run in parallel', () => {
    expect(nextBatch(nodes, new Map())).toEqual({ ready: [1, 2], skip: [] });
  });

  it('waits for a dependency that is still running', () => {
    const states = new Map<number, TaskStatus>([
      [1, 'running'],
      [2, 'completed'],
    ]);
    expect(nextBatch(nodes, states)).toEqual({ ready: [], skip: [] });
  });

  it('retires the direct dependants of a failed task, one level per call', () => {
    const states = new Map<number, TaskStatus>([
      [1, 'failed'],
      [2, 'completed'],
    ]);
    const first = nextBatch(nodes, states);
    expect(first).toEqual({ ready: [], skip: [3] });

    // The cascade is what keeps the run alive: 4 only becomes unreachable once
    // the caller has applied the skip on 3.
    states.set(3, 'skipped');
    expect(nextBatch(nodes, states)).toEqual({ ready: [], skip: [4] });
  });

  it('keeps viable branches moving while another branch dies', () => {
    const branchy = [
      { seq: 1, dependsOn: [] },
      { seq: 2, dependsOn: [1] },
      { seq: 3, dependsOn: [] },
    ];
    const states = new Map<number, TaskStatus>([[1, 'failed']]);
    expect(nextBatch(branchy, states)).toEqual({ ready: [3], skip: [2] });
  });

  it('ignores edges to tasks that are not in the graph rather than stalling', () => {
    expect(nextBatch([{ seq: 1, dependsOn: [7] }], new Map())).toEqual({ ready: [1], skip: [] });
  });
});

describe('mapWithConcurrency', () => {
  it('never exceeds the limit and preserves input order', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n * 2;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
  });

  it('handles an empty list', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });
});
