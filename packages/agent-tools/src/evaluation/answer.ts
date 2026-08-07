/**
 * Layer 3 — is the sentence a person actually reads grounded in what was found.
 *
 * THE EXPENSIVE, SLOW, LEAST TRUSTWORTHY LAYER, AND IT SAYS SO. It calls a
 * model to produce an answer and another to grade it, so it costs real money,
 * takes minutes rather than seconds, and is the only layer whose result depends
 * on something that is not a count. It runs by hand — before a model change, a
 * prompt change, or a release — and never in CI. Layers 1 and 2 are what run on
 * every commit, and they are the ones that would have caught all three of the
 * failures this package was written after.
 *
 * WHAT IS DECIDED IN CODE, AND WHAT IS DELEGATED. Every criterion that can be
 * checked with a substring is checked with a substring: the figure, the date,
 * the document title. Those results are computed here, are never shown to the
 * judge, and cannot be talked out of. Only the residue goes to the model —
 * "does it say it does not have this", "does it present the superseded rate as
 * current" — questions that need reading and have a right answer. A rubric that
 * sent the figures to the judge would be paying a model to run `includes()` and
 * accepting a small error rate for the privilege.
 *
 * NUMBER NORMALISATION IS PART OF THE CHECK, NOT A LOOPHOLE. Colombian figures
 * are written 44.900.000, 44'900.000, "44,9 millones" and "COP 44900000", and
 * all four are the same fact. `matchesLiteral` strips separators from both
 * sides before comparing, so a correct answer is not failed over a thousands
 * dot. It does NOT accept a rounded "casi 45 millones": that is a different
 * claim and a contract answer that rounds is wrong.
 *
 * THE PROMPT IS AN INPUT, NOT A CONSTANT. `GROUNDING_PROMPT` states the
 * grounding contract in the smallest form that makes the criteria answerable,
 * and it is DELIBERATELY NOT the production system prompt: importing that would
 * couple every retrieval number to every wording change in a file three other
 * people edit, and a suite that moves when nothing measurable moved is a suite
 * people learn to ignore. The prompt's digest goes into the run identity, so
 * two runs written against different prompts are visibly not comparable — which
 * is the honest way to have it both ways. Pass your own to measure the real one.
 */

import { generateText } from 'ai';
import { CHAT_MODEL, chatModel } from '../model';
import type { SpaceHit } from '../kb/spaces';
import { type CoverageVerdict, assessCoverage } from '../kb/relevance';
import { judgeAnswer, promptDigest } from './judge';
import type { AnswerCaseResult, AnswerScore, EvalCase, JudgeCalibration } from './types';

export const ANSWER_MODEL = CHAT_MODEL;

export const GROUNDING_PROMPT = `Eres Cortex, el asistente de una empresa colombiana. Respondes en español de Colombia, tuteando, sin rodeos.

Te llega una pregunta y, debajo, el material que la búsqueda encontró en Brain Knowledge, con una frase que dice qué tan bien lo responde.

Reglas:
- Responde ÚNICAMENTE con lo que esté en el material. No completes con lo que suene razonable.
- Si el material no responde la pregunta, dilo así, con esas palabras: que no hay nada guardado sobre eso. Es una respuesta correcta y útil.
- Si sabes la respuesta por fuera del conocimiento de la empresa, puedes darla, pero aclara explícitamente que no viene de Brain Knowledge.
- Cuando dos documentos digan cosas distintas, gana el más reciente. Di cuál es y desde cuándo aplica.
- Cita el documento del que sacaste cada dato, por su nombre.
- Da las cifras completas, como aparecen en el material.
- No inventes fechas, cifras, nombres de documentos ni cláusulas.`;

export const ANSWER_PROMPT_DIGEST = promptDigest(GROUNDING_PROMPT);

/**
 * The material block, built the way the product builds it: the verdict sentence
 * first, then the surviving fragments, numbered, with their document and date.
 *
 * The verdict sentence leads because that is the load-bearing part — it is what
 * tells the model "there is nothing here" in a form it cannot mistake for an
 * empty result — and because a block that omitted it would be measuring a
 * different system than the one that ships.
 */
