import { intakeOf } from '@/app/(app)/kb/_lib/brain';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { listVisibleSpaces } from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * The shape of what Brain Knowledge knows.
 *
 * Two kinds of relationship, and they are not the same kind of claim:
 *
 *   · SEMANTIC — two documents whose chunk centroids are close in the
 *     embedding space. This is an inference, it has a number, and 0062 does
 *     the work in Postgres because the vectors are already there and moving
 *     them here to compare would be absurd.
 *   · PEOPLE — two spoken documents in which the same named person spoke.
 *     This is a fact off a column, computed here because it is a set
 *     intersection over a handful of names, not a distance calculation.
 *
 * Neither is ever invented. If nothing clears the similarity floor, the
 * response has no edges and the page says so.
 */

const MIN_SIMILARITY = 0.6;
const MAX_DOCUMENTS = 60;
const MAX_EDGES = 400;
/** Beyond this the arcs stop being readable, so the list is truncated too. */
const MAX_PEOPLE_EDGES = 400;

type Source = 'upload' | 'record' | 'meeting' | 'drive';

interface GraphNode {
  id: string;
  title: string;
  source: Source;
  speakers: string[];
  durationSeconds: number | null;
  chunks: number;
  /**
   * Where the document is filed. Not in 0062's payload — the function answers
   * "what is like what", and this is "where do I go to read it". Added here so
   * that tapping a node on the ring can open the document instead of leaving
   * the person to go and find it by name.
   */
  spaceId?: string;
  spaceName?: string;
}

interface SemanticEdge {
  a: string;
  b: string;
  score: number;
}

interface RpcGraph {
  nodes: GraphNode[];
  edges: SemanticEdge[];
  considered: number;
  total: number;
}

/** Diarization's "Speaker 1" is a voice, not a person we can name. */
const UNNAMED_SPEAKER = /^\s*(speaker|hablante|participante)\s*\d+\s*$/i;

function namedSpeakers(node: GraphNode): string[] {
  return (node.speakers ?? []).filter((s) => s && !UNNAMED_SPEAKER.test(s));
}

export async function GET(req: NextRequest) {
  const session = await requireSession();
  const sb = getOrgScopedClient(session.organization.id);
  const url = new URL(req.url);

  const spaceId = url.searchParams.get('spaceId');
  const source = url.searchParams.get('source');
  const sources: Source[] | null =
    source === 'upload' || source === 'record' || source === 'meeting' || source === 'drive'
      ? [source]
      : null;

  // The rule lives in one place. Passing a space this person cannot see comes
  // back as an empty graph, which is what a space with nothing in it looks
  // like — the two must stay indistinguishable.
  const visible = await listVisibleSpaces(sb, session.id);
  const scoped = spaceId ? visible.filter((s) => s.id === spaceId) : visible;
  if (scoped.length === 0) {
    return NextResponse.json({
      nodes: [],
      semantic: [],
      people: [],
      considered: 0,
      total: 0,
      indexing: 0,
    });
  }

  const { data, error } = await sb.rpc('kb_brain_graph', {
    p_user_id: session.id,
    p_space_ids: scoped.map((s) => s.id),
    p_sources: sources,
    p_min_similarity: MIN_SIMILARITY,
    p_max_documents: MAX_DOCUMENTS,
    p_max_edges: MAX_EDGES,
  });

  if (error) {
    return NextResponse.json(
      { error: 'No se pudieron leer las relaciones. Vuelve a intentar.' },
      { status: 500 },
    );
  }

  const graph = (data ?? { nodes: [], edges: [], considered: 0, total: 0 }) as RpcGraph;
  const nodes = graph.nodes ?? [];

  // Where each node lives, so the ring can open it. At most 60 rows by primary
  // key, over documents the function has already decided this person may see —
  // a space that is not in `scoped` cannot appear here.
  if (nodes.length > 0) {
    const spaceName = new Map(scoped.map((s) => [s.id, s.name] as const));
    const { data: filed } = await sb
      .from('kb_documents')
      .select('id, collection_id')
      .in(
        'id',
        nodes.map((n) => n.id),
      );
    const home = new Map((filed ?? []).map((r) => [r.id as string, r.collection_id as string]));
    for (const node of nodes) {
      const space = home.get(node.id);
      if (!space) continue;
      node.spaceId = space;
      node.spaceName = spaceName.get(space) ?? undefined;
    }
  }

  // Who spoke in more than one place. A pair is only drawn when it shares a
  // person by name; two recordings that both say "Speaker 1" share nothing.
  const people: Array<{ a: string; b: string; names: string[] }> = [];
  const withVoices = nodes
    .map((n) => ({ id: n.id, names: namedSpeakers(n) }))
    .filter((n) => n.names.length > 0);
  outer: for (let i = 0; i < withVoices.length; i += 1) {
    for (let j = i + 1; j < withVoices.length; j += 1) {
      const left = withVoices[i];
      const right = withVoices[j];
      if (!left || !right) continue;
      const lower = new Set(right.names.map((n) => n.toLowerCase()));
      const shared = left.names.filter((n) => lower.has(n.toLowerCase()));
      if (shared.length === 0) continue;
      people.push({ a: left.id, b: right.id, names: shared });
      if (people.length >= MAX_PEOPLE_EDGES) break outer;
    }
  }

  // How much is still on its way in. Said out loud rather than left to look
  // like a document with no relationships: a document that has not been
  // indexed has no vectors at all yet.
  const { data: pending } = await sb
    .from('kb_documents')
    .select('source, media_kind, status')
    .in(
      'collection_id',
      scoped.map((s) => s.id),
    )
    .neq('status', 'ready');

  const indexing = (pending ?? []).filter((row) => {
    if (row.status === 'failed') return false;
    if (!sources) return true;
    return sources.includes(
      intakeOf({ source: row.source as string, media_kind: row.media_kind as string | null }),
    );
  }).length;

  return NextResponse.json({
    nodes,
    semantic: graph.edges ?? [],
    people,
    considered: graph.considered ?? nodes.length,
    total: graph.total ?? nodes.length,
    indexing,
    minSimilarity: MIN_SIMILARITY,
  });
}
