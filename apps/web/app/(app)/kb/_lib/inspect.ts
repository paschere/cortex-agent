import { assessFreshness, listVisibleSpaces } from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  Corroboration,
  FragmentHealth,
  IntakeKey,
  KnowledgeShape,
  StaleDocument,
} from '../_components/types';
import { intakeOf } from './brain';

/**
 * Reading the memory itself, rather than the pile of files it was made from.
 *
 * `brain.ts` counts documents: what arrived, through which mouth, how much of
 * it is indexed. This counts FRAGMENTS, and asks the three questions a person
 * running this actually has once the uploading is done:
 *
 *   · is any of this being used?
 *   · was it cut up in a way that can be retrieved?
 *   · is any of it out of date, and does anything back it up?
 *
 * Everything here is server-only and may import `@cortex/agent-tools` freely.
 * The shapes it returns are the plain ones in `_components/types.ts`, which is
 * what the browser receives.
 */

/**
 * How many documents the corroboration pass compares.
 *
 * The similarity work is quadratic — 0062 says so at length — so this is a
 * ceiling, not a wish. 90 documents is 4,005 pairs, which Postgres does in
 * milliseconds over centroids it computes once. Past that the page says out
 * loud that it looked at the newest 90 of a larger corpus rather than quietly
 * drawing a partial picture as though it were the whole one.
 */
const SHAPE_DOCUMENTS = 90;

/**
 * The floor for "these two are about the same thing".
 *
 * Same value the relations ring has always used. Deliberately not retuned here:
 * two views of the same corpus disagreeing about what is related would make
 * both of them untrustworthy, and there is no reason this reading should be
 * stricter than the one people already know.
 */
const SHAPE_MIN_SIMILARITY = 0.6;

/** Old enough to be worth a look. Matches `freshness.ts`, on purpose. */
const AGING_DAYS = 180;

export async function readFragmentHealth(
  db: SupabaseClient,
  userId: string,
  spaceIds?: string[],
): Promise<FragmentHealth | null> {
  const { data, error } = await db.rpc('kb_fragment_health', {
    p_user_id: userId,
    p_space_ids: spaceIds ?? null,
    p_samples: 6,
  });
  // Null rather than an empty reading: a panel that cannot be computed says so
  // and gets out of the way. Zeros would read as "everything is fine here",
  // which is the one thing it must never say by accident.
  if (error || !data) return null;
  return data as FragmentHealth;
}

/**
 * What is out of date, and what has been replaced.
 *
 * Reuses `assessFreshness` rather than restating the rules: the phrase this
 * panel prints beside a document is the same phrase a citation carries when
 * Cortex quotes it, word for word, because they are the same sentence produced
 * by the same function. Two different wordings for the same fact is how a
 * person stops believing either one.
 */
