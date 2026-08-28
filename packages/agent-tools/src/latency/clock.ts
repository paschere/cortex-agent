/**
 * The stopwatch a turn carries.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE: MEASURING MAY NOT COST ANYTHING
 * ---------------------------------------------------------------------------
 * It would be a particular kind of failure to slow a turn down while finding
 * out why turns are slow, and it is an easy one to commit — one `await` on an
 * insert, in the wrong place, and every answer in the product pays a database
 * round-trip to record that answers are expensive.
 *
 * So everything here is `performance.now()` and an array push. No I/O, nothing
 * awaited, no allocation that scales with the size of the turn. The single
 * write happens in `save`, called from the stream's `onFinish`, after the last
 * token has already reached the person. If that write is slow nobody is
 * waiting; if it throws it is swallowed, because a measurement is never worth
 * an answer.
 *
 * This is the same contract `TurnContextRecorder` is built on, deliberately:
 * the two objects ride the same turn and would be dangerous if only one of them
 * were free.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS TOLD RATHER THAN ASKED
 * ---------------------------------------------------------------------------
 * The clock never wraps anything it was not handed. `span` takes a promise the
 * caller was going to await anyway and returns it untouched — it cannot change
 * concurrency, cannot swallow a rejection, and cannot reorder work. That
 * matters because the whole point of this exercise is to move work around, and
 * an instrument that participates in the scheduling would be measuring itself.
 */

