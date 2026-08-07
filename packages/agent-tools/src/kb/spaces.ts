import { ForbiddenError, NotFoundError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { embedQuery } from './embedder';

/**
 * The Brain Knowledge access boundary. Everything that reads or writes KB
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
  /**
   * The 0.7 semantic / 0.3 keyword blend the database sorts by. A good ORDER
   * and a meaningless magnitude — threshold on `semanticScore` instead, and see
   * relevance.ts for what that cost when nobody did.
   */
  score: number;
  /** Identifies the chunk itself, which is what a conflict lookup starts from. */
  chunkId: string;
  /**
   * Raw cosine similarity between question and passage: the only number here
   * that means the same thing from one query to the next. Null — never 0 —
   * when the semantic arm did not run for this row, because 0 is a real
   * similarity and would read as a certain miss.
   */
  semanticScore: number | null;
  /** ts_rank of the literal-word match. Zero for most rows. */
  keywordScore: number;
  /**
   * The provider-qualified model behind `semanticScore` — the same one on both
   * sides, because `kb_search_scoped` will not rank a query vector against a
   * chunk written by any other model (migration 0074). Null when the semantic
   * arm did not run.
   *
   * It travels on the hit because cosine similarity has no meaning without it:
   * relevance.ts keeps a different pair of thresholds per model, and a score
   * that arrives without saying which scale it is on is exactly how thresholds
   * measured for one embedder went on being applied to another.
   */
  embeddingModel: string | null;
  /**
   * The document's own date: when the call happened or the note was written,
   * not when the file was uploaded. This is the date a citation should carry.
   */
  datedAt: string | null;
  /** When the document says it stops being true, if it says so at all. */
  validUntil: string | null;
  /** Set when somebody filed a replacement for this document. */
  supersededById: string | null;
  supersededByTitle: string | null;
  /**
   * Whatever the chunk was filed with. `{pages}` for a parsed document,
   * `{speaker, speakers, startMs, endMs}` for a chunk of a recording — which
   * is what lets a caller cite the minute rather than just the file.
   */
  metadata: Record<string, unknown>;
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
 * everybody's Cortex answers from.
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
 * The person's own default space, created on first use. Everything Cortex saves
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
 * Resolve a space the way a person refers to it — by name. Cortex is never
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
  /**
   * Called with a human-readable reason when the semantic half of the search
   * could not run. The search still returns keyword matches, so the caller
   * decides whether to log it, tell the person, or both — what it must not do
   * is present a degraded result as a complete one.
   */
  onDegraded?: (reason: string) => void;
  /**
   * Count this retrieval against the fragments it returns (migration 0073).
   *
   * OFF BY DEFAULT, and the default is the point. The question the counter
   * answers is "does Cortex ever use this fragment to answer anybody" — the
   * memory that is being paid for and never spent. Two callers must therefore
   * NOT set it: the memory bench on the Brain Knowledge page, whose entire
   * purpose is to run the real retrieval without it counting as one, and the
   * search box on the same page, where a person is looking something up by
   * hand. Turning it on by default would make every fragment anybody ever
   * browsed look used, and the signal would be gone within a week of shipping.
   */
  recordRetrieval?: boolean;
  /**
   * Reorder the result set before it is cut to `limit`, counted, or returned.
   *
   * WHY THE HOOK IS HERE AND NOT AT THE CALL SITE. Postgres already applied the
   * limit, so a caller that reordered afterwards would only be shuffling rows
   * that were all going to be used anyway — it could never change WHICH
   * fragments the model is handed, which is the only thing worth changing. So
   * the extra rows have to be fetched here, and once they are fetched they must
   * be discarded here too: the surplus must not be counted as retrieved
   * (migration 0073's "has Cortex ever used this fragment" would rot within a
   * week) and must not reach the caller, where it would quietly widen the set
   * `assessCoverage` judges.
   *
   * The reranker may only REORDER. This function does the cutting, so a
   * reranker cannot lengthen a result set, and a reranker that returns the rows
   * unchanged produces byte-identical behaviour to having no reranker at all.
   *
   * Used by the learning loop (migration 0083), whose implementation is barred
   * from moving a fragment across a relevance band. See learning/apply.ts.
   */
  rerank?: (hits: SpaceHit[]) => SpaceHit[];
}

/**
 * How many extra rows are fetched when a reranker is present.
 *
 * Small on purpose. It is what lets a demoted fragment actually fall out of the
 * prepended set — without it a reranker can only reorder what was going to be
 * used regardless — and every one of them is a row Postgres ranked and returned
 * for nothing when learning has no opinion. Three covers the realistic case (a
 * couple of fragments under a doubt, out of a limit of three to eight) without
 * turning every search into a materially bigger one.
 */
const RERANK_MARGIN = 3;

/**
 * The single retrieval entry point. Embeds the query and hands the USER — not
 * a list of spaces — to Postgres, which decides what is searchable.
 *
 * When the query cannot be embedded (no Voyage key, provider down), the
 * embedding is sent as null and `kb_search_scoped` falls back to its full-text
 * arm. Half a search beats an exception: the person asked a question, and
 * "here is what matched on words" is a better answer than a red box.
 */
