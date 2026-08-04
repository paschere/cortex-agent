import { type Space, listVisibleSpaces } from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { BrainStats, DigestStage, DigestingDoc, IntakeCounts } from '../_components/types';

/**
 * One reading of the brain: what it has swallowed, what it is digesting, and
 * how much it can recall.
 *
 * WHY THIS IS SHARED. The page renders it on the server and the digestion panel
 * re-reads it every few seconds while something is in flight. If the two counted
 * differently, the figures would jump the moment the first poll landed. One
 * function, two callers.
 *
 * Every figure here comes from a row. Nothing is estimated, and a count that
 * cannot be read comes back null so the interface can leave it out instead of
 * printing a zero it cannot stand behind.
 */

/** Only the document columns any of these figures are built from. */
const DOC_COLUMNS =
  'id, collection_id, title, status, created_at, source, media_kind, duration_seconds, speakers, transcript_status';

interface DocRow {
  id: string;
  collection_id: string;
  title: string | null;
  status: string;
  created_at: string;
  source: string;
  media_kind: string | null;
  duration_seconds: number | null;
  speakers: string[] | null;
  transcript_status: string | null;
}

export interface SpaceFacts {
  documentCount: number;
  pendingCount: number;
  failedCount: number;
  lastAddedAt: string | null;
  chunkCount: number | null;
  spokenSeconds: number;
  intake: IntakeCounts;
}

export interface BrainReading {
  spaces: Space[];
  facts: Map<string, SpaceFacts>;
  stats: BrainStats;
}

function emptyIntake(): IntakeCounts {
  return { upload: 0, record: 0, meeting: 0, drive: 0 };
}

function emptyFacts(): SpaceFacts {
  return {
    documentCount: 0,
    pendingCount: 0,
    failedCount: 0,
    lastAddedAt: null,
    chunkCount: null,
    spokenSeconds: 0,
    intake: emptyIntake(),
  };
}

/**
 * The database keeps ingestion and transcription apart because they fail for
 * different reasons. A person watching the panel does not care which half is
 * slow — only whether the thing is in yet. So the two columns collapse here,
 * in one place, and every view of the cycle reads the same answer.
 */
export function stageOf(doc: {
  status: string;
  transcript_status?: string | null;
}): DigestStage {
  if (doc.status === 'failed' || doc.transcript_status === 'failed') return 'stuck';
  if (doc.status === 'ready') return 'memory';
  if (doc.status === 'ingesting' || doc.transcript_status === 'transcribing') return 'digesting';
  return 'waiting';
}

/** Which mouth a document came in through. */
function intakeOf(doc: { source: string; media_kind: string | null }): keyof IntakeCounts {
  if (doc.source === 'gdrive') return 'drive';
  if (doc.source === 'meeting' || doc.media_kind === 'meeting') return 'meeting';
  if (doc.source === 'recording') return 'record';
  return 'upload';
}

/**
 * Diarization hands back "Speaker 1", "Speaker 2"… — a count of voices, not of
 * people. Only names that came from somewhere (Meet participants, a voice that
 * has been renamed) are counted as someone the brain recognises.
 */
const UNNAMED_SPEAKER = /^\s*(speaker|hablante|participante)\s*\d+\s*$/i;

export async function readBrain(
  db: SupabaseClient,
  userId: string,
  options: { perSpaceChunks?: boolean } = {},
): Promise<BrainReading> {
  // One rule for "what can this person see", shared with retrieval. The page
  // cannot show a space Cortex would refuse to search, or vice versa.
  const spaces = await listVisibleSpaces(db, userId);
  const spaceIds = spaces.map((s) => s.id);
  const nameOf = new Map(spaces.map((s) => [s.id, s.name] as const));

  const facts = new Map<string, SpaceFacts>(spaces.map((s) => [s.id, emptyFacts()] as const));

  const stats: BrainStats = {
    stages: { waiting: 0, digesting: 0, memory: 0, stuck: 0 },
    intake: emptyIntake(),
    chunks: null,
    spokenSeconds: 0,
    namedVoices: 0,
    unnamedRecordings: 0,
    lastAddedAt: null,
    digesting: [],
  };

  if (spaceIds.length === 0) return { spaces, facts, stats };

  const { data } = await db.from('kb_documents').select(DOC_COLUMNS).in('collection_id', spaceIds);

  const named = new Set<string>();

  for (const row of (data ?? []) as DocRow[]) {
    const entry = facts.get(row.collection_id);
    if (!entry) continue;

    const stage = stageOf(row);
    entry.documentCount += 1;
    if (stage === 'stuck') entry.failedCount += 1;
    else if (stage !== 'memory') entry.pendingCount += 1;
    if (!entry.lastAddedAt || row.created_at > entry.lastAddedAt) {
      entry.lastAddedAt = row.created_at;
    }

    const mouth = intakeOf(row);
    entry.intake[mouth] += 1;
    stats.intake[mouth] += 1;
    stats.stages[stage] += 1;

    if (!stats.lastAddedAt || row.created_at > stats.lastAddedAt) {
      stats.lastAddedAt = row.created_at;
    }

    // Only digested audio counts as heard. A recording still in the queue has
    // no duration yet, and one that failed was never listened to.
    const spoken = row.media_kind === 'audio' || row.media_kind === 'meeting';
    if (spoken && stage === 'memory' && row.duration_seconds && row.duration_seconds > 0) {
      entry.spokenSeconds += row.duration_seconds;
      stats.spokenSeconds += row.duration_seconds;
    }

    if (spoken && row.speakers?.length) {
      const withNames = row.speakers.filter((s) => s && !UNNAMED_SPEAKER.test(s));
      for (const s of withNames) named.add(s.trim().toLowerCase());
      if (withNames.length === 0) stats.unnamedRecordings += 1;
    }

    if (stage === 'waiting' || stage === 'digesting') {
      stats.digesting.push({
        id: row.id,
        title: row.title ?? 'Sin título',
        spaceName: nameOf.get(row.collection_id) ?? '',
        stage,
        transcribing: row.transcript_status === 'transcribing',
      });
    }
  }

  stats.namedVoices = named.size;
  // Whatever is furthest along the belt goes first: it is the one about to
  // change state, and the one worth watching.
  stats.digesting.sort((a, b) => (a.stage === b.stage ? 0 : a.stage === 'digesting' ? -1 : 1));

  stats.chunks = await countChunks(db, spaceIds);

  if (options.perSpaceChunks && spaces.length <= 30) {
    const counts = await Promise.all(spaceIds.map((id) => countChunks(db, [id])));
    spaceIds.forEach((id, i) => {
      const entry = facts.get(id);
      if (entry) entry.chunkCount = counts[i] ?? null;
    });
  }

  return { spaces, facts, stats };
}

/**
 * How many retrievable fragments live in these spaces.
 *
 * A head-count through the document join rather than a fetch: the row bodies
 * are embeddings, and pulling even the ids of a large space to length them
 * would move megabytes to produce one integer. Returns null on failure so the
 * caller can omit the figure rather than claim zero.
 */
async function countChunks(db: SupabaseClient, spaceIds: string[]): Promise<number | null> {
  if (spaceIds.length === 0) return 0;
  const { count, error } = await db
    .from('kb_chunks')
    .select('id, kb_documents!inner(collection_id)', { count: 'exact', head: true })
    .in('kb_documents.collection_id', spaceIds);
  if (error) return null;
  return count ?? 0;
}
