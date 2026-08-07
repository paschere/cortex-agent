/**
 * The vocabulary of the evaluation: what a case is, what each layer scores, and
 * what one run records about itself.
 *
 * THREE LAYERS, NEVER ONE NUMBER. A question can fail in three unrelated ways
 * and averaging them hides all three:
 *
 *   RETRIEVAL   Did the right material come back, and was it kept? Objective.
 *               No model runs. Costs nothing. This is where the threshold bug
 *               lived: the correct chunk came back FIRST and was thrown away.
 *   SELECTION   Was the tool that can answer this even offered to the model?
 *               Objective. No model runs. This is where "no puedo ayudarte con
 *               eso" came from — the tool was granted, registered, and invisible.
 *   ANSWER      Is the sentence the person reads grounded in what was retrieved?
 *               Needs a model to generate and a model to judge, so it is the
 *               slow, expensive, least trustworthy layer, and it is reported
 *               separately with its own trust flag.
 *
 * TWO HEADLINE NUMBERS PER LAYER, NEVER ONE. `grounding` (of the questions the
 * corpus answers, how many were answered from the right source) and `restraint`
 * (of the questions it does not answer, how many were correctly declined) are
 * kept apart on purpose. A system that says yes to everything scores 1.00 on
 * the first and 0.00 on the second; averaged, it looks like 0.50, which is the
 * same number an honest mediocre system gets. They are different failures with
 * different fixes and they never get added together in this package.
 */

import type { RelevanceCalibration } from '../kb/relevance';

/**
 * Which of the three groups a question belongs to. Taken from the measurement
 * in `kb/relevance.ts`, because that grouping is what makes "no sé" gradeable:
 * without the second and third groups there is nothing a correct refusal can be
 * measured against.
 */
export type EvalGroup =
  /** The corpus answers it. Retrieval must find it, the answer must use it. */
  | 'answered'
  /** A question somebody would plausibly ask this corpus, which it does not answer. */
  | 'absent'
  /** Nothing to do with the corpus at all. */
  | 'unrelated';

/**
 * A verifiable claim about a free-text answer, in the only two forms that can
 * be checked without asking a model's opinion.
 *
 * `contains` is a literal the answer must carry — a figure, a date, a document
 * title. It is checked with a normalised substring match in code, never sent to
 * the judge, because a regex cannot be flattered into agreeing.
 * `rubric` is a binary question about the answer that code cannot decide —
 * "does it say it does not have this?" — and it is the ONLY thing the judge is
 * ever asked. Note the shape: a yes/no question with a required verdict, not a
 * quality rating.
 */
export interface AnswerCriteria {
  /** Literals that must appear. Matched after normalising case and separators. */
  contains?: readonly string[];
  /** Literals that must NOT appear — usually the superseded figure. */
  absent?: readonly string[];
  /** Binary questions for the judge, with the verdict each must get. */
  rubric?: readonly RubricCheck[];
}

export interface RubricCheck {
  /** Stable id, so a failing check can be named in a diff. */
  id: string;
  /** A yes/no question about the answer, in es-CO. Never "is it good?". */
  question: string;
  /** The verdict a correct answer produces. */
  expect: boolean;
}

export interface EvalCase {
  /** Stable id. Appears in run records; never reuse one for a different question. */
  id: string;
  group: EvalGroup;
  /**
   * The question, written the way somebody really types it — terse,
   * under-punctuated, accents dropped where people drop them. The old threshold
   * measurement used well-formed questions and was wrong by 0.163 of cosine
   * because of it (see `kb/relevance.ts`). Half of these are deliberately ugly.
   */
  query: string;
  /**
   * Documents that answer it, best first. Empty for `absent` and `unrelated` —
   * and that emptiness is the assertion, not a missing field.
   */
  gold: readonly string[];
  /**
   * A tool family that MUST be offered for this question, when the question is
   * about something other than Brain Knowledge. Undefined means the selection
   * layer skips this case. Families in `BASE_FAMILIES` are never a useful
   * assertion here: they are sent on every turn by construction.
   */
  needsFamily?: string;
  /** What a correct free-text answer has to satisfy. */
  answer?: AnswerCriteria;
  /** Why this case is in the suite. Read by whoever has to fix it. */
  why: string;
}

/* -------------------------------------------------------------------------- */
/* Layer 1 — retrieval                                                        */
/* -------------------------------------------------------------------------- */

export interface RetrievalCaseResult {
  caseId: string;
  group: EvalGroup;
  query: string;
  /** Rank of the best gold document, 1-based. Null when it never came back. */
  goldRank: number | null;
  /** True when a gold document survived the relevance floor. */
  goldKept: boolean;
  /** Best cosine seen for any hit, floor or no floor. */
  bestScore: number | null;
  /** Best cosine belonging to a gold document. */
  goldScore: number | null;
  /** What `assessCoverage` concluded. */
  coverage: 'answered' | 'thin' | 'nothing' | 'keyword-only';
  /** Whether that conclusion is the right one for this group. */
  coverageCorrect: boolean;
  /**
   * The production bug, named: the gold chunk was retrieved and then discarded
   * by the floor. Distinguished from "never retrieved" because they have
   * different causes and different fixes.
   */
  missedByFloor: boolean;
  /**
   * The opposite failure: an `absent` or `unrelated` question judged `answered`.
   * A system that never does this and never misses is the goal; a system that
   * trades one for the other has not improved, it has moved.
   */
  overclaimed: boolean;
  passed: boolean;
}

