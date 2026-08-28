/**
 * One run: what it costs, what it fixes, and what it lets vary.
 *
 * THREE TIERS, AND THE ONLY INTERESTING QUESTION IS WHICH ONE RUNS WHEN.
 *
 *   offline   Replays a stored measurement. No network, no key, no money, about
 *             a second. Grades retrieval and selection. RUNS IN `pnpm test`, on
 *             every change, like any other test. This is the tier that would
 *             have caught all three of the failures this package was written
 *             after, and it is the only one whose value depends on nobody having
 *             to remember it.
 *   live      Re-measures against the provider's API first, then grades the same
 *             way. Catches what a stored number cannot: the provider changed the
 *             model behind a name, the key is dead, the corpus embeds
 *             differently than it did. Tens of seconds, a fraction of a cent,
 *             by hand — before merging a change to embedding or chunking.
 *   answers   Everything above, plus generating an answer per case and judging
 *             it. Minutes, tens of cents, by hand — before a model change, a
 *             prompt change, or a release.
 *
 * WHAT IS FIXED AND WHAT VARIES, WHICH IS THE WHOLE QUESTION OF REPRODUCIBILITY.
 * Fixed: the corpus bytes, the questions, their groups and gold documents, the
 * chunker and its defaults, the retrieval depth, the order every list is built
 * in, the judge prompt, the grounding prompt. Varying: the thresholds, the
 * embedding model, the tool catalogue and its descriptions, the ranker's
 * constants, the chat model — every one of which is a thing somebody changes
 * on a Tuesday afternoon. `RunIdentity` records all of them, and `compare`
 * refuses two runs whose `suiteDigest` differs rather than subtracting numbers
 * that were never about the same thing.
 *
 * SAMPLING IS NOT PINNED, BECAUSE IT CANNOT BE. Layer 3 calls a model that has
 * no temperature control on this account (see `model.ts` — the family rejects
 * the parameter outright), so two `answers` runs of the same configuration will
 * differ a little. That is a real limit and the honest response is not to
 * pretend otherwise: layers 1 and 2 are exactly reproducible and are where the
 * gates live, layer 3 is a reading with noise in it and is reported as such.
 * A one-case difference in a twenty-two-case layer is noise, not a regression.
 */

import { listTools } from '../registry';
import type { SelectableTool } from '../tool-selection';
import {
  ANSWER_MODEL,
  ANSWER_PROMPT_DIGEST,
  GROUNDING_PROMPT,
  gradeAnswerCase,
  produceAnswer,
  scoreAnswers,
} from './answer';
import { corpusChunks } from './corpus';
import { JUDGE_MODEL, JUDGE_PROMPT_DIGEST, calibrateJudge } from './judge';
import { measure } from './measure';
import {
  RETRIEVAL_LIMIT,
  calibrationFor,
  gradeRetrievalCase,
  replayHits,
  scoreRetrieval,
} from './retrieval';
import { currentToolHashes, gradeSelection, staleRequiredTools } from './selection';
import {
  ANSWER_CASES,
  RETRIEVAL_CASES,
  SELECTION_CASES,
  SUITE_ID,
  suiteDigest,
  suiteQueries,
} from './suite';
import type { AnswerCaseResult, EvalRun, EvalTier, RetrievalCaseResult } from './types';
import { type VectorFixture, fixtureDrift, loadFixture } from './vectors';

/** Claude Sonnet 5, USD per million tokens. Used only for the cost line. */
const CHAT_PRICE = { input: 3, output: 15 } as const;

export interface RunOptions {
  tier: EvalTier;
  /** The embedding model whose measurement to grade against. */
  modelId: string;
  /** The catalogue the selection layer ranks. Defaults to everything registered. */
  tools?: readonly SelectableTool[];
  /** Supply a fixture instead of reading one — used by `live`, and by tests. */
  fixture?: VectorFixture;
  log?: (line: string) => void;
}

