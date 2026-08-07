/**
 * THE GATE. This is the file that runs on every change, in `pnpm test`, with no
 * key, no network and no cost, and it is the whole reason this package is not
 * just another script nobody remembers to run.
 *
 * It replays the committed measurement through the real thresholds, the real
 * `assessCoverage` and the real `rankTools`, and fails when the answers get
 * worse. Move `STRONG_MATCH`, change how a verdict becomes a sentence, retune
 * the ranker's band, rewrite a tool description — any of those moves a number
 * here before the change is merged.
 *
 * THE FLOORS ARE TODAY'S READING, NOT A TARGET. A gate set above what the system
 * does is a gate somebody disables in week two; a gate set well below it passes
 * through the regression it exists to catch. So each number below is what the
 * suite produces right now, written down, and moving one is a deliberate edit
 * with a figure in the diff — which is exactly the conversation that did not
 * happen when three quality-critical changes shipped in one afternoon.
 *
 * WHICH MEANS SOME OF THEM ARE NOT 1.00, AND THAT IS THE POINT. The first run of
 * this suite found three real defects. They are pinned here at their current
 * size rather than tuned away, so that fixing one moves a number and letting one
 * grow fails the build. `docs/operations/answer-quality.md` has the argument;
 * briefly:
 *
 *   · THE RELEVANCE CUT HAS NO MARGIN LEFT ON DOCUMENTS OF REALISTIC LENGTH.
 *     Three questions the corpus plainly answers land below `strongMatch` and
 *     come back as `thin` — "¿plan de arranque de cortex?" at 0.458 against a
 *     cut of 0.46, two thousandths short, which is the production incident
 *     happening again. `kb/relevance.ts` measured chunk-length dilution at about
 *     0.03 and set the cut with 0.029 of margin, on a corpus of eleven short
 *     documents. This corpus holds documents of the length people actually
 *     upload, and the margin is gone. A fourth question ("cuanto dan para
 *     estudiar al año") is discarded outright at 0.298, under the weak floor,
 *     over a document that states the figure.
 *
 *   · THE TOOL-SELECTION FLOOR WAS ORPHANED BY THE SAME MODEL CHANGE THAT
 *     ORPHANED THE RELEVANCE THRESHOLDS. `rank.ts` sets `MIN_FAMILY_SCORE = 0.3`
 *     and explains it with "Voyage query/document pairs land around 0.2–0.35 for
 *     unrelated text and 0.45+ for a real match". Measured here against
 *     voyage-4-lite, the highest tool/query cosine ANYWHERE in the suite — a
 *     plate lookup against `vehicles.get`, as unambiguous a match as the
 *     catalogue contains — is 0.416. Nothing reaches 0.45, because that figure
 *     was measured on voyage-3-large, which runs roughly a tenth higher (see the
 *     two tables in `kb/relevance.ts`). So a floor meant to sit just above the
 *     noise now sits inside the signal: "mandale un correo a daniela con el
 *     resumen de la reunion" scores `gmail` at 0.291 and `outlook` at 0.292
 *     against that floor of 0.30, and NO mail family reaches the model; "cual es
 *     el correo de daniela rios" puts `people.search` — the one tool whose whole
 *     job is that question — thirteenth, behind four gmail tools and
 *     `clients.register`.
 *
 * That second one is, precisely, the failure this package was commissioned
 * after: the agent saying "no puedo ayudarte con eso" with the tool in front of
 * it. It was invisible to typecheck, to the tests and to the build ten minutes
 * before this file existed, and it is a number now.
 *
 * BOTH WERE FIXED ON 2026-08-07, against these numbers, and the floors above
 * were raised to hold the result. Neither was fixed by moving the cut that
 * failed — the sweep in `kb/relevance.ts` shows every lower cut trades the
 * start-up plan for between one and five questions sold as answered, and the
 * selection floor was recalibrated against a measured distribution rather than
 * lowered until the case passed. What remains open, deliberately, is in the two
 * counts and the two failing cases below: one gold chunk still lost under the
 * weak floor at 0.298, and `people` still unreachable for "cual es el correo de
 * daniela rios" because `people.search` scores 0.177 against `clients.register`
 * at 0.233 — a tool-description defect, not a threshold one.
 *
 * THE TWO ERROR COUNTS ARE PINNED SEPARATELY FROM THE RATIOS, because a change
 * can hold `grounding` steady while turning near-misses into overclaims, and
 * only the counts show it.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_ID } from '../../kb/relevance';
import { listTools } from '../../registry';
import type { SelectableTool } from '../../tool-selection';
import { formatRun } from '../compare';
import { runEvaluation } from '../run';
import { currentToolHashes, staleRequiredTools } from '../selection';
import { SELECTION_CASES } from '../suite';
import { loadFixture } from '../vectors';

// `listTools()` is populated by the barrel's side-effect imports. Importing the
// registry alone would give an empty catalogue and a selection layer that
// silently graded nothing.
import '../../index';

const tools = listTools() as unknown as SelectableTool[];

/**
 * Measured on 2026-08-07 against voyage-4-lite. Readings, not aspirations. Each
 * floor sits a hair under its reading so that floating-point equality is not
 * what decides whether the build passes.
 *
 * RAISED 2026-08-07, AFTER THE TWO DEFECTS BELOW WERE FIXED, which is the only
 * reason a floor here is ever allowed to move: the first run read 8 of 12
 * answerable questions and 3 of 5 tool families, and both were open defects
 * rather than the state of the art. They now read 9 of 12 and 4 of 5 — the
 * start-up plan is an answer instead of a lead because a passage from a document
 * the question NAMED now outranks two thousandths of cosine (`queryNamesDocument`
 * in kb/relevance.ts), and the mail families reach the model because the
 * selection floor is calibrated per embedding model instead of hard-coded
 * (`SELECTION_CALIBRATIONS` in tool-selection/rank.ts). Leaving the old floors
 * in place would have left a fix nothing was holding on to.
 */
