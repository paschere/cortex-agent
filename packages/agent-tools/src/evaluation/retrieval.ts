/**
 * Layer 1 — did the right material come back, and was it kept.
 *
 * THIS IS THE CHEAP LAYER AND THE ONE THAT CATCHES THE MOST. No model is
 * called, nothing is judged, and every number here is a count. It grades the
 * exact decision that shipped broken: a chunk came back FIRST, scored 0.436,
 * and was discarded because the floor was 0.45, so the screen said "no tiene
 * nada de esto" over the one document that answered the question.
 *
 * IT USES THE REAL CODE. `assessCoverage` and `calibrationFor` are imported,
 * not reimplemented. The point of the exercise is to be wrong in CI whenever
 * production would be wrong, and a grader with its own copy of the thresholds
 * would be green on the day they were mis-set. The only thing this file
 * fabricates is the hit objects, and it fabricates them from measured cosines.
 *
 * TWO FAILURES, COUNTED SEPARATELY, NEVER NETTED.
 *
 *   missedByFloor  The gold chunk was retrieved and thrown away. Lower the
 *                  floor and this goes to zero — and `overclaimed` goes up.
 *   overclaimed    A question the corpus does not answer came back `answered`.
 *                  Raise the floor and this goes to zero — and `missedByFloor`
 *                  goes up.
 *
 * A single accuracy figure moves smoothly while a system trades one for the
 * other, which is how a change that helps nobody looks like progress. So both
 * are reported, both are in the run record, and `compare` shows both deltas.
 *
 * WHAT "CORRECT COVERAGE" MEANS PER GROUP, AND WHY `absent` IS LENIENT ABOUT
 * `thin`. For `answered`, only `answered` is right. For `absent`, both `thin`
 * and `nothing` are right and `answered` is wrong — because the neighbouring
 * document genuinely IS the one to read, it simply has no line for the
 * question, and demanding `nothing` there would push the floor up until real
 * questions started failing. That is precisely the trade `kb/relevance.ts`
 * argues about at length, and this grader takes the same side. For `unrelated`,
 * only `nothing` is right: there is no document to read.
 */

import { assessCoverage, calibrationFor } from '../kb/relevance';
import type { SpaceHit } from '../kb/spaces';
import type { CorpusChunk } from './corpus';
import type { EvalCase, RetrievalCaseResult, RetrievalScore } from './types';

/** How many hits a search returns. Matches `searchSpaces`' default. */
export const RETRIEVAL_LIMIT = 8;

/**
 * Build the hit list a search would have produced, from measured cosines.
 *
 * `keywordScore` is zero throughout and `score` is the cosine alone: the replay
 * is semantic-only, for the reason set out in `vectors.ts`. Zero is the honest
 * value — it is what `ts_rank` returns for most rows anyway — and it keeps the
 * blend from pretending to a precision the replay does not have.
 */
export function replayHits(
  chunks: readonly CorpusChunk[],
  cosines: readonly number[],
  limit = RETRIEVAL_LIMIT,
  modelId?: string,
): SpaceHit[] {
  return chunks
    .map((chunk, i) => ({ chunk, cosine: cosines[i] ?? 0 }))
    .sort((a, b) => b.cosine - a.cosine)
    .slice(0, limit)
    .map(({ chunk, cosine }) => {
      return {
        documentId: chunk.documentId,
        documentTitle: chunk.documentTitle,
        spaceId: `space-${chunk.space}`,
        spaceName: chunk.space,
        spaceKind: 'global' as const,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        score: cosine,
        chunkId: `${chunk.documentId}:${chunk.chunkIndex}`,
        semanticScore: cosine,
        keywordScore: 0,
        embeddingModel: modelId ?? null,
        datedAt: chunk.datedAt,
        validUntil: null,
        supersededById: null,
        supersededByTitle: null,
        metadata: {},
      } satisfies SpaceHit;
    });
}

/** Which coverage verdicts are acceptable for a group. */
function acceptableCoverage(group: EvalCase['group']): ReadonlySet<string> {
  if (group === 'answered') return new Set(['answered']);
  if (group === 'absent') return new Set(['thin', 'nothing']);
  return new Set(['nothing']);
}

export function gradeRetrievalCase(
  evalCase: EvalCase,
  hits: SpaceHit[],
  modelId: string,
): RetrievalCaseResult {
  const verdict = assessCoverage(hits, { query: evalCase.query, embeddingModel: modelId });

  const gold = new Set(evalCase.gold);
  const goldIndex = hits.findIndex((h) => gold.has(h.documentId));
  const goldRank = goldIndex === -1 ? null : goldIndex + 1;
  const goldScore = hits
    .filter((h) => gold.has(h.documentId))
    .reduce<number | null>((best, h) => {
      const s = h.semanticScore;
      if (s === null) return best;
      return best === null || s > best ? s : best;
    }, null);
  const goldKept = verdict.kept.some((k) => gold.has(k.hit.documentId));

  const coverageCorrect = acceptableCoverage(evalCase.group).has(verdict.coverage);
  // Retrieved and then discarded — the shape of the production failure. Only
  // meaningful when there IS a gold document to lose.
  const missedByFloor = gold.size > 0 && goldRank !== null && !goldKept;
  const overclaimed = gold.size === 0 && verdict.coverage === 'answered';

  // An `answered` case has to do two things: keep the gold material, and reach
  // the `answered` verdict. Keeping it under a `thin` verdict is still a
  // failure — the model is told the material does not answer the question, so
  // it will hedge over the document that does.
  const passed = evalCase.group === 'answered' ? goldKept && coverageCorrect : coverageCorrect;

  return {
    caseId: evalCase.id,
    group: evalCase.group,
    query: evalCase.query,
    goldRank,
    goldKept,
    bestScore: verdict.bestScore,
    goldScore,
    coverage: verdict.coverage,
    coverageCorrect,
    missedByFloor,
    overclaimed,
    passed,
  } satisfies RetrievalCaseResult;
}

/** Kept exported so a caller can print the cuts a grade was reached on. */
export { calibrationFor };

function ratio(hit: number, of: number): number {
  return of === 0 ? 1 : hit / of;
}

export function scoreRetrieval(results: RetrievalCaseResult[]): RetrievalScore {
  const answerable = results.filter((r) => r.group === 'answered');
  const unanswerable = results.filter((r) => r.group !== 'answered');
  return {
    cases: results.length,
    top1: ratio(answerable.filter((r) => r.goldRank === 1).length, answerable.length),
    recall: ratio(answerable.filter((r) => r.goldRank !== null).length, answerable.length),
    grounding: ratio(answerable.filter((r) => r.passed).length, answerable.length),
    restraint: ratio(unanswerable.filter((r) => r.passed).length, unanswerable.length),
    missedByFloor: results.filter((r) => r.missedByFloor).length,
    overclaimed: results.filter((r) => r.overclaimed).length,
    results,
  };
}
