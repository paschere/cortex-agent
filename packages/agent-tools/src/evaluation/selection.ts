/**
 * Layer 2 — was the tool that can answer this even offered to the model.
 *
 * THE FAILURE THIS GRADES. Cortex answered "no puedo ayudarte con eso" about
 * things it had been granted, could reach, and had a working tool for: the
 * `vehicles` family was registered and matched by no selection pattern, so it
 * was filtered out of every single request. Nothing threw. The tool tests
 * passed, because the tool worked. The only observable symptom was a sentence,
 * and sentences are not asserted on anywhere.
 *
 * OBJECTIVE, LIKE LAYER 1. `rankTools` is pure — a query vector, a map of tool
 * vectors, and a set of always-on families — so replaying it from measured
 * cosines is exact, not an approximation. The real function decides; this file
 * only asks it the question and counts.
 *
 * WHY THE ASSERTION IS ABOUT A FAMILY AND NOT A TOOL. Families travel whole:
 * `rankTools` scores every tool, aggregates to the family by max, and sends the
 * winning families entire. So "was `gmail` offered" is the decision that
 * actually gets made, and "was `gmail.send` offered" would be asserting on a
 * consequence of it.
 *
 * WHY THE SUITE'S SELECTION CASES ARE ALL NON-KB. `BASE_FAMILIES` — kb, cortex,
 * web, pipeline, schedule, format — are sent on every turn by construction and
 * are never ranked. Asserting that `kb` was offered would be asserting that a
 * constant is itself: green forever, and worth nothing. Every case here names a
 * family that has to WIN its way in.
 *
 * ONE HONEST LIMITATION, STATED RATHER THAN HIDDEN. `rankTools` includes tools
 * it has no vector for — deliberately, because failure in this module must
 * always open rather than close. A replay in which most tools are unembedded
 * would therefore score near-perfectly while measuring nothing. So the grader
 * counts tools whose embed text has drifted from the measurement and reports
 * `staleTools`, and the CI gate additionally requires that the families the
 * suite names are all fresh. A stale ranking is not graded as a pass.
 */

import {
  BASE_FAMILIES,
  type SelectableTool,
  rankTools,
  toolEmbedText,
  toolFamily,
} from '../tool-selection';
import { cosine as dot } from '../tool-selection/rank';
import { hashText } from '../tool-selection/store';
import type { EvalCase, SelectionCaseResult, SelectionScore } from './types';
import type { VectorFixture } from './vectors';

/**
 * A ranking replayed from stored cosines.
 *
 * `rankTools` wants vectors so it can compute cosines; the fixture stores the
 * cosines it would have computed. Rather than reimplement the ranker to take
 * scores — which would mean grading a copy of the logic instead of the logic —
 * each tool is handed a one-dimensional unit vector whose dot product with a
 * one-dimensional query vector of `[1]` is exactly its measured cosine. The
 * ranker is unchanged, its arithmetic is unchanged, and `cosine()` guards on
 * length rather than dimension, so this is exact rather than a trick that
 * happens to work.
 */
function replayVectors(
  fixture: VectorFixture,
  query: string,
  tools: readonly SelectableTool[],
): Map<string, readonly number[]> {
  const vectors = new Map<string, readonly number[]>();
  for (const tool of tools) {
    const entry = fixture.tools[tool.id];
    const score = entry?.scores[query];
    if (typeof score === 'number') vectors.set(tool.id, [score]);
  }
  return vectors;
}

const QUERY_VECTOR: readonly number[] = [1];

export interface SelectionGradeInput {
  cases: readonly EvalCase[];
  tools: readonly SelectableTool[];
  fixture: VectorFixture;
  /** Hash of each tool's current embed text. Async, so the caller supplies it. */
  currentHashes: ReadonlyMap<string, string>;
}

/** Recompute today's embed-text hash for every tool, to detect drift. */
export async function currentToolHashes(
  tools: readonly SelectableTool[],
): Promise<Map<string, string>> {
  const entries = await Promise.all(
    tools.map(async (t) => [t.id, await hashText(toolEmbedText(t))] as const),
  );
  return new Map(entries);
}

export function gradeSelection({
  cases,
  tools,
  fixture,
  currentHashes,
}: SelectionGradeInput): SelectionScore {
  const always = new Set(BASE_FAMILIES);
  const staleTools = tools.filter((t) => {
    const stored = fixture.tools[t.id];
    return !!stored && stored.textHash !== currentHashes.get(t.id);
  }).length;

  const results: SelectionCaseResult[] = cases
    .filter((c): c is EvalCase & { needsFamily: string } => !!c.needsFamily)
    .map((c) => {
      const vectors = replayVectors(fixture, c.query, tools);
      const ranked = rankTools({
        tools: [...tools],
        queryVector: QUERY_VECTOR,
        vectors,
        alwaysFamilies: always,
      });
      const offered = new Set(ranked.tools.map((t) => toolFamily(t)));
      const familyScore =
        ranked.familyScores.find((f) => f.family === c.needsFamily)?.score ?? null;
      return {
        caseId: c.id,
        query: c.query,
        needsFamily: c.needsFamily,
        offered: offered.has(c.needsFamily),
        familyScore,
        familiesOffered: offered.size,
        passed: offered.has(c.needsFamily),
      } satisfies SelectionCaseResult;
    });

  return {
    cases: results.length,
    reach: results.length === 0 ? 1 : results.filter((r) => r.passed).length / results.length,
    staleTools,
    results,
  };
}

/**
 * Tools belonging to a family the suite asserts on, whose text has drifted.
 *
 * Separated from the overall `staleTools` count because the two mean different
 * things. A drifted `hubspot` description makes the fixture a little out of
 * date; a drifted `vehicles` description makes the `vehicles` case meaningless,
 * since a cosine measured against a sentence that no longer exists is not
 * evidence about the sentence that does. The CI gate fails on this list and
 * merely reports the other.
 */
export function staleRequiredTools(
  cases: readonly EvalCase[],
  tools: readonly SelectableTool[],
  fixture: VectorFixture,
  currentHashes: ReadonlyMap<string, string>,
): string[] {
  const required = new Set(cases.map((c) => c.needsFamily).filter((f): f is string => !!f));
  return tools
    .filter((t) => required.has(toolFamily(t)))
    .filter((t) => {
      const stored = fixture.tools[t.id];
      return !stored || stored.textHash !== currentHashes.get(t.id);
    })
    .map((t) => t.id);
}

/** Re-exported so the measurement and the grader cannot disagree about it. */
export { dot as replayCosine };
