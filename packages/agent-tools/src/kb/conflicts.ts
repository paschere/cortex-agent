import type { SupabaseClient } from '@supabase/supabase-js';
import { assessFreshness, formatDateEs } from './freshness';

/**
 * Noticing that the brain contradicts itself.
 *
 * THE CASE. The framework contract from March says the senior React rate is
 * 8.500 and the renegotiation call from July says 9.200. Both are indexed, both
 * are true of their own date, and retrieval hands them over as equals — often
 * with the older one first, because a contract is worded more like a rate card
 * than a conversation is. The answer that comes out is confident and wrong.
 *
 * WHAT VECTORS CAN AND CANNOT DO. Embeddings cannot see disagreement; "the rate
 * is 8.500" and "the rate is not 8.500" sit almost on top of each other. That
 * limitation is the mechanism here rather than an obstacle to it: two passages
 * that land on top of each other are RESTATEMENTS OF THE SAME FACT, and two
 * restatements of the same fact from documents of different dates are exactly
 * where a contradiction or an update lives. So this never decides who is right.
 * It puts both texts and both dates in front of the model, which can read, and
 * which is infinitely better placed than a cosine to tell "we raised the rate"
 * from "we also mention the rate over here".
 *
 * THE FALSE POSITIVE THAT MATTERS. Two chunks that are nearly identical are
 * usually the same thing stored twice — a re-uploaded contract, a signed scan
 * next to the original, a policy pasted into a summary. Flagging those as
 * contradictions would be worse than not flagging anything: the model would
 * hedge every single answer and the signal would be trained out of it within a
 * day. Three cuts, in order, kill that:
 *
 *   1. NEAR-DUPLICATE. Similarity at or above 0.985 is the same passage, not a
 *      second version of it. Measured on the local corpus: an identical chunk
 *      stored under two documents comes back at 1.000, while the March contract
 *      and the July call — the real conflict — sit at 0.87.
 *   2. SAME EVENT. Documents dated within a fortnight of each other are one
 *      event filed twice (a contract and its signed copy, a call and the notes
 *      from it), not a revision. A revision that genuinely happens inside two
 *      weeks is missed; that is the trade, and it is the right way round.
 *   3. NOTHING ACTUALLY CHANGED. Restating a fact is not contradicting it. The
 *      figures in both passages are compared, and a pair only survives if both
 *      sides carry figures AND they differ. A rate that appears as 8.500 in two
 *      places is agreement, and the pair is dropped.
 *
 * WHAT IS STILL ACCEPTED AS A FALSE POSITIVE, on purpose:
 *   - A later document that QUOTES an earlier one ("as agreed in March, 8.500,
 *     which now becomes 9.200") flags against it. The model sees both and
 *     resolves it in one sentence.
 *   - Two rate cards for two different clients that happen to be worded the
 *     same and carry different numbers. Rare, cheap to dismiss, and the
 *     alternative — requiring the same client — is a rule about content that
 *     this layer has no business inventing.
 *   - Purely textual contradictions with no figures in them ("the contract is
 *     exclusive" vs "it is not exclusive") are NOT caught. Cut 3 needs numbers.
 *     Catching them would mean asking a model to compare every near-neighbour
 *     pair on every search, which is not proportionate to the problem.
 */

/**
 * Below this two passages are simply about the same subject, which the whole
 * corpus is. Measured: unrelated chunks inside this corpus pair at 0.35–0.60,
 * the two versions of the Acme rate at 0.87, an identical chunk at 1.000.
 */
export const CONFLICT_MIN_SIMILARITY = 0.86;

/** At or above this it is the same passage stored twice. See cut 1 above. */
export const NEAR_DUPLICATE_SIMILARITY = 0.985;

/** Documents closer together than this are one event filed twice. See cut 2. */
export const SAME_EVENT_DAYS = 14;

/** How many rivals to look for per retrieved chunk. Three is plenty to notice. */
const CANDIDATES_PER_CHUNK = 3;

export interface ConflictSourceHit {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  chunkIndex: number;
  datedAt: string | null;
}

