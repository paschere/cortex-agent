import type { SupabaseClient } from '@supabase/supabase-js';
import { assessFreshness, formatDateEs, isSuperseded } from './freshness';

/**
 * Noticing when the brain contradicts itself.
 *
 * THE CASE. The framework contract from March says the senior React rate is
 * 8.500 and the renegotiation call from July says 9.200. Both are indexed, both
 * were true on their own date, and retrieval hands them over as equals — often
 * with the older one first, because a contract is worded more like a rate card
 * than a conversation is. The answer that comes out is confident and wrong.
 *
 * WHAT VECTORS CAN AND CANNOT DO. Embeddings cannot see disagreement; "the rate
 * is 8.500" and "the rate is not 8.500" sit almost on top of each other. That
 * limitation is the mechanism here rather than an obstacle to it: two passages
 * that land on top of each other are RESTATEMENTS OF THE SAME FACT, and two
 * restatements from documents of different dates are exactly where an update or
 * a contradiction lives. So nothing here decides who is right. It puts both
 * texts and both dates in front of the model, which can read, and which is far
 * better placed than a cosine to tell "we raised the rate" from "we happen to
 * mention the rate over here too".
 *
 * THE MEASUREMENT. Every cross-document chunk pair in the ten-document test
 * corpus, by cosine similarity:
 *
 *   1.0000  the contract and its signed scan — the same passage, twice
 *   0.8590  the March contract rates × the July call rates — THE conflict
 *   0.7758  vacation policy × payroll manual        ) same subject area,
 *   0.7557  private-health benefit × payroll manual ) different facts,
 *   0.7495  the contract's payment terms × the call's payment terms
 *   0.7467  onboarding guide × recruiting playbook  ) no disagreement
 *   …and everything else below 0.75
 *
 * The band between 0.776 (the highest pair that is NOT a conflict) and 0.859
 * (the conflict) is where the cut belongs, so it sits at 0.82. That does miss
 * the second real conflict in the corpus — the payment terms moving from 30 to
 * 45 days pair at only 0.7495 — and lowering the cut to catch it would drag in
 * four unrelated pairs first. Missing a conflict costs the status quo; inventing
 * them costs the signal itself, because a model that is warned about everything
 * stops reading the warnings.
 *
 * THE FALSE POSITIVE THAT MATTERS. Two nearly identical chunks are usually the
 * same thing stored twice — a re-uploaded contract, a signed scan beside the
 * original, a policy pasted into a summary. Three cuts, in order, kill those:
 *
 *   1. NEAR-DUPLICATE, at 0.985. Measured: an identical chunk under two
 *      documents comes back at 1.0000 while the real conflict sits at 0.859, so
 *      anything from 0.87 up would work; 0.985 is chosen to leave room for a
 *      scan or an OCR pass of the same page, which differs by a few characters
 *      and lands around 0.99.
 *   2. SAME EVENT, at 14 days. Documents dated within a fortnight are one event
 *      filed twice — the contract (5 March) and its signed copy (11 March) are
 *      6 days apart. A genuine revision inside two weeks is missed; that is the
 *      trade and it is the right way round.
 *   3. NOTHING ACTUALLY CHANGED. Restating a fact is not contradicting it, so
 *      the figures in both passages are compared and a pair only survives if
 *      both carry figures AND they differ. 8.500 in two places is agreement.
 *
 * WHAT IS STILL ACCEPTED AS A FALSE POSITIVE, on purpose:
 *   - A later document that QUOTES an earlier one ("as agreed in March, 8.500,
 *     which now becomes 9.200") flags against it. The model sees both and
 *     resolves it in one sentence — the flag was even useful.
 *   - Two rate cards for two different clients, worded the same, with different
 *     numbers. Rare, cheap to dismiss, and the alternative — a rule about which
 *     client a document belongs to — is content knowledge this layer has no
 *     business inventing.
 *   - Contradictions with no figures in them ("the contract is exclusive" vs
 *     "it is not exclusive") are NOT caught at all. Cut 3 needs numbers.
 *     Catching them would mean asking a model to compare every near-neighbour
 *     pair on every search, which is not proportionate.
 *   - A document filed twice raises the same disagreement twice: the contract
 *     and its signed scan are correctly NOT flagged against each other, but
 *     each is separately flagged against the July call. Observed end to end on
 *     the test corpus. Collapsing them would mean deciding that two documents
 *     are "the same document", which is a claim about the corpus rather than
 *     about this pair, and the second note is a repetition rather than a lie.
 */

/**
 * Below this, two passages are merely about the same subject — which, inside
 * one company's brain, nearly everything is. Measured cut: see above.
 */
export const CONFLICT_MIN_SIMILARITY = 0.82;

