/**
 * Reading the measurements back.
 *
 * Two things live here and they are different in kind. `percentile` and
 * `summarize` are pure arithmetic over numbers somebody already has — no
 * database, no tenancy, testable in isolation. `loadTurnLatencies` is the one
 * function that touches Postgres, and it does so through the scoped client like
 * everything else, so a caller cannot read another workspace's timings.
 *
 * NEAREST-RANK, NOT INTERPOLATED. p95 here is a turn that really happened, not
 * a weighted average of two that did. With the sample sizes this table sees on
 * a young workspace — dozens, not millions — interpolation invents a latency
 * nobody ever waited through, and the whole point of the number is to name a
 * real bad experience. Reporting a value that occurred is worth the small loss
 * of smoothness.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_SAMPLE_LIMIT, REPORTED_PERCENTILES } from './policy';
import type { StoredTurnLatency, TurnStageKey, TurnStageSample } from './types';

/**
 * The p-th percentile of `values`, by nearest rank.
 *
 * Returns null for an empty sample rather than 0: "no turns were measured" and
 * "every turn was instant" are opposite findings and must not print the same.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] ?? null;
}

/** A distribution, reported the way this subject has to be reported. */
export interface Distribution {
  count: number;
  p50: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

/**
 * Summarise a set of measurements.
 *
 * There is no `mean` field and there will not be one — see REPORTED_PERCENTILES
 * in policy.ts for why.
 */
export function summarize(values: readonly number[]): Distribution {
  const clean = values.filter((v) => Number.isFinite(v));
  const [p50, p90, p95, p99] = REPORTED_PERCENTILES.map((p) => percentile(clean, p));
  return {
    count: clean.length,
    p50: p50 ?? null,
    p90: p90 ?? null,
    p95: p95 ?? null,
    p99: p99 ?? null,
    max: clean.length === 0 ? null : Math.max(...clean),
  };
}

/**
 * How the prompt cache actually behaved, counted per model round-trip.
 *
 * `hitRate` is over STEPS and not over turns, because that is the unit the
 * cache works in: a turn that calls three tools makes four requests, and if the
 * first writes the prefix and the other three read it, the cache is working
 * even though the turn as a whole contains a miss. Counting per turn would
 * report that turn as a miss and understate the saving by a factor of three.
 *
 * `writeSteps` matters as much as `readSteps`. A write costs 1,25× and a read
 * 0,1×, so the cache pays from roughly one hit in three; a workspace with many
 * more writes than reads is paying a premium for nothing, which is a finding
 * worth stating in numbers rather than assuming either way.
 */
export interface CacheBehaviour {
  steps: number;
  readSteps: number;
  writeSteps: number;
  coldSteps: number;
  tokensRead: number;
  tokensWritten: number;
  /** Share of model round-trips that read something from the cache, 0..1. */
  hitRate: number;
}

export function cacheBehaviour(rows: readonly StoredTurnLatency[]): CacheBehaviour {
  let steps = 0;
  let readSteps = 0;
  let writeSteps = 0;
  let coldSteps = 0;
  let tokensRead = 0;
  let tokensWritten = 0;

  for (const row of rows) {
    for (const step of row.cache ?? []) {
      steps += 1;
      tokensRead += step.read;
      tokensWritten += step.written;
      if (step.read > 0) readSteps += 1;
      else if (step.written > 0) writeSteps += 1;
      else coldSteps += 1;
    }
  }

  return {
    steps,
    readSteps,
    writeSteps,
    coldSteps,
    tokensRead,
    tokensWritten,
    hitRate: steps === 0 ? 0 : readSteps / steps,
  };
}

/**
 * Per-stage distributions across a set of turns.
 *
 * A stage that ran twice in one turn (retrieval inside a tool call, say) is
 * summed for that turn before it enters the distribution, so the unit stays
 * "what this stage cost that turn" rather than "what one call to it cost".
 */
export function stageDistributions(
  rows: readonly StoredTurnLatency[],
): Array<{ stage: TurnStageKey } & Distribution> {
  const byStage = new Map<TurnStageKey, number[]>();
  for (const row of rows) {
    const perTurn = new Map<TurnStageKey, number>();
    for (const s of (row.stages ?? []) as TurnStageSample[]) {
      perTurn.set(s.stage, (perTurn.get(s.stage) ?? 0) + s.ms);
    }
    for (const [stage, ms] of perTurn) {
      const bucket = byStage.get(stage) ?? [];
      bucket.push(ms);
      byStage.set(stage, bucket);
    }
  }
  return [...byStage.entries()]
    .map(([stage, values]) => ({ stage, ...summarize(values) }))
    .sort((a, b) => (b.p95 ?? 0) - (a.p95 ?? 0));
}

export interface LoadLatencyOptions {
  /** Only this conversation. Omit for the whole workspace. */
  conversationId?: string;
  /** How far back to look. Default: everything still retained. */
  sinceDays?: number;
  limit?: number;
}

/**
 * The stored measurements for a workspace, newest first.
 *
 * Scoped: `db` must be the org-scoped client, which fills the workspace filter
 * in. Nothing here takes an organization id, so nothing here can be handed the
 * wrong one.
 */
export async function loadTurnLatencies(
  db: SupabaseClient,
  opts: LoadLatencyOptions = {},
): Promise<StoredTurnLatency[]> {
  let query = db
    .from('turn_latencies')
    .select(
      'id, conversation_id, message_id, model, surface, first_visible_ms, first_answer_ms, total_ms, prelude_ms, stages, steps, tool_calls, tool_ms, prompt_tokens, completion_tokens, cache, created_at',
    )
    .order('created_at', { ascending: false })
    .limit(opts.limit ?? DEFAULT_SAMPLE_LIMIT);

  if (opts.conversationId) query = query.eq('conversation_id', opts.conversationId);
  if (opts.sinceDays) {
    query = query.gte(
      'created_at',
      new Date(Date.now() - opts.sinceDays * 86_400_000).toISOString(),
    );
  }

  const { data, error } = await query;
  if (error || !data) return [];

  return data.map((r) => ({
    id: r.id as string,
    conversationId: r.conversation_id as string,
    messageId: (r.message_id as string | null) ?? null,
    createdAt: r.created_at as string,
    model: r.model as string,
    surface: r.surface as string,
    firstVisibleMs: (r.first_visible_ms as number | null) ?? null,
    firstAnswerMs: (r.first_answer_ms as number | null) ?? null,
    totalMs: (r.total_ms as number) ?? 0,
    preludeMs: (r.prelude_ms as number) ?? 0,
    stages: (r.stages ?? []) as StoredTurnLatency['stages'],
    steps: (r.steps as number) ?? 0,
    toolCalls: (r.tool_calls as number) ?? 0,
    toolMs: (r.tool_ms as number) ?? 0,
    promptTokens: (r.prompt_tokens as number | null) ?? null,
    completionTokens: (r.completion_tokens as number | null) ?? null,
    cache: (r.cache ?? []) as StoredTurnLatency['cache'],
  }));
}

/** Everything a latency report needs, from one read. */
export interface LatencyReport {
  turns: number;
  firstVisible: Distribution;
  firstAnswer: Distribution;
  total: Distribution;
  prelude: Distribution;
  stages: Array<{ stage: TurnStageKey } & Distribution>;
  cache: CacheBehaviour;
}

export function report(rows: readonly StoredTurnLatency[]): LatencyReport {
  return {
    turns: rows.length,
    firstVisible: summarize(
      rows.map((r) => r.firstVisibleMs).filter((v): v is number => v !== null),
    ),
    firstAnswer: summarize(rows.map((r) => r.firstAnswerMs).filter((v): v is number => v !== null)),
    total: summarize(rows.map((r) => r.totalMs)),
    prelude: summarize(rows.map((r) => r.preludeMs)),
    stages: stageDistributions(rows),
    cache: cacheBehaviour(rows),
  };
}
