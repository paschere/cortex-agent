/**
 * Learning: the loop that makes using Cortex improve it.
 *
 * A bad answer used to be corrected in somebody's head and nowhere else. They
 * rephrased the question, got something usable on the second try, and the same
 * question produced the same first answer the next day. Everything needed to
 * have known better was already written down — `turn_contexts` (0080) keeps
 * which fragments were pasted above each question and what they scored,
 * `document_field_corrections` (0076) keeps every value a human corrected the
 * extractor on, `commitments` (0069) keeps every extracted deadline somebody
 * had to fix — and none of it was ever read back.
 *
 * WHAT IT MAY DO ON ITS OWN, AND WHAT IT MAY NOT. An adjustment is an ORDER:
 * within a relevance band, this fragment goes first, or last. It cannot move
 * anything across the band — `kb/relevance.ts` stays the only authority on what
 * clears the floor — so the worst a mistaken or manufactured signal can do is
 * quote one already-relevant passage before another already-relevant one. An
 * ordering mistake is cheap and self-correcting; the material is still there
 * and the next signal moves it back. Anything that would change what the system
 * believes to be TRUE — a value the corpus states wrongly, a chunk boundary
 * that needs re-indexing, a question nobody ever wrote an answer to — is a
 * PROPOSAL, has no effect on retrieval at all, and waits for a person. The two
 * live in different tables so the distinction cannot be lost to a careless
 * `where` clause. See migration 0083 for the long form.
 *
 *   apply.ts   the fence: pure, band-safe, no database
 *   derive.ts  the rules: pure, from captured turns and human corrections
 *   run.ts     one pass for one workspace
 *   store.ts   reads and writes, all workspace-scoped
 *   report.ts  what the screen shows, and what it withholds from whom
 */

export * from './types';
export {
  indexAdjustments,
  rerankByLearning,
  tierFor,
} from './apply';
export type { LearningIndex, LearningTier, RelevanceBand, RerankOptions } from './apply';
export {
  CUT_MIN_TURNS,
  EVIDENCE_WINDOW_DAYS,
  GAP_MIN_ACTORS,
  GAP_MIN_ASKS,
  MIN_ACTORS,
  MIN_NET,
  SOLO_DAYS,
  SOLO_NET,
  decideAdjustments,
  deriveBadCutProposals,
  deriveGapProposals,
  deriveTurnSignals,
  isDecisive,
  summarizeEvidence,
  topicOverlap,
  topicSignature,
  topicWords,
} from './derive';
export type { AdjustmentDecision, FragmentEvidence, TurnRecord } from './derive';
export {
  ADJUSTMENT_DAYS,
  SIGNAL_RETENTION_DAYS,
  applyAdjustment,
  decideLearningProposal,
  expireAdjustments,
  forgetAdjustmentCache,
  listAdjustments,
  listLearningProposals,
  listSignalsSince,
  loadActiveAdjustments,
  purgeSignals,
  raiseProposals,
  recordSignal,
  recordSignals,
  revokeAdjustment,
} from './store';
export type { CreateAdjustmentInput } from './store';
export { CORRECTION_WINDOW_DAYS, TURN_WINDOW_DAYS, runLearningPass } from './run';
export type { LearningPassResult } from './run';
export {
  ADJUSTMENT_EXPLANATIONS,
  ADJUSTMENT_LABELS,
  PROPOSAL_LABELS,
  PROPOSAL_STATUS_LABELS,
  SIGNAL_LABELS,
  buildLearningReport,
} from './report';
export type {
  AdjustmentView,
  DocumentLabel,
  LearningReport,
  ProposalView,
  SignalView,
} from './report';