/** At or above this it is the same passage stored twice, not a new version. */
export const NEAR_DUPLICATE_SIMILARITY = 0.985;

/** Documents closer together in time than this are one event filed twice. */
export const SAME_EVENT_DAYS = 14;

/** Rivals to look for per retrieved chunk. Three is plenty to notice a change. */
const CANDIDATES_PER_CHUNK = 3;

/** How many of the retrieved chunks get a rival lookup, at one probe each. */
const DEFAULT_MAX_SOURCES = 5;

export interface ConflictSourceHit {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  chunkIndex: number;
  /** The document's own date — `recorded_at` if it has one, else `created_at`. */
  datedAt: string | null;
  /** The passage itself. Cut 3 compares the figures in it. */
  content: string;
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
  /** The chunk the search returned. */
  hit: ConflictSourceHit;
  /** The passage elsewhere in the brain that restates it differently. */
  rival: ConflictRival;
  similarity: number;
  /** Which of the two is more recent. A fact, not a verdict. */
  newer: 'hit' | 'rival';
  /** Colombian Spanish, ready to show next to the citation. */
  note: string;
}

/**
 * Every number in a passage, normalised so that "8.500" and "8500" are one
 * figure and "1,25" is not read as "125".
 *
 * Colombian formatting: the dot groups thousands, the comma is the decimal
 * separator. Speaker labels are stripped first — every diarised transcript
 * chunk opens with "Speaker 1:", and a 1 that means "the first person talking"
 * would make every recording look like it disagreed with every document.
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
 * disagrees with. One RPC for the whole batch; every judgement is made here,
 * where it can be tested without a database.
 *
 * NEVER THROWS. A conflict check enriches an answer that already exists, so
 * losing the answer because the extra probe failed would be strictly worse than
 * not mentioning the conflict. The reason goes to the caller's logger instead.
 */
export async function findConflicts(
  db: SupabaseClient,
  { userId, hits, maxSources = DEFAULT_MAX_SOURCES, now = new Date() }: FindConflictsOptions,
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

  const bySourceId = new Map(sources.map((h) => [h.chunkId, h]));
  const conflicts: Conflict[] = [];
  // One flag per pair of DOCUMENTS: three chunks of the same contract landing
  // against three chunks of the same call is one disagreement, said once.
  const seenPairs = new Set<string>();

  for (const row of rows) {
    const hit = bySourceId.get(row.source_chunk_id);
    if (!hit) continue;

    const similarity = Number(row.similarity);
    // Cut 1 — the same passage stored twice.
    if (!Number.isFinite(similarity) || similarity >= NEAR_DUPLICATE_SIMILARITY) continue;

    // Cut 2 — one event, filed twice. An undated side cannot be ruled out this
    // way, so it is let through: not knowing when something was written is a
    // reason to look, not a reason to stay quiet.
    const gap = daysApart(hit.datedAt, row.dated_at);
    if (gap !== null && gap < SAME_EVENT_DAYS) continue;

    // Cut 3 — a restatement that changes no number is agreement.
    if (!figuresDiverge(hit.content, row.content)) continue;

    const pairKey = [hit.documentId, row.document_id].sort().join('|');
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);

    const hitTime = hit.datedAt ? new Date(hit.datedAt).getTime() : Number.NaN;
    const rivalTime = row.dated_at ? new Date(row.dated_at).getTime() : Number.NaN;
    // With a date missing on either side there is no "more recent", so the
    // retrieved hit is named and the note says the dates instead of asserting
    // an order that was never established.
    const newer: 'hit' | 'rival' =
      Number.isNaN(hitTime) || Number.isNaN(rivalTime)
        ? 'hit'
        : rivalTime > hitTime
          ? 'rival'
          : 'hit';
    const datesKnown = !Number.isNaN(hitTime) && !Number.isNaN(rivalTime);

    const rivalFreshness = assessFreshness({
      datedAt: row.dated_at,
      validUntil: row.valid_until,
      now,
    });

    const newerTitle = newer === 'rival' ? row.document_title : hit.documentTitle;
    const newerDate = shortDate(newer === 'rival' ? row.dated_at : hit.datedAt);
    const which = datesKnown
      ? `La versión más reciente es «${newerTitle}» (${newerDate})`
      : 'No hay fecha en las dos, así que no se puede decir cuál manda';
    const replacedNote = isSuperseded(rivalFreshness.status)
      ? `; además «${row.document_title}» está ${rivalFreshness.label}`
      : '';

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
      note: `«${hit.documentTitle}» (${shortDate(hit.datedAt)}) y «${row.document_title}» (${shortDate(row.dated_at)}) dicen cosas distintas sobre lo mismo. ${which}${replacedNote}. Contrasta las dos antes de dar una cifra por buena, y di de cuándo es la que uses.`,
    });
  }

  return conflicts;
}
