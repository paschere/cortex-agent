/**
 * The two tiers that reach the network, run by hand.
 *
 *   set -a; source .env.local; set +a
 *   EVAL_LIVE=1    pnpm --filter @cortex/agent-tools exec vitest run src/evaluation
 *   EVAL_ANSWERS=1 pnpm --filter @cortex/agent-tools exec vitest run src/evaluation
 *
 * `EVAL_LIVE` re-embeds the suite and grades retrieval and selection on today's
 * numbers instead of the committed ones. It is what to run when the provider,
 * the model or the chunker moves — a stored cosine cannot notice that the model
 * behind a name changed, and this is the only thing that can.
 *
 * `EVAL_ANSWERS` also generates an answer per question and judges it. Measured
 * on 2026-08-07: fifteen minutes and USD 0.38 for twenty-two answers, twenty-two
 * judgements and nine calibration probes. Run it before a model change, a prompt
 * change, or a release — and READ THE REPORT, which prints every failed
 * criterion next to the sentence that failed it. The first run scored 42%
 * grounding and 40% restraint, and reading the transcripts is the only way to
 * tell how much of that is the system and how much is a rubric written too
 * tightly. That reading is the work; the number is only what starts it.
 *
 * BOTH SKIP BY DEFAULT AND THAT IS DELIBERATE. CI has no keys, and a gate that
 * reaches a paid API fails on somebody else's outage and gets disabled by the
 * third person it inconveniences. The gate is `offline.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_ID } from '../../kb/relevance';
import { listTools } from '../../registry';
import type { SelectableTool } from '../../tool-selection';
import { formatRun } from '../compare';
import { runEvaluation } from '../run';
import '../../index';

const live = process.env.EVAL_LIVE === '1';
const answers = process.env.EVAL_ANSWERS === '1';

describe.skipIf(!live)('live retrieval and selection', () => {
  it(
    'still finds what it found the day it was measured',
    async () => {
      const run = await runEvaluation({
        tier: 'live',
        modelId: DEFAULT_MODEL_ID,
        tools: listTools() as unknown as SelectableTool[],
        log: (l) => console.log(l),
      });
      console.log(formatRun(run));
      expect(run.retrieval.missedByFloor, formatRun(run)).toBe(0);
      expect(run.retrieval.overclaimed, formatRun(run)).toBe(0);
    },
    30 * 60_000,
  );
});

describe.skipIf(!answers)('answers, judged', () => {
  it(
    'answers what it can and declines what it cannot',
    async () => {
      const run = await runEvaluation({
        tier: 'answers',
        modelId: DEFAULT_MODEL_ID,
        tools: listTools() as unknown as SelectableTool[],
        log: (l) => console.log(l),
      });
      console.log(formatRun(run));

      // THE ONLY ASSERTION IS ABOUT THE INSTRUMENT, NOT THE READING, and that is
      // deliberate. A numeric floor on this tier would be one of two things: a
      // figure invented today, which is theatre, or a figure copied from one
      // previous run, which is noise — the chat model takes no temperature on
      // this account, so the same configuration does not produce the same score
      // twice. The right instrument for "did this get worse" here is
      // `compareRuns` against a stored baseline, which withholds the answer
      // deltas by itself when either judge failed its probes.
      //
      // What CAN be asserted is that the judge earned the right to be believed.
      // If it waved a deliberately wrong answer through, or failed a correct
      // one, every number printed above is a summary of the judge's mood and
      // there is nothing to read. That is a hard failure, and it is the one
      // thing about this tier that is exactly reproducible.
      expect(
        run.answers?.judge.trusted,
        `El juez falló su propia calibración: ${JSON.stringify(run.answers?.judge.failures)}`,
      ).toBe(true);

      // A run that graded nothing must not look like a run that graded well.
      expect(run.answers?.cases).toBeGreaterThan(0);
    },
    30 * 60_000,
  );
});
