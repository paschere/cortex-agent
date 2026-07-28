import type { SupabaseClient } from '@supabase/supabase-js';
import { ForbiddenError, NotFoundError } from '@zipdev/core';
import { embed } from './embedder';

/**
 * The Knowledge Base access boundary. Everything that reads or writes KB
 * content — the tools, the web routes, both MCP servers — goes through here.
 *
 * WHY IT IS ONE MODULE. Before spaces, every caller worked out for itself which
 * buckets a person was allowed to see, and they disagreed: the search route
 * accepted a list of bucket ids straight from the browser, the documents route
 * checked nothing, and the tool trusted whatever the model asked for. None of
 * those were wrong on purpose; each one was written on a different day. The
 * rule has to live in exactly one place or it drifts again.
 *
 * The rule is enforced twice, deliberately:
 *   - here, so callers get a clear error and never see a title they shouldn't;
 *   - in `kb_search_scoped` / `kb_visible_space_ids` in Postgres, so a caller
 *     that skips this module still cannot retrieve someone else's notes. The
 *     unscoped search function was dropped in 0049; there is no longer a
 *     database entry point that takes "which spaces" as an argument.
 */

/** What a space is, in the only two flavours that exist. */
export type SpaceKind = 'global' | 'personal';

export interface Space {
  id: string;
  name: string;
  kind: SpaceKind;
  description: string | null;
  /** The one person who can see a personal space. Null for global spaces. */
  ownerId: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface SpaceHit {
  documentId: string;
  documentTitle: string;
  spaceId: string;
  spaceName: string;
  spaceKind: SpaceKind;
  chunkIndex: number;
  content: string;
  score: number;
}

type SpaceRow = {
  id: string;
  name: string;
  scope: string;
  scope_id: string | null;
  description: string | null;
  created_by: string | null;
  created_at: string;
};

function toSpace(row: SpaceRow): Space {
  return {
    id: row.id,
    name: row.name,
    kind: row.scope === 'global' ? 'global' : 'personal',
    description: row.description,
    ownerId: row.scope_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

const SPACE_COLUMNS = 'id, name, scope, scope_id, description, created_by, created_at';

/**
 * Every space this person may retrieve from: all global spaces plus their own
 * personal ones. Deliberately has no admin branch — an org admin publishes
 * global spaces, which is not the same as being able to read everyone's notes.
 */
export async function listVisibleSpaces(db: SupabaseClient, userId: string): Promise<Space[]> {
  if (!userId) return [];
  const { data, error } = await db
    .from('kb_collections')
    .select(SPACE_COLUMNS)
    .or(`scope.eq.global,and(scope.eq.user,scope_id.eq.${userId})`)
    .order('scope', { ascending: true })
    .order('name', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as SpaceRow[]).map(toSpace);
}

/**
 * Fetch one space, or throw as if it did not exist when the caller cannot see
 * it. "Not found" rather than "forbidden" is the point: a wrong-id probe and a
 * someone-else's-space probe have to be indistinguishable, otherwise the error
 * message itself confirms that a private space exists.
 */
export async function getVisibleSpace(
  db: SupabaseClient,
  userId: string,
  spaceId: string,
): Promise<Space> {
  const { data, error } = await db
    .from('kb_collections')
    .select(SPACE_COLUMNS)
    .eq('id', spaceId)
    .maybeSingle();
  if (error) throw error;
  const row = data as SpaceRow | null;
  if (!row) throw new NotFoundError('That space no longer exists.');
  const space = toSpace(row);
  if (space.kind === 'personal' && space.ownerId !== userId) {
    throw new NotFoundError('That space no longer exists.');
  }
  return space;
}

/**
 * Who may put a document into a space, and who may rename or delete it.
 * Personal: its owner. Global: an org admin, because a global space is what
 * everybody's Zippy answers from.
 */
export async function assertCanWriteToSpace(
  db: SupabaseClient,
  userId: string,
  spaceId: string,
): Promise<Space> {
  const space = await getVisibleSpace(db, userId, spaceId);
  if (space.kind === 'personal') {
    if (space.ownerId !== userId) throw new NotFoundError('That space no longer exists.');
    return space;
  }
  if (!(await isOrgAdmin(db, userId))) {
    throw new ForbiddenError(
      'Only an org admin can add to a company-wide space. Save it to one of your own spaces instead.',
    );
  }
  return space;
}

export async function isOrgAdmin(db: SupabaseClient, userId: string): Promise<boolean> {
  if (!userId) return false;
  const { data } = await db.from('users').select('role').eq('id', userId).maybeSingle();
  return data?.role === 'org_admin';
}

/**
 * The person's own default space, created on first use. Everything Zippy saves
 * without being told where lands here, so the default is the private one: a
 * note that should have been company-wide is a one-click move, a note that
 * should have been private and wasn't cannot be un-published.
 */
export async function ensurePersonalSpace(
  db: SupabaseClient,
  userId: string,
  name = 'My notes',
): Promise<{ id: string; name: string }> {
  const { data: existing, error: findErr } = await db
    .from('kb_collections')
    .select('id, name')
    .eq('scope', 'user')
    .eq('scope_id', userId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (findErr) throw findErr;
  if (existing) return { id: existing.id as string, name: existing.name as string };

  const { data: created, error: insErr } = await db
    .from('kb_collections')
    .insert({ scope: 'user', scope_id: userId, name, created_by: userId })
    .select('id, name')
    .single();
  if (insErr || !created) throw new Error(`Could not create your space: ${insErr?.message}`);
  return { id: created.id as string, name: created.name as string };
}

/**
 * Resolve a space the way a person refers to it — by name. Zippy is never
 * given an id to repeat back, so the tools take names and this turns a name
 * into a space the caller can actually write to. Personal spaces win ties: if
 * someone has their own "Rates" and the company has a "Rates", "save it to
 * Rates" means their own.
 */
export async function resolveSpaceByName(
  db: SupabaseClient,
  userId: string,
  name: string,
): Promise<Space | null> {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  const visible = await listVisibleSpaces(db, userId);
  const exact = visible.filter((s) => s.name.toLowerCase() === wanted);
  const exactFirst = exact.find((s) => s.kind === 'personal') ?? exact[0];
  if (exactFirst) return exactFirst;

  const partial = visible.filter((s) => s.name.toLowerCase().includes(wanted));
  return partial.length === 1 ? (partial[0] ?? null) : null;
}

export interface SearchSpacesOptions {
  userId: string;
  query: string;
  /**
   * Narrow the search to a subset of what the caller can already see. It can
   * never widen it: the database intersects this with the visible set, so an
   * id belonging to someone else's personal space contributes nothing.
   */
  spaceIds?: string[];
  limit?: number;
}

/**
 * The single retrieval entry point. Embeds the query and hands the USER — not
 * a list of spaces — to Postgres, which decides what is searchable.
 */
export async function searchSpaces(
  db: SupabaseClient,
  { userId, query, spaceIds, limit = 8 }: SearchSpacesOptions,
): Promise<SpaceHit[]> {
  // A caller that has lost track of who it is asking for must retrieve
  // nothing, not everything.
  if (!userId) return [];
  if (!query.trim()) return [];
  // An explicit empty list means "search these zero spaces", which is not the
  // same as "search everything" — sending null here would silently widen it.
  if (spaceIds && spaceIds.length === 0) return [];

  const [embedding] = await embed([query]);
  if (!embedding) return [];

  const { data, error } = await db.rpc('kb_search_scoped', {
    p_user_id: userId,
    p_query_embedding: embedding,
    p_query_text: query,
    p_limit: limit,
    p_space_ids: spaceIds ?? null,
  });
  if (error) throw error;

  type Row = {
    document_id: string;
    document_title: string;
    space_id: string;
    space_name: string;
    space_scope: string;
    chunk_index: number;
    content: string;
    score: number;
  };

  return ((data as Row[]) ?? []).map((r) => ({
    documentId: r.document_id,
    documentTitle: r.document_title,
    spaceId: r.space_id,
    spaceName: r.space_name,
    spaceKind: r.space_scope === 'global' ? ('global' as const) : ('personal' as const),
    chunkIndex: r.chunk_index,
    content: r.content,
    score: Number(r.score),
  }));
}

/**
 * Guard for anything that reaches a document directly by id rather than
 * through search — reading its chunks, listing it, moving it, deleting it.
 * Without this, a document id (which every search hit hands out) is enough to
 * pull the full text of a document out of a space you cannot see.
 */
export async function getVisibleDocument(
  db: SupabaseClient,
  userId: string,
  documentId: string,
): Promise<{ id: string; title: string; uploadedBy: string | null; space: Space }> {
  const { data, error } = await db
    .from('kb_documents')
    .select('id, title, uploaded_by, collection_id')
    .eq('id', documentId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError('That document is no longer in the Knowledge Base.');

  // Throws NotFoundError when the space is someone else's, which is what the
  // caller should see: the document is not theirs to know about.
  const space = await getVisibleSpace(db, userId, data.collection_id as string).catch(() => {
    throw new NotFoundError('That document is no longer in the Knowledge Base.');
  });

  return {
    id: data.id as string,
    title: data.title as string,
    uploadedBy: (data.uploaded_by as string | null) ?? null,
    space,
  };
}
