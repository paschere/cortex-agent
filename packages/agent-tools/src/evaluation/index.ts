/**
 * Continuous evaluation — does a change make the answers better or worse.
 *
 * WHY IT EXISTS. In one day this deployment changed the conversational model,
 * the embedding engine and the relevance thresholds — three things that touch
 * the quality of every single answer — and verified all three by checking that
 * the code compiled. What followed:
 *
 *   · A miscalibrated threshold discarded the only document that answered the
 *     question. It was found by the product owner, with a screenshot.
 *   · One surface had been throwing away every correct result it was handed for
 *     months, leaving no trace: no context, no record, the model answering from
 *     memory.
 *   · The agent said "no puedo ayudarte con eso" with the tool sitting in front
 *     of it, because selection could not find it.
 *
 * All three were invisible to typecheck, to 1 139 tests and to the build,
 * because all three are properties of an ANSWER and nothing in this repository
 * asserted on one. This package asserts on them.
 *
 * WHAT IS IN HERE, AND IN WHAT ORDER TO READ IT.
 *
 *   corpus.ts     Eight documents, in the repository, in es-CO. Two of them
 *                 contradict each other on purpose.
 *   suite.ts      Twenty-two questions in three groups — twelve the corpus
 *                 answers, five plausible ones it does not, and five with
 *                 nothing to do with it — plus five that exist only to check
 *                 tool selection. `suiteDigest()` is what makes two runs
 *                 comparable.
 *   vectors.ts    The measurement, frozen: every cosine, per embedding model,
 *                 with the date it was taken.
 *   measure.ts    What produces that file, against the live API. Runs by hand.
 *   retrieval.ts  Layer 1 — did the right material come back and survive the
 *                 floor. Objective, free.
 *   selection.ts  Layer 2 — was the tool that can answer this even offered.
 *                 Objective, free.
 *   answer.ts     Layer 3 — is the sentence grounded. Costs money, runs by hand.
 *   judge.ts      The model that grades layer 3, and the nine fixed probes that
 *                 grade the judge.
 *   run.ts        The three tiers and what each one fixes.
 *   compare.ts    Two runs, honestly. Refuses when they were not the same test.
 *   store.ts      Runs kept over time, so "worse than last week" is checkable.
 *
 * WHAT RUNS WHEN — the short version; `docs/operations/answer-quality.md` has
 * the long one.
 *
 *   Every change, in CI      `__tests__/offline.test.ts`. ~1 s, USD 0.
 *   Embedding/chunking work  `EVAL_MEASURE=1`, then commit the fixture. Ten to
 *                            twenty minutes and USD 0.0004 — and the minutes
 *                            are the provider's free-tier rate limit, not the
 *                            work.
 *   Model or prompt work     `EVAL_ANSWERS=1`. Measured: 15 min, USD 0.38.
 *
 * THE TWO NUMBERS. Every layer reports `grounding` — of the questions the corpus
 * answers, how many were answered from the right source — and `restraint` — of
 * the questions it does not answer, how many were correctly declined. They are
 * never averaged into one. A system that answers everything confidently scores
 * 1.00 and 0.00; a single figure would put it level with an honest mediocre one.
 */

export * from './types';
export { CORPUS, CORPUS_BY_ID, corpusChunks, type CorpusChunk, type EvalDocument } from './corpus';
export { CASES, RETRIEVAL_CASES, SELECTION_CASES, ANSWER_CASES, SUITE_ID, suiteDigest, suiteQueries } from './suite';
export {
  type VectorFixture,
  type FixtureChunk,
  type FixtureTool,
  UnmeasuredModelError,
  fixturePath,
  fixtureDrift,
  loadFixture,
} from './vectors';
export { measure, type MeasureOptions } from './measure';
export {
  RETRIEVAL_LIMIT,
  gradeRetrievalCase,
  replayHits,
  scoreRetrieval,
} from './retrieval';
export {
  currentToolHashes,
  gradeSelection,
  staleRequiredTools,
  type SelectionGradeInput,
} from './selection';
export {
  ANSWER_MODEL,
  ANSWER_PROMPT_DIGEST,
  GROUNDING_PROMPT,
  gradeAnswerCase,
  materialBlock,
  matchesLiteral,
  produceAnswer,
  scoreAnswers,
} from './answer';
export {
  JUDGE_MODEL,
  JUDGE_PROMPT,
  JUDGE_PROMPT_DIGEST,
  JUDGE_PROBES,
  type JudgeProbe,
  type JudgeVerdict,
  calibrateJudge,
  judgeAnswer,
} from './judge';
export { runEvaluation, type RunOptions } from './run';
export { compareRuns, formatRun, type Comparison, type Delta } from './compare';
export {
  EVALUATION_RUNS_TABLE,
  EVALUATION_CASE_RESULTS_TABLE,
  type StoredRun,
  latestRuns,
  loadCaseResults,
  saveRun,
} from './store';
