/**
 * Runs kept over time, so "worse than last week" is a query and not a memory.
 *
 * WHY ANY OF THIS IS IN A DATABASE. The offline tier is a test and needs no
 * storage: it passes or it fails. What storage buys is the other question —
 * whether the number has been drifting for a month — and the answer to that
 * cannot live in a test run, because a test only ever knows about today. A
 * table also gives the screen something to draw, and a screen is what makes an
 * evaluation something a team looks at rather than something CI mutters about.
 *
 * SUMMARIES IN ONE TABLE, CASES IN ANOTHER. The run row carries the headline
 * numbers and the identity that makes it comparable; the per-case rows carry
 * which questions failed and why. The list screen reads only the first, which
 * is a handful of small rows; opening one run reads the second. Putting the
 * case detail in a jsonb column on the run would have worked and would have
 * made "which cases have been failing all month" a full scan of documents.
 *
 * THE CASE TABLE IS DERIVED, NOT TENANT. It has no `organization_id` and
 * inherits its tenant from `run_id`, so every read has to constrain the run —
 * which is what `createOrgScopedClient` enforces, and which is the same shape
 * `kb_chunks` has under `kb_documents`. A second copy of the workspace id on a
 * child row is a second thing that can be wrong.
 */

import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AnswerScore, EvalRun, EvalTier, RetrievalScore, SelectionScore } from './types';

export const EVALUATION_RUNS_TABLE = 'evaluation_runs';
export const EVALUATION_CASE_RESULTS_TABLE = 'evaluation_case_results';

/** A run as the list screen needs it: the numbers, not the transcript. */
export interface StoredRun {
  id: string;
  startedAt: string;
  tier: EvalTier;
  suiteId: string;
  suiteDigest: string;
  embeddingModel: string;
  strongMatch: number;
  weakFloor: number;
  calibrationMeasured: boolean;
  chatModel: string | null;
  judgeModel: string | null;
  answerPromptDigest: string | null;
  judgePromptDigest: string | null;
  vectorSource: string;
  retrieval: RetrievalSummary;
  selection: SelectionSummary;
  answers: AnswerSummary | null;
  costUsd: number;
  elapsedMs: number;
  warnings: string[];
}

export interface RetrievalSummary {
  cases: number;
  grounding: number;
  restraint: number;
  top1: number;
  recall: number;
  missedByFloor: number;
  overclaimed: number;
}

export interface SelectionSummary {
  cases: number;
  reach: number;
  staleTools: number;
}

export interface AnswerSummary {
  cases: number;
  grounding: number;
  restraint: number;
  judgeTrusted: boolean;
  judgeLeniency: number;
  judgeSeverity: number;
}

function summariseRetrieval(r: RetrievalScore): RetrievalSummary {
  return {
    cases: r.cases,
    grounding: r.grounding,
    restraint: r.restraint,
    top1: r.top1,
    recall: r.recall,
    missedByFloor: r.missedByFloor,
    overclaimed: r.overclaimed,
  };
}

function summariseSelection(s: SelectionScore): SelectionSummary {
  return { cases: s.cases, reach: s.reach, staleTools: s.staleTools };
}

function summariseAnswers(a: AnswerScore | null): AnswerSummary | null {
  if (!a) return null;
  return {
    cases: a.cases,
    grounding: a.grounding,
    restraint: a.restraint,
    judgeTrusted: a.judge.trusted,
    judgeLeniency: a.judge.leniency,
    judgeSeverity: a.judge.severity,
  };
}

/**
 * Write a run and its per-case detail.
 *
 * The case rows go in one insert after the run row, and a failure to write them
 * is NOT swallowed: unlike the turn-context recorder — which is diagnostics
 * hanging off a live answer and must never take one down — this is the whole
 * output of a deliberate command, and a run that silently stored half of itself
 * is worse than one that failed.
 */