export interface RetrievalScore {
  cases: number;
  /** Of `answered` cases: gold document ranked first. */
  top1: number;
  /** Of `answered` cases: gold document anywhere in the returned set. */
  recall: number;
  /** Of `answered` cases: gold document survived the floor. THE headline. */
  grounding: number;
  /** Of `absent` + `unrelated` cases: not judged `answered`. THE other headline. */
  restraint: number;
  /** Count of gold chunks retrieved and then discarded. Should be zero. */
  missedByFloor: number;
  /** Count of unanswerable questions dressed up as answered. Should be zero. */
  overclaimed: number;
  results: RetrievalCaseResult[];
}

/* -------------------------------------------------------------------------- */
/* Layer 2 — tool selection                                                   */
/* -------------------------------------------------------------------------- */

export interface SelectionCaseResult {
  caseId: string;
  query: string;
  needsFamily: string;
  /** Whether the family reached the model at all. */
  offered: boolean;
  /** Its cosine against the query, or null when no tool in it was embedded. */
  familyScore: number | null;
  /** How many families the ranker sent. Context for a failure, not a score. */
  familiesOffered: number;
  passed: boolean;
}

export interface SelectionScore {
  cases: number;
  /** Fraction of cases whose required family was offered. */
  reach: number;
  /** Tools whose embed text has drifted from the fixture. Re-measure when nonzero. */
  staleTools: number;
  results: SelectionCaseResult[];
}

/* -------------------------------------------------------------------------- */
/* Layer 3 — answer                                                           */
/* -------------------------------------------------------------------------- */

export interface AnswerCaseResult {
  caseId: string;
  group: EvalGroup;
  query: string;
  answer: string;
  /** Literal checks decided in code. Never delegated. */
  literals: Array<{ needle: string; kind: 'contains' | 'absent'; passed: boolean }>;
  /** Rubric checks decided by the judge, with the quote it justified each with. */
  rubric: Array<{ id: string; expect: boolean; verdict: boolean; evidence: string | null; passed: boolean }>;
  passed: boolean;
}

/**
 * How much the judge can be believed, measured on the same run that used it.
 *
 * A judge is an instrument and an uncalibrated instrument reads whatever you
 * hope. `leniency` is the fraction of deliberately-wrong answers it waved
 * through; `severity` is the fraction of deliberately-correct ones it failed.
 * Both must be zero for the answer numbers to mean anything, and when they are
 * not, `trusted` is false and every consumer of this run is required to say so
 * rather than quietly print a score.
 */
export interface JudgeCalibration {
  probes: number;
  leniency: number;
  severity: number;
  trusted: boolean;
  /** Which probes went wrong, so the rubric can be fixed rather than argued about. */
  failures: Array<{ probeId: string; expectedPass: boolean; got: boolean }>;
}

export interface AnswerScore {
  cases: number;
  /** Of `answered` cases: fully correct, grounded, citing the right thing. */
  grounding: number;
  /** Of `absent` + `unrelated` cases: correctly said it does not have this. */
  restraint: number;
  judge: JudgeCalibration;
  results: AnswerCaseResult[];
}

/* -------------------------------------------------------------------------- */
/* The run                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Everything that has to match for two runs to be comparable, gathered in one
 * object so that comparing them is a field-by-field check and not a judgement
 * call. `suiteDigest` covers the corpus and the questions; the rest covers the
 * configuration under test. `compareRuns` refuses on a `suiteDigest` mismatch
 * and reports the others as "this is what changed" rather than blocking — the
 * whole point of a run is usually that one of them moved.
 */
export interface RunIdentity {
  suiteId: string;
  suiteDigest: string;
  embeddingModel: string;
  calibration: RelevanceCalibration;
  chatModel: string | null;
  judgeModel: string | null;
  answerPromptDigest: string | null;
  judgePromptDigest: string | null;
}

export type EvalTier = 'offline' | 'live' | 'answers';

export interface EvalRun {
  identity: RunIdentity;
  tier: EvalTier;
  startedAt: string;
  elapsedMs: number;
  /** Where the vectors came from — a dated fixture, or the live API. */
  vectorSource: string;
  retrieval: RetrievalScore;
  selection: SelectionScore;
  answers: AnswerScore | null;
  /** USD actually spent. Zero for `offline`, by construction. */
  costUsd: number;
  /** Anything a reader has to know before trusting the numbers above. */
  warnings: string[];
}