export function materialBlock(verdict: CoverageVerdict<SpaceHit>): string {
  if (verdict.kept.length === 0) return verdict.summary;
  const fragments = verdict.kept.map(({ hit, relevance }, i) => {
    const dated = hit.datedAt ? `, con fecha ${hit.datedAt}` : '';
    const strength = relevance === 'strong' ? 'responde' : 'apenas relacionado';
    return `[${i + 1}] «${hit.documentTitle}»${dated} (${strength}):\n${hit.content}`;
  });
  return `${verdict.summary}\n\n${fragments.join('\n\n')}`;
}

export interface AnswerRun {
  answer: string;
  material: string;
  /** Input and output tokens, for the cost line of the run record. */
  usage: { input: number; output: number };
}

export async function produceAnswer(
  query: string,
  hits: SpaceHit[],
  modelId: string,
  systemPrompt = GROUNDING_PROMPT,
): Promise<AnswerRun> {
  const verdict = assessCoverage(hits, { query, embeddingModel: modelId });
  const material = materialBlock(verdict);
  const result = await generateText({
    model: chatModel(),
    system: systemPrompt,
    prompt: `PREGUNTA: ${query}\n\nMATERIAL ENCONTRADO:\n${material}`,
    maxTokens: 700,
  });
  return {
    answer: result.text.trim(),
    material,
    usage: {
      input: result.usage?.promptTokens ?? 0,
      output: result.usage?.completionTokens ?? 0,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The checks code makes                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Strip the things that differ between two writings of the same number or name,
 * and nothing else. Accents go because "otrosí"/"otrosi" is not a difference
 * worth failing on; thousands separators go because 44.900.000 and 44900000 are
 * the same figure; case goes for the obvious reason. Digits are never touched.
 */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036f]/g, '')
    .replaceAll(/(\d)[.,'\u00a0\u202f ](?=\d)/g, '$1')
    .replaceAll(/\s+/g, ' ');
}

export function matchesLiteral(answer: string, needle: string): boolean {
  return normalise(answer).includes(normalise(needle));
}

/* -------------------------------------------------------------------------- */
/* Grading                                                                    */
/* -------------------------------------------------------------------------- */

export interface AnswerGradeInput {
  evalCase: EvalCase;
  query: string;
  answer: string;
  material: string;
}

export async function gradeAnswerCase({
  evalCase,
  query,
  answer,
  material,
}: AnswerGradeInput): Promise<AnswerCaseResult> {
  const criteria = evalCase.answer ?? {};

  const literals = [
    ...(criteria.contains ?? []).map((needle) => ({
      needle,
      kind: 'contains' as const,
      passed: matchesLiteral(answer, needle),
    })),
    ...(criteria.absent ?? []).map((needle) => ({
      needle,
      kind: 'absent' as const,
      passed: !matchesLiteral(answer, needle),
    })),
  ];

  const checks = criteria.rubric ?? [];
  const verdicts = await judgeAnswer({ query, material, answer, checks });
  const rubric = checks.map((check) => {
    const got = verdicts.find((v) => v.id === check.id);
    const verdict = got?.verdict ?? false;
    return {
      id: check.id,
      expect: check.expect,
      verdict,
      evidence: got?.evidence ?? null,
      passed: verdict === check.expect,
    };
  });

  return {
    caseId: evalCase.id,
    group: evalCase.group,
    query,
    answer,
    literals,
    rubric,
    passed: literals.every((l) => l.passed) && rubric.every((r) => r.passed),
  };
}

export function scoreAnswers(
  results: AnswerCaseResult[],
  judge: JudgeCalibration,
): AnswerScore {
  const answerable = results.filter((r) => r.group === 'answered');
  const unanswerable = results.filter((r) => r.group !== 'answered');
  const ratio = (hit: number, of: number) => (of === 0 ? 1 : hit / of);
  return {
    cases: results.length,
    grounding: ratio(answerable.filter((r) => r.passed).length, answerable.length),
    restraint: ratio(unanswerable.filter((r) => r.passed).length, unanswerable.length),
    judge,
    results,
  };
}
