import type { ModelSpend } from './types';

/**
 * What a model call costs, so the comparison in `docs/operations/browser.md` is
 * arithmetic rather than an impression.
 *
 * The rates are Anthropic's published list prices for the model this repo runs
 * on (`UTILITY_MODEL` in model.ts, currently claude-sonnet-5): $3.00 per
 * million input tokens, $15.00 per million output. List rather than the
 * promotional rate in force this month, because a number stored on a row is
 * read next year and a promotion that has ended makes every historical row lie
 * downwards. Real spend during an introductory period is lower than what is
 * recorded here, never higher, which is the direction an estimate should err.
 *
 * A replay does not reach this file at all. That is the point being measured.
 */
export const INPUT_USD_PER_MTOK = 3.0;
export const OUTPUT_USD_PER_MTOK = 15.0;

export function costOf(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * INPUT_USD_PER_MTOK +
    (outputTokens / 1_000_000) * OUTPUT_USD_PER_MTOK
  );
}

export function spendOf(
  usage: { promptTokens?: number; completionTokens?: number } | undefined,
): ModelSpend {
  const inputTokens = usage?.promptTokens ?? 0;
  const outputTokens = usage?.completionTokens ?? 0;
  return { calls: 1, inputTokens, outputTokens, costUsd: costOf(inputTokens, outputTokens) };
}

export function addSpend(a: ModelSpend, b: ModelSpend): ModelSpend {
  return {
    calls: a.calls + b.calls,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    costUsd: a.costUsd + b.costUsd,
  };
}
