import { z } from 'zod';

/**
 * Shared contract for the memory page and its API route.
 *
 * Imported by a CLIENT component, so — like the preferences schema next door —
 * it must stay free of `@cortex/agent-tools`: importing it pulls the whole tool
 * registry, and with it `node:crypto` and pdf-parse's `fs` access, into the
 * browser bundle. Hence the structural input type below instead of importing
 * `MemoryRecord`.
 */

export type MemoryKindView = 'instruction' | 'preference' | 'vocabulary' | 'fact';
export type MemoryStatusView = 'suggested' | 'active' | 'archived' | 'rejected';
export type MemorySourceView = 'explicit' | 'derived' | 'behavioural';

/** What the page renders for one memory. */
export interface MemoryView {
  id: string;
  content: string;
  kind: MemoryKindView;
  status: MemoryStatusView;
  source: MemorySourceView;
  /** The conversation it was learned from, so the evidence is one click away. */
  sourceConversationId: string | null;
  sourceNote: string | null;
  lastUsedAt: string | null;
  useCount: number;
  createdAt: string;
}

export const MemoryActionBody = z.object({
  id: z.string().uuid(),
  action: z.enum(['accept', 'reject', 'archive', 'restore']),
});

export type MemoryAction = z.infer<typeof MemoryActionBody>['action'];

/** Structural on purpose — see the note at the top of this file. */
interface MemoryRecordLike {
  id: string;
  content: string;
  kind: string;
  status: string;
  source: string;
  sourceConversationId: string | null;
  sourceNote: string | null;
  lastUsedAt: string | null;
  useCount: number;
  createdAt: string;
}

export function toMemoryView(record: MemoryRecordLike): MemoryView {
  return {
    id: record.id,
    content: record.content,
    kind: record.kind as MemoryKindView,
    status: record.status as MemoryStatusView,
    source: record.source as MemorySourceView,
    sourceConversationId: record.sourceConversationId,
    sourceNote: record.sourceNote,
    lastUsedAt: record.lastUsedAt,
    useCount: record.useCount,
    createdAt: record.createdAt,
  };
}

/** Mirrors `user_memory_limit()` in migration 0051; the database is the enforcer. */
export const MEMORY_LIMIT_VIEW = 40;