export async function searchSpaces(
  db: SupabaseClient,
  { userId, query, spaceIds, limit = 8, onDegraded, recordRetrieval, rerank }: SearchSpacesOptions,
): Promise<SpaceHit[]> {
  // A caller that has lost track of who it is asking for must retrieve
  // nothing, not everything.
  if (!userId) return [];
  if (!query.trim()) return [];
  // An explicit empty list means "search these zero spaces", which is not the
  // same as "search everything" — sending null here would silently widen it.
  if (spaceIds && spaceIds.length === 0) return [];

  // `input_type: "query"`, never "document" — the two live on different sides
  // of the same space and mixing them quietly costs recall.
  const embedded = await embedQuery(query);
  if (!embedded.ok) onDegraded?.(embedded.reason);

  const { data, error } = await db.rpc('kb_search_scoped', {
    p_user_id: userId,
    p_query_embedding: embedded.ok ? embedded.data : null,
    p_query_text: query,
    // The surplus exists only so a reranker has something to choose from, and
    // it never leaves this function. See `rerank` above.
    p_limit: rerank ? limit + RERANK_MARGIN : limit,
    p_space_ids: spaceIds ?? null,
    // The vector and the model that produced it always travel together. A query
    // vector from voyage-4-lite scored against a chunk from voyage-3-large does
    // not error, it returns a plausible number — so the database refuses to
    // consider chunks written by any other model, and a search whose model is
    // unknown degrades to keyword-only instead of ranking across spaces that
    // have nothing to do with each other. See migration 0074.
    p_embedding_model: embedded.ok ? embedded.usage.modelId : null,
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
    metadata?: Record<string, unknown> | null;
    chunk_id?: string | null;
    vec_score?: number | null;
    fts_score?: number | null;
    dated_at?: string | null;
    valid_until?: string | null;
    superseded_by?: string | null;
    superseded_by_title?: string | null;
  };

  const rows = (data as Row[]) ?? [];

  const mapped: SpaceHit[] = rows.map((r) => ({
    documentId: r.document_id,
    documentTitle: r.document_title,
    spaceId: r.space_id,
    spaceName: r.space_name,
    spaceKind: r.space_scope === 'global' ? ('global' as const) : ('personal' as const),
    chunkIndex: r.chunk_index,
    content: r.content,
    score: Number(r.score),
    // Everything from here down is optional on the row rather than required,
    // for the same reason `metadata` has been since 0058: a deployment whose
    // migrations lag by one should lose the extra columns, not crash on every
    // search. Missing `vec_score` degrades to null, which relevance.ts already
    // reads as "not measured" and handles as keyword-only.
    chunkId: r.chunk_id ?? '',
    semanticScore: r.vec_score === null || r.vec_score === undefined ? null : Number(r.vec_score),
    keywordScore: Number(r.fts_score ?? 0),
    // The scale the cosine above is on. Null whenever there is no cosine —
    // either the query could not be embedded, or this row came back from the
    // keyword arm alone and was never scored by meaning.
    embeddingModel:
      embedded.ok && r.vec_score !== null && r.vec_score !== undefined
        ? embedded.usage.modelId
        : null,
    datedAt: r.dated_at ?? null,
    validUntil: r.valid_until ?? null,
    supersededById: r.superseded_by ?? null,
    supersededByTitle: r.superseded_by_title ?? null,
    metadata: r.metadata ?? {},
  }));

  // Reorder, then cut. The cut is not the reranker's to make: it may say which
  // fragments it prefers, never how many there are. A reranker that throws is a
  // bug in the reranker and not a failed search — the plain scores are always
  // an acceptable answer, and the loop that supplies this hook is an
  // improvement on retrieval, never a precondition for it.
  let ordered = mapped;
  if (rerank) {
    try {
      ordered = rerank(mapped);
    } catch {
      ordered = mapped;
    }
    ordered = ordered.slice(0, limit);
  }

  // Bookkeeping must never cost an answer. If the counter fails — an older
  // deployment without 0073, a lock, anything — the person still gets their
  // hits and the only thing lost is a statistic. Awaited rather than left
  // dangling so a serverless invocation cannot be frozen mid-update, which is
  // how a fire-and-forget write becomes a write that sometimes does not happen.
  //
  // Counted from `ordered`, not from the raw rows: the surplus fetched for the
  // reranker was never shown to anybody and must not make an unused fragment
  // look used.
  if (recordRetrieval) {
    const chunkIds = ordered.map((h) => h.chunkId).filter((id): id is string => Boolean(id));
    if (chunkIds.length > 0) {
      try {
        await db.rpc('kb_note_retrieval', { p_user_id: userId, p_chunk_ids: chunkIds });
      } catch {
        // Deliberately silent: the caller asked for search results, not for a
        // report on the counter, and there is no action anybody could take.
      }
    }
  }

  return ordered;
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
  if (!data) throw new NotFoundError('That document is no longer in Brain Knowledge.');

  // Throws NotFoundError when the space is someone else's, which is what the
  // caller should see: the document is not theirs to know about.
  const space = await getVisibleSpace(db, userId, data.collection_id as string).catch(() => {
    throw new NotFoundError('That document is no longer in Brain Knowledge.');
  });

  return {
    id: data.id as string,
    title: data.title as string,
    uploadedBy: (data.uploaded_by as string | null) ?? null,
    space,
  };
}