export async function readStale(
  db: SupabaseClient,
  userId: string,
  spaceIds?: string[],
  limit = 12,
): Promise<StaleDocument[]> {
  const spaces = await listVisibleSpaces(db, userId);
  const scoped = spaceIds ? spaces.filter((s) => spaceIds.includes(s.id)) : spaces;
  if (scoped.length === 0) return [];
  const nameOf = new Map(scoped.map((s) => [s.id, s.name] as const));

  const { data, error } = await db
    .from('kb_documents')
    .select('id, title, collection_id, created_at, recorded_at, valid_until, superseded_by, status')
    .in(
      'collection_id',
      scoped.map((s) => s.id),
    )
    .eq('status', 'ready');
  if (error || !data) return [];

  // The replacement's title, so the panel can say what replaced what instead of
  // printing a uuid nobody can act on.
  const replacements = [
    ...new Set(
      (data as Array<{ superseded_by: string | null }>)
        .map((r) => r.superseded_by)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const titleOf = new Map<string, string>();
  if (replacements.length > 0) {
    const { data: rows } = await db.from('kb_documents').select('id, title').in('id', replacements);
    for (const row of rows ?? []) titleOf.set(row.id as string, row.title as string);
  }

  const now = new Date();
  const out: StaleDocument[] = [];
  for (const row of data as Array<{
    id: string;
    title: string | null;
    collection_id: string;
    created_at: string;
    recorded_at: string | null;
    valid_until: string | null;
    superseded_by: string | null;
  }>) {
    const freshness = assessFreshness({
      datedAt: row.recorded_at ?? row.created_at,
      validUntil: row.valid_until,
      supersededByTitle: row.superseded_by ? (titleOf.get(row.superseded_by) ?? null) : null,
      now,
    });
    // "Current" and "aging" are the overwhelming majority and neither is a
    // finding. Only what somebody would actually go and check appears here;
    // a list that includes everything is a list nobody opens twice.
    if (freshness.status === 'current') continue;
    if (freshness.status === 'aging' && (freshness.ageDays ?? 0) < AGING_DAYS) continue;
    out.push({
      id: row.id,
      title: row.title ?? 'Sin título',
      spaceId: row.collection_id,
      spaceName: nameOf.get(row.collection_id) ?? '',
      status: freshness.status,
      label: freshness.label,
      ageDays: freshness.ageDays,
    });
  }

  // Expired and replaced first: those are facts about the document, not
  // opinions about its age, and they are what somebody acts on today.
  const rank: Record<StaleDocument['status'], number> = {
    expired: 0,
    superseded: 1,
    old: 2,
    aging: 3,
  };
  out.sort((a, b) => rank[a.status] - rank[b.status] || (b.ageDays ?? 0) - (a.ageDays ?? 0));
  return out.slice(0, limit);
}

interface GraphNode {
  id: string;
  title: string;
  source: IntakeKey;
  chunks: number;
}

interface GraphEdge {
  a: string;
  b: string;
  score: number;
}

/**
 * The shape of what it knows: which subjects are documented from several sides,
 * and which rest on exactly one file.
 *
 * WHY THIS AND NOT A LIST OF TOP TERMS. The obvious reading of "what does it
 * know a lot about" is word frequency, and it is worthless: the top of that
 * list is "cliente", "factura" and "servicio" for every company that has ever
 * existed, and it measures the vocabulary rather than the knowledge. Counting
 * how many other documents corroborate each one measures something a person can
 * act on — a rate that appears in four documents is a rate the company agrees
 * with itself about, and one that appears in a single call recording from
 * February is one bad memory away from being wrong with total confidence.
 *
 * Reuses `kb_brain_graph` whole. The similarity between documents is already
 * computed there, in Postgres, next to the vectors; recomputing it here would
 * be a second answer to a question that already has one.
 */
export async function readShape(
  db: SupabaseClient,
  userId: string,
  spaceIds?: string[],
): Promise<KnowledgeShape | null> {
  const { data, error } = await db.rpc('kb_brain_graph', {
    p_user_id: userId,
    p_space_ids: spaceIds ?? null,
    p_sources: null,
    p_min_similarity: SHAPE_MIN_SIMILARITY,
    p_max_documents: SHAPE_DOCUMENTS,
    p_max_edges: 900,
  });
  if (error || !data) return null;

  const graph = data as {
    nodes?: GraphNode[];
    edges?: GraphEdge[];
    considered?: number;
    total?: number;
  };
  const nodes = graph.nodes ?? [];
  if (nodes.length === 0) {
    return { corroborated: [], alone: [], considered: 0, total: graph.total ?? 0 };
  }

  const degree = new Map<string, number>(nodes.map((n) => [n.id, 0] as const));
  for (const edge of graph.edges ?? []) {
    degree.set(edge.a, (degree.get(edge.a) ?? 0) + 1);
    degree.set(edge.b, (degree.get(edge.b) ?? 0) + 1);
  }

  // 0062 answers "what is like what" and not "where do I go to read it", so the
  // filing is resolved here — at most 90 rows by primary key, over documents
  // the function has already decided this person may see. It widens nothing.
  const spaces = await listVisibleSpaces(db, userId);
  const spaceName = new Map(spaces.map((s) => [s.id, s.name] as const));
  const home = new Map<string, string>();
  const { data: filed } = await db
    .from('kb_documents')
    .select('id, collection_id')
    .in(
      'id',
      nodes.map((n) => n.id),
    );
  for (const row of filed ?? []) home.set(row.id as string, row.collection_id as string);

  const rows: Corroboration[] = nodes.map((n) => {
    const space = home.get(n.id) ?? null;
    return {
      documentId: n.id,
      title: n.title,
      spaceId: space,
      spaceName: space ? (spaceName.get(space) ?? null) : null,
      source: n.source,
      chunks: n.chunks,
      neighbours: degree.get(n.id) ?? 0,
    };
  });

  const corroborated = rows
    .filter((r) => r.neighbours > 0)
    .sort((a, b) => b.neighbours - a.neighbours || b.chunks - a.chunks)
    .slice(0, 6);

  // Biggest first among the unbacked ones: a fifty-fragment contract nothing
  // corroborates is a real exposure; a two-fragment note is just a note.
  const alone = rows
    .filter((r) => r.neighbours === 0)
    .sort((a, b) => b.chunks - a.chunks)
    .slice(0, 6);

  return {
    corroborated,
    alone,
    considered: graph.considered ?? nodes.length,
    total: graph.total ?? nodes.length,
  };
}
