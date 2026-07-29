/**
 * What Zippy remembers about one person.
 *
 * These rows are NOT retrieved. Every active one is injected whole into the
 * system prompt of every turn, on every surface — see ./prompt.ts for why, and
 * migration 0051 for the storage boundary.
 */

export type MemoryKind = 'instruction' | 'preference' | 'vocabulary' | 'fact';
export type MemoryStatus = 'suggested' | 'active' | 'archived' | 'rejected';
export type MemorySource = 'explicit' | 'derived' | 'behavioural';

export const MEMORY_KINDS: readonly MemoryKind[] = [
  'instruction',
  'preference',
  'vocabulary',
  'fact',
] as const;

/**
 * Mirrors `user_memory_limit()` in migration 0051. Duplicated deliberately: the
 * database is the enforcer, this copy only lets the UI say "34 of 40" without a
 * round-trip. If they ever disagree the database wins and nothing breaks.
 */
export const MEMORY_LIMIT = 40;

/** Mirrors `user_memory_suggestion_limit()`. Same contract. */
export const MEMORY_SUGGESTION_LIMIT = 12;

/** The longest a memory may be. Matches the check constraint in 0051. */
export const MEMORY_MAX_CHARS = 240;

/** A memory as it is injected into a prompt — the minimum the model needs. */
export interface MemoryContextEntry {
  id: string;
  content: string;
  kind: MemoryKind;
  source: MemorySource;
  lastUsedAt: string | null;
}

/** A memory as the person sees it on their own settings page. */
export interface MemoryRecord extends MemoryContextEntry {
  status: MemoryStatus;
  /** The conversation a derived suggestion came from — the evidence. */
  sourceConversationId: string | null;
  /** One line of why this was proposed, in the person's own words where possible. */
  sourceNote: string | null;
  useCount: number;
  createdAt: string;
}
