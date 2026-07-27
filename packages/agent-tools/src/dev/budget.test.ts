import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUDGET,
  type DevRunBudget,
  addTurn,
  budgetFromEnv,
  checkBudget,
  emptySpend,
  sandboxTimeoutMs,
  totalTokens,
} from './budget';

const T0 = 1_700_000_000_000;

const tight: DevRunBudget = { maxWallMs: 10_000, maxIterations: 3, maxTokens: 1000 };

describe('checkBudget', () => {
  it('allows a fresh run', () => {
    expect(checkBudget(emptySpend(T0), tight, T0)).toBeNull();
  });

  it('allows a run with headroom on every axis', () => {
    const spend = { startedAtMs: T0, iterations: 2, inputTokens: 400, outputTokens: 400 };
    expect(checkBudget(spend, tight, T0 + 9_000)).toBeNull();
  });

  it('stops on wall clock and says how long it ran', () => {
    const exhausted = checkBudget(emptySpend(T0), tight, T0 + 10_000);
    expect(exhausted?.axis).toBe('wall_clock');
    expect(exhausted?.message).toMatch(/10s wall-clock budget/);
    expect(exhausted?.message).toMatch(/No pull request was opened/);
  });

  it('stops on iterations', () => {
    const spend = { startedAtMs: T0, iterations: 3, inputTokens: 0, outputTokens: 0 };
    const exhausted = checkBudget(spend, tight, T0);
    expect(exhausted?.axis).toBe('iterations');
    expect(exhausted?.message).toMatch(/3 model turns/);
  });

  it('stops on tokens, counting input and output together', () => {
    const spend = { startedAtMs: T0, iterations: 1, inputTokens: 600, outputTokens: 400 };
    const exhausted = checkBudget(spend, tight, T0);
    expect(exhausted?.axis).toBe('tokens');
    expect(exhausted?.message).toMatch(/1,000 tokens/);
  });

  it('reports wall clock first when several axes are blown at once', () => {
    const spend = { startedAtMs: T0, iterations: 99, inputTokens: 9999, outputTokens: 9999 };
    expect(checkBudget(spend, tight, T0 + 60_000)?.axis).toBe('wall_clock');
  });

  it('is checked before a turn, so the budget can never be exceeded mid-turn', () => {
    // Simulate the orchestrator loop: check, then spend, then check again.
    let spend = emptySpend(T0);
    let turns = 0;
    while (checkBudget(spend, tight, T0) === null) {
      spend = addTurn(spend, { inputTokens: 100, outputTokens: 100 });
      turns += 1;
      if (turns > 50) throw new Error('loop did not terminate');
    }
    expect(turns).toBe(tight.maxIterations);
    expect(totalTokens(spend)).toBeLessThanOrEqual(tight.maxTokens);
  });
});

describe('addTurn', () => {
  it('accumulates without mutating and preserves the start time', () => {
    const first = emptySpend(T0);
    const second = addTurn(first, { inputTokens: 10, outputTokens: 5 });
    expect(first).toEqual({ startedAtMs: T0, iterations: 0, inputTokens: 0, outputTokens: 0 });
    expect(second).toEqual({ startedAtMs: T0, iterations: 1, inputTokens: 10, outputTokens: 5 });
    expect(addTurn(second, { inputTokens: 1, outputTokens: 1 }).iterations).toBe(2);
  });
});

describe('budgetFromEnv', () => {
  it('falls back to the defaults when nothing is set', () => {
    expect(budgetFromEnv({})).toEqual(DEFAULT_BUDGET);
  });

  it('reads overrides', () => {
    expect(
      budgetFromEnv({
        DEV_TASK_MAX_WALL_MS: '60000',
        DEV_TASK_MAX_ITERATIONS: '5',
        DEV_TASK_MAX_TOKENS: '100',
      }),
    ).toEqual({ maxWallMs: 60_000, maxIterations: 5, maxTokens: 100 });
  });

  it('ignores values that would disable the budget', () => {
    expect(
      budgetFromEnv({
        DEV_TASK_MAX_WALL_MS: '0',
        DEV_TASK_MAX_ITERATIONS: '-1',
        DEV_TASK_MAX_TOKENS: 'unlimited',
      }),
    ).toEqual(DEFAULT_BUDGET);
  });
});

describe('sandboxTimeoutMs', () => {
  it('outlives the orchestrator budget so the sandbox cannot vanish mid-run', () => {
    expect(sandboxTimeoutMs(tight)).toBeGreaterThan(tight.maxWallMs);
  });
});
