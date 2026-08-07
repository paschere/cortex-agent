/**
 * How long one turn took, and where the time went.
 *
 * THE QUESTION THIS ANSWERS, AND THE ONE IT DOES NOT. `audit_events` already
 * records how long each tool call took, and it is good at it. What nothing
 * recorded until now is the SHAPE of a turn: how long the person stared at an
 * empty screen before the first character arrived, how much of that was
 * retrieval, how much was the semantic tool ranking, and how much was the model
 * thinking before it wrote. The turn-level audit row this route already writes
 * carried `latency_ms: 0` — a literal zero, on the one row that was supposed to
 * say how long the turn took.
 *
 * TIME TO FIRST CHARACTER IS THE HEADLINE, NOT THE TOTAL. A turn that streams
 * its first word at 900 ms and finishes at 20 s feels alive. A turn that shows
 * nothing for 8 s and finishes at 12 s feels broken, and the person has already
 * turned to the colleague next to them. So `firstVisibleMs` is the number this
 * whole module exists to produce; `totalMs` is context for it.
 *
 * STAGES CARRY THEIR START, NOT JUST THEIR LENGTH. Retrieval and tool selection
 * run at the same time, so their durations do not add up to the wall clock and
 * a flat breakdown would double-count them. Every stage therefore records the
 * offset from the start of the turn at which it began. A reader can see the
 * overlap, and "these two now run concurrently" is visible in the data rather
 * than being a claim in a commit message.
 */

/**
 * A stage of a turn.
 *
 * These are the phases somebody would name when asked "what is it doing right
 * now", which is the only useful basis for the list — a breakdown by module
 * would be finer and would answer nothing.
 */
export type TurnStageKey =
  /** Session, body parse, agent row, conversation row, the user's message. */
  | 'setup'
  /** Brain Knowledge retrieval, embedding round-trip included. */
  | 'retrieval'
  /** The per-turn semantic tool ranking, embedding round-trip included. */
  | 'selection'
  /** Loading the transcript back out of Postgres. */
  | 'history'
  /** Standing memories and the assembly of the system prompt. */
  | 'prompt'
  /** Request handed to the model → the first thing the person can see. */
  | 'model'
  /** Everything the model streamed after that first visible character. */
  | 'stream';

/**
 * One stage, measured.
 *
 * `at` is milliseconds from the start of the turn, so overlapping stages are
 * legible instead of merely summing to more than the total. See the header.
 */
export interface TurnStageSample {
  stage: TurnStageKey;
  /** Offset from the start of the turn at which this stage began, in ms. */
  at: number;
  /** How long it took, in ms. */
  ms: number;
}

/**
 * What the prompt cache did on one call to the model.
 *
 * Recorded per model round-trip and not only for the turn, because a turn with
 * tool calls makes several and they do not behave alike: the first one of a
 * conversation writes the cache, the rest should read it. A per-turn total
 * would blur exactly the distinction that says whether caching is working.
 *
 * `read` and `written` are the provider's own counts
 * (`cache_read_input_tokens` / `cache_creation_input_tokens`), surfaced by the
 * Anthropic provider as `providerMetadata.anthropic`. A step where both are
 * zero did not participate in the cache at all.
 */
export interface TurnCacheStep {
  /** Tokens served from the cache. Non-zero means the prefix matched. */
  read: number;
  /** Tokens written into the cache at 1,25×. Non-zero means it did not. */
  written: number;
  /** The provider's total prompt tokens for this step, cache included. */
  promptTokens: number;
}

/** The whole turn, measured. Every field is a number that was observed. */
export interface TurnLatency {
  /** Which model answered. Latency is not comparable across models. */
  model: string;
  /** Where the turn came from — 'web' today, another surface tomorrow. */
  surface: string;

  /**
   * Start of the turn → the first character the person can see, whether that
   * is reasoning or answer text. This is the number that decides whether Cortex
   * feels alive. Null only if the turn produced nothing visible at all.
   */
  firstVisibleMs: number | null;
  /**
   * Start of the turn → the first character of the ANSWER.
   *
   * Kept apart from `firstVisibleMs` because this product streams the model's
   * reasoning, so on a normal turn the first visible character is a word of
   * thinking and the answer starts much later. Collapsing the two would either
   * flatter the product (reporting reasoning as if it were the answer) or
   * slander it (reporting the answer as if the screen had been blank until
   * then). Both are wrong; the gap between them is the interesting part.
   */
  firstAnswerMs: number | null;
  /** Start of the turn → the stream closing. */
  totalMs: number;
  /**
   * Start of the turn → the request leaving for the model.
   *
   * Everything Cortex itself is responsible for, and the only part of
   * `firstVisibleMs` that engineering can shorten without touching the model.
   */
  preludeMs: number;

  /** Every stage, with its offset. See TurnStageSample. */
  stages: TurnStageSample[];

  /** How many round-trips to the model this turn took. 1 when no tool ran. */
  steps: number;
  /** How many tool calls the model made across those steps. */
  toolCalls: number;
  /**
   * Wall-clock spent inside tool execution, summed.
   *
   * Summed rather than measured as a span because the SDK runs a step's tool
   * calls concurrently: the sum is what the tools cost, the wall clock is what
   * the turn paid, and both are worth knowing. `audit_events.latency_ms` holds
   * the per-tool breakdown, which is why it is not duplicated here.
   */
  toolMs: number;

  /** The provider's own count for the whole turn. */
  promptTokens: number | null;
  completionTokens: number | null;

  /** One entry per model round-trip, in order. See TurnCacheStep. */
  cache: TurnCacheStep[];
}

/** A stored row, read back. `id` and `createdAt` come from Postgres. */
export interface StoredTurnLatency extends TurnLatency {
  id: string;
  conversationId: string;
  /** The assistant message this turn produced, when it was persisted. */
  messageId: string | null;
  createdAt: string;
}
