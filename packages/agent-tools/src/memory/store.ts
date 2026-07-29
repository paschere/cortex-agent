import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  MemoryContextEntry,
  MemoryKind,
  MemoryRecord,
  MemorySource,
  MemoryStatus,
} from './types';

/**
 * The memory access boundary. Everything that reads or writes a memory — the
 * tools, the three prompt surfaces, the nightly job, the settings page — goes
 * through here.
 *
 * WHY IT IS ONE MODULE, and why every function below is a `.rpc()` call rather
 * than a table query: the isolation rule lives in Postgres (migration 0051) and
 * only there. `user_memory_context(p_user_id)` derives the visible set from the
 * user id INSIDE the database, so there is no function a caller could reach for
 * that takes "which memories" as an argument. A table query here would put the
 * rule back in the caller's hands, which is exactly the drift that migration
 * 0049 removed from Knowledge Base retrieval.
 *
 * Consequence worth stating: a caller that has lost track of who it is asking
 * for retrieves nothing, not everything.
 */

interface ContextRow {
  id: string;
  content: string;
  kind: MemoryKind;
  source: MemorySource;
  last_used_at: string | null;
}

interface ListRow extends ContextRow {
  status: MemoryStatus;
  source_conversation_id: string | null;
  source_note: string | null;
  use_count: number;
  created_at: string;
}

function toEntry(row: ContextRow): MemoryContextEntry {
  return {
    id: row.id,
    content: row.content,
    kind: row.kind,
    source: row.source,
    lastUsedAt: row.last_used_at,
  };
}

/**
 * Every memory to inject into this person's prompt, in the order they should
 * appear. Never throws: a memory lookup failing is a turn with less context,
 * not a turn that dies.
 */
export async function loadMemoryContext(
  db: SupabaseClient,
  userId: string,
): Promise<MemoryContextEntry[]> {
  if (!userId) return [];
  const { data, error } = await db.rpc('user_memory_context', { p_user_id: userId });
  if (error || !data) return [];
  return (data as ContextRow[]).map(toEntry);
}

/** Everything the person may see about themselves, including pending suggestions. */
export async function listMemories(db: SupabaseClient, userId: string): Promise<MemoryRecord[]> {
  if (!userId) return [];
  const { data, error } = await db.rpc('user_memory_list', { p_user_id: userId });
  if (error) throw error;
  return ((data ?? []) as ListRow[]).map((row) => ({
    ...toEntry(row),
    status: row.status,
    sourceConversationId: row.source_conversation_id,
    sourceNote: row.source_note,
    useCount: row.use_count,
    createdAt: row.created_at,
  }));
}

export interface RememberInput {
  userId: string;
  content: string;
  kind?: MemoryKind;
  source?: MemorySource;
  status?: MemoryStatus;
  /** The conversation this came from. Dropped by the database if not theirs. */
  conversationId?: string | null;
  /** One line of why, shown next to a suggestion so the decision is informed. */
  note?: string | null;
}

/**
 * Write a memory, or bring back the one that already says this.
 *
 * Returns null when the database declined — a suggestion whose queue is full,
 * or one the person already rejected. That is the normal case for the nightly
 * job, not an error: it proposes into a bounded queue and the overflow is
 * simply not proposed.
 */
export async function rememberMemory(
  db: SupabaseClient,
  input: RememberInput,
): Promise<string | null> {
  if (!input.userId) return null;
  const { data, error } = await db.rpc('user_memory_remember', {
    p_user_id: input.userId,
    p_content: input.content,
    p_kind: input.kind ?? 'fact',
    p_source: input.source ?? 'explicit',
    p_status: input.status ?? 'active',
    p_conversation_id: input.conversationId ?? null,
    p_note: input.note ?? null,
  });
  if (error) throw error;
  return (data as string | null) ?? null;
}

/** Delete one of this person's memories. False when it was never theirs. */
export async function forgetMemory(
  db: SupabaseClient,
  userId: string,
  memoryId: string,
): Promise<boolean> {
  if (!userId) return false;
  const { data, error } = await db.rpc('user_memory_forget', {
    p_user_id: userId,
    p_id: memoryId,
  });
  if (error) throw error;
  return data === true;
}

/**
 * Accept a suggestion, reject one, archive an active memory or restore an
 * archived one. An id belonging to someone else reports false — the same answer
 * a stale id gets, on purpose.
 */
export async function setMemoryStatus(
  db: SupabaseClient,
  userId: string,
  memoryId: string,
  status: MemoryStatus,
): Promise<boolean> {
  if (!userId) return false;
  const { data, error } = await db.rpc('user_memory_set_status', {
    p_user_id: userId,
    p_id: memoryId,
    p_status: status,
  });
  if (error) throw error;
  return data === true;
}

/**
 * Record that these memories were loaded into a prompt. Fire-and-forget by
 * design — it feeds eviction ordering only, and a turn must never wait on it or
 * fail because of it.
 */
export function touchMemories(db: SupabaseClient, userId: string, ids: string[]): void {
  if (!userId || ids.length === 0) return;
  void db.rpc('user_memory_touch', { p_user_id: userId, p_ids: ids }).then(
    () => undefined,
    () => undefined,
  );
}

/** Delete every memory that names a forgotten thing, matched loosely. */
export async function forgetMemoriesMatching(
  db: SupabaseClient,
  userId: string,
  needle: string,
): Promise<MemoryRecord[]> {
  const wanted = needle.trim().toLowerCase();
  if (!wanted) return [];
  const all = await listMemories(db, userId);
  const hits = all.filter(
    (m) => m.status !== 'rejected' && m.content.toLowerCase().includes(wanted),
  );
  for (const hit of hits) await forgetMemory(db, userId, hit.id);
  return hits;
}