export async function runEvaluation({
  tier,
  modelId,
  tools = listTools() as unknown as SelectableTool[],
  fixture,
  log = () => {},
}: RunOptions): Promise<EvalRun> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const warnings: string[] = [];
  let costUsd = 0;

  let measured: VectorFixture;
  if (fixture) {
    measured = fixture;
  } else if (tier === 'offline') {
    measured = loadFixture(modelId);
  } else {
    measured = await measure({ tools, log });
    costUsd += measured.usage.usd;
  }

  const digest = suiteDigest();
  warnings.push(...fixtureDrift(measured, digest, suiteQueries()));

  /* ------------------------------------------------------------ retrieval */
  const chunks = corpusChunks();
  if (chunks.length !== measured.chunks.length) {
    warnings.push(
      `El corpus produce ${chunks.length} fragmentos y la medición tiene ${measured.chunks.length}. Los cosenos ya no corresponden a los fragmentos: hay que volver a medir.`,
    );
  }
  const retrievalResults: RetrievalCaseResult[] = RETRIEVAL_CASES.map((c) => {
    const cosines = measured.queries[c.query] ?? [];
    const hits = replayHits(chunks, cosines, RETRIEVAL_LIMIT, measured.modelId);
    return gradeRetrievalCase(c, hits, measured.modelId);
  });
  const retrieval = scoreRetrieval(retrievalResults);

  /* ------------------------------------------------------------ selection */
  const hashes = await currentToolHashes(tools);
  const stale = staleRequiredTools(SELECTION_CASES, tools, measured, hashes);
  if (stale.length > 0) {
    warnings.push(
      `${stale.length} herramienta(s) de las familias que evalúa la selección cambiaron de descripción desde la medición (${stale.slice(0, 4).join(', ')}${stale.length > 4 ? '…' : ''}). El puntaje de selección está midiendo un texto que ya no existe: vuelve a medir.`,
    );
  }
  const selection = gradeSelection({
    cases: SELECTION_CASES,
    tools,
    fixture: measured,
    currentHashes: hashes,
  });

  /* --------------------------------------------------------------- answers */
  let answers: EvalRun['answers'] = null;
  if (tier === 'answers') {
    log('Calibrando el juez contra las sondas…');
    const judge = await calibrateJudge();
    if (!judge.trusted) {
      warnings.push(
        `El juez no pasó su propia calibración (indulgencia ${judge.leniency.toFixed(2)}, severidad ${judge.severity.toFixed(2)}). Los números de la capa de respuestas NO son de fiar en esta corrida.`,
      );
    }

    const results: AnswerCaseResult[] = [];
    for (const c of ANSWER_CASES) {
      const cosines = measured.queries[c.query] ?? [];
      const hits = replayHits(chunks, cosines, RETRIEVAL_LIMIT, measured.modelId);
      const produced = await produceAnswer(c.query, hits, measured.modelId, GROUNDING_PROMPT);
      costUsd +=
        (produced.usage.input / 1_000_000) * CHAT_PRICE.input +
        (produced.usage.output / 1_000_000) * CHAT_PRICE.output;
      results.push(
        await gradeAnswerCase({
          evalCase: c,
          query: c.query,
          answer: produced.answer,
          material: produced.material,
        }),
      );
      log(
        `Respuesta ${results.length}/${ANSWER_CASES.length}: ${c.id} → ${results[results.length - 1]?.passed ? 'bien' : 'mal'}`,
      );
    }
    answers = scoreAnswers(results, judge);
  }

  const calibration = calibrationFor(measured.modelId);
  if (!calibration.measured) {
    warnings.push(
      `Los umbrales de relevancia de «${measured.modelId}» no están medidos (ver kb/relevance.ts). Toda la capa de recuperación se está calificando contra cortes provisionales.`,
    );
  }

  return {
    identity: {
      suiteId: SUITE_ID,
      suiteDigest: digest,
      embeddingModel: measured.modelId,
      calibration,
      chatModel: tier === 'answers' ? ANSWER_MODEL : null,
      judgeModel: tier === 'answers' ? JUDGE_MODEL : null,
      answerPromptDigest: tier === 'answers' ? ANSWER_PROMPT_DIGEST : null,
      judgePromptDigest: tier === 'answers' ? JUDGE_PROMPT_DIGEST : null,
    },
    tier,
    startedAt,
    elapsedMs: Date.now() - started,
    vectorSource:
      tier === 'offline'
        ? `medición del ${measured.measuredOn}`
        : `API en vivo, ${new Date().toISOString().slice(0, 10)}`,
    retrieval,
    selection,
    answers,
    costUsd: Math.round(costUsd * 10_000) / 10_000,
    warnings,
  };
}