const FLOOR = {
  grounding: 0.74,
  restraint: 1,
  top1: 0.91,
  selectionReach: 0.79,
} as const;

/** Open defects, pinned at their current size so they cannot quietly grow. */
const KNOWN = {
  missedByFloor: 1,
  overclaimed: 0,
} as const;

describe('offline evaluation', () => {
  it('has a measurement for the embedding model this deployment runs', () => {
    // The failure this asserts on is the one that orphaned the thresholds:
    // somebody changes EMBEDDING_MODEL and every number downstream goes on
    // being computed against a scale that no longer exists. A fixture for
    // another model is not a fallback, it is coordinates in a different space.
    expect(() => loadFixture(DEFAULT_MODEL_ID)).not.toThrow();
  });

  it('finds and keeps the right material, and declines the rest', async () => {
    const run = await runEvaluation({ tier: 'offline', modelId: DEFAULT_MODEL_ID, tools });

    // Printed on failure so the diff is readable without re-running anything.
    const report = formatRun(run);

    expect(run.warnings, report).toEqual([]);
    expect(run.retrieval.grounding, report).toBeGreaterThanOrEqual(FLOOR.grounding);
    expect(run.retrieval.restraint, report).toBeGreaterThanOrEqual(FLOOR.restraint);
    expect(run.retrieval.top1, report).toBeGreaterThanOrEqual(FLOOR.top1);

    // Correct material retrieved and then thrown away by the floor. This is the
    // production bug, and the pin is a ceiling rather than a zero because it is
    // currently one — see the header. Lowering the number is a fix; raising it
    // is the incident again.
    expect(run.retrieval.missedByFloor, report).toBeLessThanOrEqual(KNOWN.missedByFloor);
    // Its opposite: a question the corpus does not answer, sold as answered.
    expect(run.retrieval.overclaimed, report).toBeLessThanOrEqual(KNOWN.overclaimed);

    expect(run.costUsd).toBe(0);
  });

  it('offers the tool that can do the job', async () => {
    const run = await runEvaluation({ tier: 'offline', modelId: DEFAULT_MODEL_ID, tools });
    expect(run.selection.reach, formatRun(run)).toBeGreaterThanOrEqual(FLOOR.selectionReach);
  });

  it('is really narrowing the catalogue, not passing by handing over everything', async () => {
    // `rankTools` opens up on every failure — no vectors, too few tools, a
    // family below the cut — and an opened-up ranking offers every family, so
    // every selection case would pass while measuring nothing at all. This is
    // the guard against a vacuously green selection score.
    const run = await runEvaluation({ tier: 'offline', modelId: DEFAULT_MODEL_ID, tools });
    const families = new Set(tools.map((t) => t.family ?? t.id.split('.')[0]));
    for (const result of run.selection.results) {
      expect(result.familiesOffered, `${result.caseId} recibió todas las familias`).toBeLessThan(
        families.size,
      );
    }
  });

  it('is grading tool descriptions that still exist', async () => {
    // A cosine measured against a sentence somebody has since rewritten is not
    // evidence about the sentence that is there now. The families the suite
    // asserts on have to be fresh or the selection score means nothing.
    const fixture = loadFixture(DEFAULT_MODEL_ID);
    const hashes = await currentToolHashes(tools);
    const stale = staleRequiredTools(SELECTION_CASES, tools, fixture, hashes);
    expect(
      stale,
      'Estas herramientas cambiaron de descripción desde la medición. Vuelve a medir con EVAL_MEASURE=1 y sube el fixture.',
    ).toEqual([]);
  });

  it('is fast enough that nobody is tempted to skip it', async () => {
    const started = Date.now();
    await runEvaluation({ tier: 'offline', modelId: DEFAULT_MODEL_ID, tools });
    // Generous on purpose: this is a guard against somebody quietly making the
    // gate call an API, not a benchmark. A run that reaches the network cannot
    // come in under this.
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
