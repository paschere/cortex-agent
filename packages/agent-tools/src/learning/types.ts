/**
 * The vocabulary of the learning loop.
 *
 * Three shapes, and the split between them is the whole safety argument of the
 * module (migration 0083 has the long version):
 *
 *   LearningSignal      something that happened. Never acts on anything.
 *   LearningAdjustment  an ORDER, applied inside one relevance band. The only
 *                       one of the three that retrieval reads.
 *   LearningProposal    prose for a human. Read by the screen and nothing else.
 *
 * There is no numeric weight on an adjustment on purpose. A tunable bias on a
 * blended rank whose own magnitude is documented as meaningless is a knob
 * nobody can reason about, and it is the shape that grows until it can overrule
 * the thresholds. The vocabulary is three tiers: first, normal, last.
 */

/** Where a signal came from. See migration 0083 § 1 for what each one means. */
export type SignalKind =
  | 'reformulated'
  | 'abandoned'
  | 'moved_on'
  | 'fragment_copied'
  | 'extraction_corrected'
  | 'extraction_rejected'
  | 'extraction_confirmed'
  | 'field_corrected';

/** Evidence for (+1) or against (-1). */
export type SignalPolarity = -1 | 1;

/**
 * One observation, before it is written down.
 *
 * `documentId` + `chunkIndex` rather than a chunk id, for the reason
 * `turn-context/recorder.ts` gives: that pair is the identity that survives on
 * both sides of a retrieval and is not invalidated by a re-index.
 */
export interface LearningSignalInput {
  kind: SignalKind;
  polarity: SignalPolarity;
  /** 1 for a hint, 3 for somebody's deliberate correction. */
  weight: 1 | 2 | 3;
  documentId: string;
  /** -1 means the document as a whole. */
  chunkIndex: number;
  actorUserId?: string | null;
  conversationId?: string | null;
  turnContextId?: string | null;
  /** The sentence shown next to this row on screen, plus anything numeric. */
  detail?: Record<string, unknown>;
  /** Makes re-derivation idempotent. Unique within a workspace. */
  dedupeKey: string;
  observedAt: string;
}

/** A signal as it comes back out, for the feed on the page. */
export interface LearningSignalRow extends LearningSignalInput {
  id: string;
  createdAt: string;
}

/**
 * What an adjustment does, in the only three words this module has.
 *
 * Applied strictly within a relevance band: `kb/relevance.ts` decides what is
 * strong, what is weak and what is below the floor, and learning only decides
 * the order among equals. A demoted fragment that is the only strong match is
 * still prepended; a preferred fragment below the floor stays dropped.
 */
export type AdjustmentKind = 'prefer_fragment' | 'demote_fragment' | 'stale_document';

export type AdjustmentStatus = 'active' | 'revoked' | 'expired';

/** The counts an adjustment was created from, frozen at creation. */
export interface AdjustmentEvidence {
  /** Sum of polarity × weight over the window. Negative means "demote". */
  net: number;
  positive: number;
  negative: number;
  /** How many different people contributed. The anti-poisoning gate. */
  actors: number;
  /** How many distinct calendar days the evidence spans. */
  days: number;
  /** Counts by signal kind, so the screen can say what kind of evidence it was. */
  byKind: Partial<Record<SignalKind, number>>;
  firstSeen: string;
  lastSeen: string;
}

export interface LearningAdjustment {
  id: string;
  kind: AdjustmentKind;
  documentId: string;
  /** -1 for `stale_document`; a real index for the other two. */
  chunkIndex: number;
  status: AdjustmentStatus;
  evidence: AdjustmentEvidence;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  revokedReason: string | null;
}

/**
 * The subset retrieval needs. Deliberately tiny and deliberately without an
 * `id`: the applier must not be able to write anything back, and a shape that
 * cannot name a row cannot be tempted to.
 */
export interface ActiveAdjustment {
  kind: AdjustmentKind;
  documentId: string;
  chunkIndex: number;
}

export type ProposalKind = 'contradicted_value' | 'badly_cut_fragment' | 'unanswered_question';

export type ProposalStatus = 'open' | 'accepted' | 'dismissed';

export interface LearningProposal {
  id: string;
  kind: ProposalKind;
  documentId: string | null;
  chunkIndex: number | null;
  /** Colombian Spanish, written at derivation time. */
  headline: string;
  detail: string;
  evidence: Record<string, unknown>;
  status: ProposalStatus;
  decidedAt: string | null;
  decidedBy: string | null;
  decidedNote: string | null;
  dedupeKey: string;
  createdAt: string;
}

export interface LearningProposalInput {
  kind: ProposalKind;
  documentId: string | null;
  chunkIndex: number | null;
  headline: string;
  detail: string;
  evidence: Record<string, unknown>;
  dedupeKey: string;
}