import type { Logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { LATENCY_KEEP_DAYS } from './policy';
import type { TurnCacheStep, TurnLatency, TurnStageKey, TurnStageSample } from './types';

export interface TurnClockInit {
  organizationId: string;
  conversationId: string;
  userId: string;
  agentId: string;
  model: string;
  /** 'web', 'google-chat', 'mcp'. Latency is not comparable across surfaces. */
  surface?: string;
  /**
   * When the turn really began, as a `performance.now()` reading.
   *
   * The clock cannot be constructed at the top of the request — it needs the
   * workspace, the conversation and the agent, and finding those is itself part
   * of the wait. Without this the measurement would quietly start after its own
   * first stage and report a turn shorter than the one the person sat through.
   * So the caller takes one reading on the first line and hands it over.
   */
  startedAt?: number;
  logger?: Logger;
}

/**
 * The provider metadata the Anthropic provider attaches to a step.
 *
 * Typed loosely on purpose: this is somebody else's bag of unknowns, the two
 * fields we want are nullable at the source, and a turn must not fail to be
 * measured because a provider added a key. Read defensively, never asserted.
 */
type ProviderMetadata = Record<string, Record<string, unknown> | undefined> | undefined;

function anthropicCacheTokens(meta: ProviderMetadata): { read: number; written: number } {
  const anthropic = meta?.anthropic;
  const read = anthropic?.cacheReadInputTokens;
  const written = anthropic?.cacheCreationInputTokens;
  return {
    read: typeof read === 'number' ? read : 0,
    written: typeof written === 'number' ? written : 0,
  };
}

export class TurnClock {
  private readonly init: TurnClockInit;
  private readonly t0: number;
  private readonly stages: TurnStageSample[] = [];
  private readonly cacheSteps: TurnCacheStep[] = [];

  private preludeMs = 0;
  private modelStartedAt: number | null = null;
  private firstVisibleAt: number | null = null;
  private firstAnswerAt: number | null = null;
  private finishedAt: number | null = null;
  private toolCalls = 0;
  private toolMs = 0;
  private promptTokens: number | null = null;
  private completionTokens: number | null = null;

  /**
   * The turn starts when the object is constructed unless the caller says
   * otherwise — see `startedAt`, which exists because the things this object
   * needs to exist are themselves part of the wait.
   */
  constructor(init: TurnClockInit) {
    this.init = init;
    this.t0 = init.startedAt ?? performance.now();
  }

  /** Milliseconds since the turn began. */
  private since(): number {
    return performance.now() - this.t0;
  }

  /**
   * Time a stage that is already a promise.
   *
   * Returns the SAME promise's value and rethrows the same rejection, so
   * wrapping a call changes nothing about when it runs or what it does. A stage
   * that fails is still recorded — how long a failure took is a fact about the
   * turn, and a retrieval that times out is precisely the turn worth finding.
   */
  async span<T>(stage: TurnStageKey, work: Promise<T>): Promise<T> {
    const at = this.since();
    try {
      return await work;
    } finally {
      this.stages.push({ stage, at: Math.round(at), ms: Math.round(this.since() - at) });
    }
  }

  /**
   * Time a stage whose boundaries the caller knows better than `span` does.
   * Returns the function that closes it. Calling it twice records once.
   */
  open(stage: TurnStageKey): () => void {
    const at = this.since();
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      this.stages.push({ stage, at: Math.round(at), ms: Math.round(this.since() - at) });
    };
  }

  /**
   * Everything from the start of the turn up to now was setup — the session,
   * the plan check, the agent row, the conversation, the user's message. Closed
   * with a single call rather than a span because it has no single owner: it is
   * whatever happened before the turn began deciding what to answer.
   */
  setup(): void {
    this.stages.push({ stage: 'setup', at: 0, ms: Math.round(this.since()) });
  }

  /**
   * The request is about to leave for the model. Everything before this instant
   * is work Cortex did on its own behalf, and it is the part that can be made
   * faster without touching the model or the answer.
   */
  handedToModel(): void {
    this.preludeMs = Math.round(this.since());
    this.modelStartedAt = this.since();
  }

  /**
   * The first character the person can actually see.
   *
   * `kind` separates the model's reasoning from its answer because this product
   * streams both and they arrive far apart. Called on every chunk; only the
   * first of each kind is kept, so the caller does not have to track state.
   */
  visible(kind: 'reasoning' | 'answer'): void {
    const now = this.since();
    if (this.firstVisibleAt === null) {
      this.firstVisibleAt = now;
      if (this.modelStartedAt !== null) {
        this.stages.push({
          stage: 'model',
          at: Math.round(this.modelStartedAt),
          ms: Math.round(now - this.modelStartedAt),
        });
      }
    }
    if (kind === 'answer' && this.firstAnswerAt === null) this.firstAnswerAt = now;
  }

  /** One tool call finished, having taken this long. Summed, never averaged. */
  toolFinished(ms: number): void {
    this.toolCalls += 1;
    this.toolMs += Math.round(ms);
  }

  /**
   * One round-trip to the model finished. Called per step so the cache can be
   * judged per call rather than per turn — see TurnCacheStep.
   */
  modelStep(usage: { promptTokens?: number } | undefined, meta: ProviderMetadata): void {
    const { read, written } = anthropicCacheTokens(meta);
    this.cacheSteps.push({ read, written, promptTokens: usage?.promptTokens ?? 0 });
  }

  /** The stream is closed. Nothing more will be shown to the person. */
  finished(usage?: { promptTokens?: number; completionTokens?: number }): void {
    this.finishedAt = this.since();
    if (this.firstVisibleAt !== null) {
      this.stages.push({
        stage: 'stream',
        at: Math.round(this.firstVisibleAt),
        ms: Math.round(this.finishedAt - this.firstVisibleAt),
      });
    }
    this.promptTokens = usage?.promptTokens ?? null;
    this.completionTokens = usage?.completionTokens ?? null;
  }

  /** Everything measured so far. Pure; used by `save` and by the tests. */
  snapshot(): TurnLatency {
    return {
      model: this.init.model,
      surface: this.init.surface ?? 'web',
      firstVisibleMs: this.firstVisibleAt === null ? null : Math.round(this.firstVisibleAt),
      firstAnswerMs: this.firstAnswerAt === null ? null : Math.round(this.firstAnswerAt),
      totalMs: Math.round(this.finishedAt ?? this.since()),
      preludeMs: this.preludeMs,
      // Sorted by when they started, so the row reads like the turn happened.
      stages: [...this.stages].sort((a, b) => a.at - b.at),
      steps: this.cacheSteps.length,
      toolCalls: this.toolCalls,
      toolMs: this.toolMs,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      cache: this.cacheSteps,
    };
  }

  /**
   * Write the row, after the answer has already been delivered.
   *
   * Swallows everything, for the same reason the context recorder does: a
   * workspace whose migrations lag by one must not see a turn fail because the
   * measurement of it could not be filed.
   */
  async save(
    db: SupabaseClient,
    opts: { messageId: string | null } = { messageId: null },
  ): Promise<void> {
    try {
      const m = this.snapshot();
      const purgeAt = new Date(Date.now() + LATENCY_KEEP_DAYS * 86_400_000).toISOString();
      const { error } = await db.from('turn_latencies').insert({
        conversation_id: this.init.conversationId,
        message_id: opts.messageId,
        user_id: this.init.userId,
        agent_id: this.init.agentId,
        model: m.model,
        surface: m.surface,
        first_visible_ms: m.firstVisibleMs,
        first_answer_ms: m.firstAnswerMs,
        total_ms: m.totalMs,
        prelude_ms: m.preludeMs,
        stages: m.stages,
        steps: m.steps,
        tool_calls: m.toolCalls,
        tool_ms: m.toolMs,
        prompt_tokens: m.promptTokens,
        completion_tokens: m.completionTokens,
        cache: m.cache,
        purge_at: purgeAt,
      });
      if (error) this.init.logger?.warn({ err: error }, 'turn_latencies insert failed');
    } catch (err) {
      this.init.logger?.warn({ err }, 'turn_latencies capture threw');
    }
  }
}