export async function saveRun(db: SupabaseClient, run: EvalRun): Promise<string> {
  // The id is chosen here rather than read back from the insert. The column has
  // a default and either way works, but knowing the parent id BEFORE writing the
  // child rows means the two inserts do not depend on a `select().single()`
  // round-trip that can succeed and return nothing — which would leave the case
  // rows pointing at `undefined`, and a derived table with a null parent is a
  // row with no workspace at all.
  const runId = randomUUID();

  const { error } = await db.from(EVALUATION_RUNS_TABLE).insert({
    id: runId,
    started_at: run.startedAt,
    tier: run.tier,
    suite_id: run.identity.suiteId,
    suite_digest: run.identity.suiteDigest,
    embedding_model: run.identity.embeddingModel,
    strong_match: run.identity.calibration.strongMatch,
    weak_floor: run.identity.calibration.weakFloor,
    calibration_measured: run.identity.calibration.measured,
    chat_model: run.identity.chatModel,
    judge_model: run.identity.judgeModel,
    answer_prompt_digest: run.identity.answerPromptDigest,
    judge_prompt_digest: run.identity.judgePromptDigest,
    vector_source: run.vectorSource,
    retrieval: summariseRetrieval(run.retrieval),
    selection: summariseSelection(run.selection),
    answers: summariseAnswers(run.answers),
    cost_usd: run.costUsd,
    elapsed_ms: run.elapsedMs,
    warnings: run.warnings,
  });

  if (error) {
    throw new Error(`No se pudo guardar la corrida de evaluación: ${error.message}`);
  }

  const rows = [
    ...run.retrieval.results.map((r) => ({
      run_id: runId,
      layer: 'retrieval',
      case_id: r.caseId,
      case_group: r.group,
      query: r.query,
      passed: r.passed,
      detail: {
        goldRank: r.goldRank,
        goldKept: r.goldKept,
        goldScore: r.goldScore,
        bestScore: r.bestScore,
        coverage: r.coverage,
        missedByFloor: r.missedByFloor,
        overclaimed: r.overclaimed,
      },
    })),
    ...run.selection.results.map((r) => ({
      run_id: runId,
      layer: 'selection',
      case_id: r.caseId,
      case_group: 'tool',
      query: r.query,
      passed: r.passed,
      detail: {
        needsFamily: r.needsFamily,
        offered: r.offered,
        familyScore: r.familyScore,
        familiesOffered: r.familiesOffered,
      },
    })),
    ...(run.answers?.results ?? []).map((r) => ({
      run_id: runId,
      layer: 'answer',
      case_id: r.caseId,
      case_group: r.group,
      query: r.query,
      passed: r.passed,
      detail: { answer: r.answer, literals: r.literals, rubric: r.rubric },
    })),
  ];

  if (rows.length > 0) {
    const { error: caseError } = await db.from(EVALUATION_CASE_RESULTS_TABLE).insert(rows);
    if (caseError) {
      throw new Error(
        `Se guardó la corrida ${runId} pero no el detalle por caso: ${caseError.message}`,
      );
    }
  }
  return runId;
}

interface RunRow {
  id: string;
  started_at: string;
  tier: EvalTier;
  suite_id: string;
  suite_digest: string;
  embedding_model: string;
  strong_match: number;
  weak_floor: number;
  calibration_measured: boolean;
  chat_model: string | null;
  judge_model: string | null;
  answer_prompt_digest: string | null;
  judge_prompt_digest: string | null;
  vector_source: string;
  retrieval: RetrievalSummary;
  selection: SelectionSummary;
  answers: AnswerSummary | null;
  cost_usd: number | string;
  elapsed_ms: number;
  warnings: string[] | null;
}

function toStoredRun(row: RunRow): StoredRun {
  return {
    id: row.id,
    startedAt: row.started_at,
    tier: row.tier,
    suiteId: row.suite_id,
    suiteDigest: row.suite_digest,
    embeddingModel: row.embedding_model,
    strongMatch: Number(row.strong_match),
    weakFloor: Number(row.weak_floor),
    calibrationMeasured: row.calibration_measured,
    chatModel: row.chat_model,
    judgeModel: row.judge_model,
    answerPromptDigest: row.answer_prompt_digest,
    judgePromptDigest: row.judge_prompt_digest,
    vectorSource: row.vector_source,
    retrieval: row.retrieval,
    selection: row.selection,
    answers: row.answers,
    costUsd: Number(row.cost_usd),
    elapsedMs: row.elapsed_ms,
    warnings: row.warnings ?? [],
  };
}

export async function latestRuns(db: SupabaseClient, limit = 20): Promise<StoredRun[]> {
  const { data, error } = await db
    .from(EVALUATION_RUNS_TABLE)
    .select('*')
    .order('started_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`No se pudieron leer las corridas de evaluación: ${error.message}`);
  return ((data ?? []) as RunRow[]).map(toStoredRun);
}

export interface StoredCaseResult {
  layer: 'retrieval' | 'selection' | 'answer';
  caseId: string;
  caseGroup: string;
  query: string;
  passed: boolean;
  detail: Record<string, unknown>;
}

/**
 * The per-case detail of one run.
 *
 * `run_id` is required rather than optional because the table is derived: a
 * read that did not constrain it would be a read across workspaces, and the
 * scoped client throws rather than allowing it. Making the parameter mandatory
 * turns that runtime refusal into a compile error.
 */
export async function loadCaseResults(
  db: SupabaseClient,
  runId: string,
): Promise<StoredCaseResult[]> {
  const { data, error } = await db
    .from(EVALUATION_CASE_RESULTS_TABLE)
    .select('layer, case_id, case_group, query, passed, detail')
    .eq('run_id', runId)
    .order('layer', { ascending: true })
    .order('case_id', { ascending: true });
  if (error) throw new Error(`No se pudo leer el detalle de la corrida: ${error.message}`);
  return (
    (data ?? []) as Array<{
      layer: 'retrieval' | 'selection' | 'answer';
      case_id: string;
      case_group: string;
      query: string;
      passed: boolean;
      detail: Record<string, unknown>;
    }>
  ).map((r) => ({
    layer: r.layer,
    caseId: r.case_id,
    caseGroup: r.case_group,
    query: r.query,
    passed: r.passed,
    detail: r.detail ?? {},
  }));
}