export interface ConflictRival {
  documentId: string;
  documentTitle: string;
  spaceName: string;
  chunkIndex: number;
  content: string;
  datedAt: string | null;
}

export interface Conflict {
  /** The chunk the search actually returned. */
  hit: ConflictSourceHit;
  /** The passage elsewhere in the brain that says almost the same thing. */
  rival: ConflictRival;
  similarity: number;
  /** Which of the two is more recent. A fact, not a verdict. */
  newer: 'hit' | 'rival';
  /** Spanish, ready to show next to the citation. */
  note: string;
}

/**
 * Every number in a passage, normalised so that "8.500" and "8500" are the same
 * figure and "1,25" is not confused with "125".
 *
 * Colombian formatting: dot groups thousands, comma is the decimal separator.
 * Speaker labels are stripped first — every diarised transcript chunk opens
 * with "Speaker 1:", and a 1 that means "the first person talking" would make
 * every recording look like it disagreed with every document.
 */
export function extractFigures(text: string): Set<string> {
  const cleaned = text.replace(/\b(?:speaker|hablante|ponente|interlocutor)\s*\d+/gi, ' ');
  const figures = new Set<string>();
  for (const match of cleaned.matchAll(/\d[\d.,]*/g)) {
    const raw = match[0].replace(/[.,]+$/, '');
    if (!raw) continue;
    let canonical: string;
    if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(raw)) {
      // 8.500 / 1.234.567,89 — dots group, comma decimates.
      canonical = raw.replace(/\./g, '').replace(',', '.');
    } else if (/^\d+,\d+$/.test(raw)) {
      canonical = raw.replace(',', '.');
    } else {
      canonical = raw.replace(/,/g, '');
    }
    const value = Number(canonical);
    if (Number.isFinite(value)) figures.add(String(value));
  }
  return figures;
}

/** Cut 3: both sides must carry figures, and the figures must differ. */
export function figuresDiverge(a: string, b: string): boolean {
  const left = extractFigures(a);
  const right = extractFigures(b);
  if (left.size === 0 || right.size === 0) return false;
  for (const f of left) if (!right.has(f)) return true;
  for (const f of right) if (!left.has(f)) return true;
  return false;
}

const DAY_MS = 86_400_000;

function daysApart(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const left = new Date(a).getTime();
  const right = new Date(b).getTime();
  if (Number.isNaN(left) || Number.isNaN(right)) return null;
  return Math.abs(left - right) / DAY_MS;
}

function shortDate(value: string | null): string {
  if (!value) return 'sin fecha';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? 'sin fecha' : formatDateEs(d);
}

export interface FindConflictsOptions {
  userId: string;
  hits: ConflictSourceHit[];
  /** Cap on how many retrieved chunks get a rival lookup. */
  maxSources?: number;
  now?: Date;
}

type CandidateRow = {
  source_chunk_id: string;
  chunk_id: string;
  document_id: string;
  document_title: string;
  space_name: string;
  chunk_index: number;
  content: string;
  dated_at: string | null;
  valid_until: string | null;
  superseded_by: string | null;
  similarity: number;
};

/**
 * Given the chunks a search returned, find the ones the rest of the brain
 * disagrees with. One RPC for the whole batch; the judgement is all here, where
 * it can be unit-tested without a database.
 *
 * Never throws: a conflict check is an enrichment of an answer that already
 * exists, and losing the whole answer because the extra probe failed would be a
 * strictly worse outcome than not mentioning the conflict.
 */
