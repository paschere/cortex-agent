/**
 * Turn context: what the model was actually handed, written down as it happened.
 *
 * The counterpart to the memory bench on the Brain Knowledge page. That one
 * answers "what would retrieval bring back for this question" — a live probe,
 * run on demand, against today's index. This one answers "what did it bring
 * back on Tuesday at 14:32, in that conversation, when the answer was wrong",
 * which no probe can reach: the thresholds have moved since, the document has
 * been re-indexed since, and the tool descriptions have been re-embedded since.
 *
 * See `recorder.ts` for the rule the whole module is built on, `policy.ts` for
 * what is kept and for how long, and `read.ts` for who is allowed to see it.
 */

export * from './types';
export {
  DETAIL_DAYS,
  SKELETON_DAYS,
  EXCERPT_CHARS,
  MEMORY_CHARS,
  MAX_FRAGMENTS,
  MAX_OFFERED_TOOLS,
  retentionFrom,
  excerpt,
} from './policy';
export { CHARS_PER_TOKEN, estimateTokens, weighParts, shareOf, heaviest } from './weigh';
export { TurnContextRecorder, familiesFrom, fragmentKey, promptDigest } from './recorder';
export type { TurnContextRecorderInit } from './recorder';
export { loadTurnContexts } from './read';
export type { ReadableTurnContext, ReadableFragment } from './read';
export {
  NO_OVERRIDES,
  MAX_PREPENDED_FRAGMENTS,
  hasOverrides,
  loadOverrides,
  saveOverrides,
} from './settings';
export type { TurnContextOverrides, SaveOverridesInput } from './settings';
