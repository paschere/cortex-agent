/**
 * What was handed to the model on one turn — the record, not a reconstruction.
 *
 * THE RULE THIS WHOLE MODULE EXISTS FOR. Everything in these shapes is written
 * down AT THE MOMENT THE TURN HAPPENS, from the values that were really used.
 * Nothing here may be recomputed at read time. That is not a preference, it is
 * the only thing that makes the surface worth having: thresholds get
 * recalibrated (relevance.ts moved twice in a week), documents get re-indexed,
 * spaces get renamed, the default model changes, a tool gets a new description
 * and re-embeds. A screen that re-ran the retrieval to show you "what it would
 * have retrieved" would agree with the truth on every turn except the ones you
 * opened it for.
 *
 * So a fragment carries its own score AND the cuts that judged it AND the model
 * whose scale those cuts are on. A tool offer carries the similarity it was
 * ranked at. None of them is a foreign key to something that can move.
 */

/** The parts a system prompt was assembled from, in the order they went in. */
export type ContextPartKey =
  /** The agent's own prompt, live from the `agents` row. */
  | 'instructions'
  /** Standing memories, injected whole (never retrieved — see migration 0051). */
  | 'memory'
  /** The Brain Knowledge fragments prepended for this turn. */
  | 'knowledge'
  /** Prior turns of this conversation replayed back to the model. */
  | 'history'
  /** The declarations of every tool the model was offered. */
  | 'tools'
  /** What the person actually typed this turn. */
  | 'question';

/**
 * One part of the turn, weighed.
 *
 * `chars` is a measurement: it is the exact length of the string that was sent.
 * `tokens` is an ESTIMATE and is labelled as one everywhere it is shown — a
 * real tokenizer would be another dependency and another few milliseconds on
 * the hot path, for a number whose only job is to answer "where did the context
 * go". The turn's REAL prompt token count is recorded separately, from the
 * provider's own usage report, so the estimate always has a true total to be
 * checked against.
 */
export interface ContextPart {
  key: ContextPartKey;
  chars: number;
  tokens: number;
}

/** The relevance cuts that were really applied, carried so they cannot drift. */
export interface CapturedCuts {
  modelId: string;
  strongMatch: number;
  weakFloor: number;
  railCeiling: number;
  /** False when nobody has run the corpus against this embedding model. */
  measured: boolean;
}

/**
 * One fragment the retrieval returned — including the ones that lost.
 *
 * THE NEAR MISSES ARE THE POINT. A fragment that scored 0,44 against a floor of
 * 0,46 is invisible everywhere else in the product: the tool drops it before
 * the model ever sees it, and nothing writes it down. It is also, far more
 * often than not, the answer to "why did it say that" — the passage was there,
 * the chunker cut it in half, and half of it landed two thousandths short. A
 * capture that only kept what was prepended would be a capture that omits the
 * explanation.
 */
export interface CapturedFragment {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  spaceId: string;
  spaceName: string;
  spaceKind: 'global' | 'personal';
  chunkIndex: number;
  /** Raw cosine. Null when the semantic arm did not run for this row. */
  cosine: number | null;
  keyword: number;
  /** The 0.7/0.3 blend the database sorted by. Good order, meaningless scale. */
  blended: number;
  /** How it was rated at the time, by the cuts in `CapturedCuts`. */
  verdict: 'strong' | 'weak' | 'dropped';
  /** True only for fragments that really went into the prompt. */
  prepended: boolean;
  /** The text as it was that day, capped. Null once the row has been redacted. */
  excerpt: string | null;
}

/** What retrieval concluded, in its own words, on the turn it ran. */
export interface CapturedRetrieval {
  /** False when the turn skipped retrieval entirely, with `skipped` saying why. */
  ran: boolean;
  /** In Spanish, for a reader: why no retrieval happened at all. */
  skipped: string | null;
  query: string;
  coverage: 'answered' | 'thin' | 'nothing' | 'keyword-only';
  /** The exact sentence the model was handed about its own results. */
  summary: string;
  cuts: CapturedCuts;
  /** How many fragments the turn was allowed to prepend. */
  limit: number;
  fragments: CapturedFragment[];
}

/**
 * A family the ranker scored, and whether it travelled.
 *
 * `score` is the cosine the family's best tool reached against this turn's
 * query vector. It is stored because re-deriving it later is impossible in
 * principle: the query embedding is not kept, tool descriptions get edited, and
 * the vector table is re-backfilled whenever one does.
 */
export interface CapturedFamily {
  family: string;
  /** Null for families that are never ranked, and for unindexed ones. */
  score: number | null;
  offered: boolean;
  reason: 'always' | 'ranked' | 'unindexed' | 'below-cut' | 'muted';
}

export interface CapturedToolOffer {
  /** Why the catalogue was narrowed the way it was, or why it was not. */
  reason: 'below-threshold' | 'no-query' | 'embedding-unavailable' | 'semantic';
  /** Every tool the person was allowed to call this turn, before narrowing. */
  candidates: number;
  /** The ids that were really declared to the model, in the order declared. */
  offered: string[];
  families: CapturedFamily[];
}

/** A standing instruction that was prepended whole. */
export interface CapturedMemory {
  id: string;
  /** Capped. Null once redacted. */
  text: string | null;
}

/**
 * The agent's own prompt, by digest rather than by copy.
 *
 * WHY NOT STORE IT. It is the longest single part of most turns, it is
 * identical across every turn of every conversation in a workspace, and it is
 * already stored — live, editable, one row — in `agents.system_prompt`. Keeping
 * a copy per turn would be the single largest thing in this table and would buy
 * nothing that the digest does not: the digest answers the only question that
 * matters when reading an old turn, which is whether the prompt on screen today
 * is the prompt that was sent. When it is not, the surface says so instead of
 * quietly showing the wrong one.
 */
export interface CapturedInstructions {
  chars: number;
  /** sha256 of the base prompt as sent, truncated. */
  digest: string;
}

/** Everything worth keeping about one turn. */
export interface TurnContextCapture {
  model: string;
  /** The provider's own count. The one true number on the page. */
  promptTokens: number | null;
  completionTokens: number | null;
  parts: ContextPart[];
  instructions: CapturedInstructions;
  memories: CapturedMemory[];
  retrieval: CapturedRetrieval;
  tools: CapturedToolOffer;
  /** Whether a conversation-scoped adjustment was in force, and which. */
  overridden: boolean;
}