export async function findConflicts(
  db: SupabaseClient,
  { userId, hits, maxSources = 5, now = new Date() }: FindConflictsOptions,
  /** Called with the reason when the check could not run. */
  onFailure?: (reason: string) => void,
): Promise<Conflict[]> {
  const sources = hits.filter((h) => h.chunkId).slice(0, maxSources);
  if (!userId || sources.length === 0) return [];

  let rows: CandidateRow[];
  try {
    const { data, error } = await db.rpc('kb_conflict_candidates', {
      p_user_id: userId,
      p_chunk_ids: sources.map((h) => h.chunkId),
      p_min_similarity: CONFLICT_MIN_SIMILARITY,
      p_per_chunk: CANDIDATES_PER_CHUNK,
    });
    if (error) throw error;
    rows = (data as CandidateRow[]) ?? [];
  } catch (err) {
    onFailure?.((err as Error).message ?? 'the conflict lookup failed');
    return [];
  }

  const byChunkId = new Map(sources.map((h) => [h.chunkId, h]));
  const conflicts: Conflict[] = [];
  // One flag per pair of DOCUMENTS: three chunks of the same contract landing
  // against three chunks of the same call is one disagreement, said once.
  const seenPairs = new Set<string>();

  for (const row of rows) {
    const hit = byChunkId.get(row.source_chunk_id);
    if (!hit) continue;

    const similarity = Number(row.similarity);
    // Cut 1 — the same passage stored twice.
    if (similarity >= NEAR_DUPLICATE_SIMILARITY) continue;

    // Cut 2 — one event, filed twice. An undated side cannot be ruled out this
    // way, so it is let through: not knowing when something was written is a
    // reason to look, not a reason to stay quiet.
    const gap = daysApart(hit.datedAt, row.dated_at);
    if (gap !== null && gap < SAME_EVENT_DAYS) continue;

    // Cut 3 — a restatement that changes no number is agreement.
    const rivalHit = sources.find((s) => s.chunkId === row.source_chunk_id);
    if (!rivalHit) continue;
    const sourceText = sourceTextOf(hits, row.source_chunk_id);
    if (sourceText !== null && !figuresDiverge(sourceText, row.content)) continue;

    const pairKey = [hit.documentId, row.document_id].sort().join('|');
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);

    const hitTime = hit.datedAt ? new Date(hit.datedAt).getTime() : Number.NaN;
    const rivalTime = row.dated_at ? new Date(row.dated_at).getTime() : Number.NaN;
    const newer: 'hit' | 'rival' =
      Number.isNaN(hitTime) || Number.isNaN(rivalTime)
        ? 'hit'
        : rivalTime > hitTime
          ? 'rival'
          : 'hit';

    const rivalFreshness = assessFreshness({
      datedAt: row.dated_at,
      validUntil: row.valid_until,
      now,
    });

    const newerTitle = newer === 'rival' ? row.document_title : hit.documentTitle;
    const newerDate = shortDate(newer === 'rival' ? row.dated_at : hit.datedAt);

    conflicts.push({
      hit,
      rival: {
        documentId: row.document_id,
        documentTitle: row.document_title,
        spaceName: row.space_name,
        chunkIndex: row.chunk_index,
        content: row.content,
        datedAt: row.dated_at,
      },
      similarity: Number(similarity.toFixed(3)),
      newer,
      note:
        `«${hit.documentTitle}» (${shortDate(hit.datedAt)}) y «${row.document_title}» (${shortDate(row.dated_at)}) ` +
        `dicen cosas distintas sobre lo mismo. La versión más reciente es «${newerTitle}» (${newerDate})` +
        (rivalFreshness.status === 'expired' || rivalFreshness.status === 'superseded'
          ? `; además «${row.document_title}» está ${rivalFreshness.label}`
          : '') +
        '. Contrástalas antes de dar una cifra por buena.',
    });
  }

  return conflicts;
}

/**
 * The text of a retrieved chunk, which `findConflicts` needs for the figure
 * test but which callers do not always carry on the same object.
 */
let sourceTexts = new WeakMap<object, Map<string, string>>();

export function rememberSourceText(hits: ConflictSourceHit[], texts: Map<string, string>): void {
  sourceTexts.set(hits, texts);
}

function sourceTextOf(hits: ConflictSourceHit[], chunkId: string): string | null {
  return sourceTexts.get(hits)?.get(chunkId) ?? null;
}

/** Test seam: drops every remembered text so cases cannot leak into each other. */
export function resetSourceTexts(): void {
  sourceTexts = new WeakMap();
}
