/**
 * The spend ceiling for one run.
 *
 * A coding agent left alone will happily loop until the money runs out, so
 * every run carries a hard budget across three independent axes — wall clock,
 * model turns, and tokens. Exhausting any one of them ends the run with a
 * written explanation instead of a silent stall or an unbounded bill.
 */

export interface DevRunBudget {
  /** Wall-clock ceiling for the whole run, including sandbox startup. */
  maxWallMs: number;
  /** Model turns. One turn is one Claude request plus its tool calls. */
  maxIterations: number;
  /** Cumulative input + output tokens across every turn. */
  maxTokens: number;
}

export interface DevRunSpend {
  startedAtMs: number;
  iterations: number;
  inputTokens: number;
  outputTokens: number;
}

export type BudgetAxis = 'wall_clock' | 'iterations' | 'tokens';

export interface BudgetExhausted {
  axis: BudgetAxis;
  /** Human-readable, written verbatim into `dev_tasks.error`. */
  message: string;
}

/**
 * Defaults sized so a worst-case run costs roughly $12 of model spend plus
 * well under a dollar of sandbox time. Every axis is overridable per
 * deployment via DEV_TASK_MAX_* environment variables.
 */
export const DEFAULT_BUDGET: DevRunBudget = {
  maxWallMs: 30 * 60 * 1000,
  maxIterations: 40,
  maxTokens: 1_500_000,
};

function positiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function budgetFromEnv(env: Record<string, string | undefined>): DevRunBudget {
  return {
    maxWallMs: positiveInt(env.DEV_TASK_MAX_WALL_MS, DEFAULT_BUDGET.maxWallMs),
    maxIterations: positiveInt(env.DEV_TASK_MAX_ITERATIONS, DEFAULT_BUDGET.maxIterations),
    maxTokens: positiveInt(env.DEV_TASK_MAX_TOKENS, DEFAULT_BUDGET.maxTokens),
  };
}

export function emptySpend(startedAtMs: number): DevRunSpend {
  return { startedAtMs, iterations: 0, inputTokens: 0, outputTokens: 0 };
}

export function addTurn(
  spend: DevRunSpend,
  usage: { inputTokens: number; outputTokens: number },
): DevRunSpend {
  return {
    startedAtMs: spend.startedAtMs,
    iterations: spend.iterations + 1,
    inputTokens: spend.inputTokens + usage.inputTokens,
    outputTokens: spend.outputTokens + usage.outputTokens,
  };
}

export function totalTokens(spend: DevRunSpend): number {
  return spend.inputTokens + spend.outputTokens;
}

/**
 * Checked BEFORE each turn, not after, so the run never starts work it cannot
 * pay for. Returns null while there is headroom on all three axes.
 */
export function checkBudget(
  spend: DevRunSpend,
  budget: DevRunBudget,
  nowMs: number,
): BudgetExhausted | null {
  const elapsed = nowMs - spend.startedAtMs;
  if (elapsed >= budget.maxWallMs) {
    return {
      axis: 'wall_clock',
      message: [
        `Run stopped after ${Math.round(elapsed / 1000)}s: it reached the`,
        `${Math.round(budget.maxWallMs / 1000)}s wall-clock budget before finishing.`,
        'No pull request was opened.',
      ].join(' '),
    };
  }
  if (spend.iterations >= budget.maxIterations) {
    return {
      axis: 'iterations',
      message: [
        `Run stopped after ${spend.iterations} model turns, its budgeted maximum.`,
        'The task was not finished, so no pull request was opened.',
      ].join(' '),
    };
  }
  const tokens = totalTokens(spend);
  if (tokens >= budget.maxTokens) {
    return {
      axis: 'tokens',
      message: [
        `Run stopped after spending ${tokens.toLocaleString('en-US')} tokens, its budgeted`,
        'maximum. The task was not finished, so no pull request was opened.',
      ].join(' '),
    };
  }
  return null;
}

/**
 * How much sandbox lifetime to ask for. The sandbox must outlive the
 * orchestrator's wall-clock budget or it will vanish mid-run; a small margin
 * covers startup and the final push.
 */
export function sandboxTimeoutMs(budget: DevRunBudget): number {
  return budget.maxWallMs + 5 * 60 * 1000;
}
