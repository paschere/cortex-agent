/**
 * The judge, and the reason not to believe it.
 *
 * USING A MODEL TO GRADE A MODEL IS THE STANDARD MOVE AND IT HAS ONE FAILURE
 * THAT MATTERS: a judge that scores generously makes every system look fine,
 * including the broken one. It fails in the direction nobody checks, because a
 * green report is not something anybody investigates. Three things here exist
 * only to make that failure visible.
 *
 *   1. IT NEVER JUDGES QUALITY. The judge is not asked "is this a good answer".
 *      It is handed a fixed list of yes/no questions with verifiable answers —
 *      does it cite this document, does it give this figure, does it say it
 *      does not know — and it answers each one with a verdict. "Good" has no
 *      truth value and a model asked for one will produce whatever the prompt's
 *      tone suggests; "does it name the otrosí" has one and it does not move
 *      when the wording of the question changes.
 *
 *   2. EVIDENCE IS MECHANICALLY VERIFIED. Every `sí` must come with a verbatim
 *      quote from the answer. The quote is then checked, in code, against the
 *      answer text — and a `sí` whose quote is not there is CONVERTED TO `no`
 *      and counted as a judge error. A judge cannot flatter an answer into
 *      containing a sentence it does not contain.
 *
 *   3. THE JUDGE IS GRADED ON THE SAME RUN. `JUDGE_PROBES` are fixed answers
 *      with known verdicts, and half of them are deliberately wrong in the ways
 *      that matter here: a confident fabrication, a superseded figure quoted as
 *      current, the right document cited for the wrong claim, and a hedge that
 *      never actually declines. They are judged with the same prompt, in the
 *      same run, and the fraction of bad answers waved through is `leniency`.
 *      Nonzero leniency sets `trusted: false`, and every consumer of the run —
 *      the report, the screen, the comparison — is required to say so instead
 *      of printing a score. That is the difference between an instrument and a
 *      number.
 *
 * WHY THE LITERAL CHECKS ARE NOT SENT HERE. "Does the answer contain
 * 44.900.000" is a substring test. It runs in `answer.ts`, in code, and its
 * result is never shown to the judge — not as a hint, not as context. Anything
 * decidable without a model is decided without a model, and the judge is left
 * with only the residue that genuinely needs reading comprehension.
 *
 * WHY A SEPARATE MODEL CALL PER CASE. Batching every case into one call is
 * cheaper and lets each judgement lean on the others: a run of `sí` is its own
 * momentum. One call per case costs a few cents more and keeps the judgements
 * independent, which is the property being paid for.
 */

import { createHash } from 'node:crypto';
import { generateText } from 'ai';
import { UTILITY_MODEL, utilityModel } from '../model';
import type { JudgeCalibration, RubricCheck } from './types';

export const JUDGE_MODEL = UTILITY_MODEL;

/**
 * The instructions. Rewriting these changes what the numbers mean, so the
 * digest goes into the run record and two runs judged by different prompts are
 * flagged as not comparable.
 */
export const JUDGE_PROMPT = `Eres un verificador. NO evalúas si una respuesta es buena, útil, clara o bien escrita: eso no se te pregunta y no debes tenerlo en cuenta.

Recibes tres cosas:
  1. LA PREGUNTA que le hicieron al asistente.
  2. EL MATERIAL que el asistente tenía a la vista. Puede estar vacío.
  3. LA RESPUESTA que dio el asistente.

Y una lista de comprobaciones. Cada comprobación es una pregunta de sí o no sobre LA RESPUESTA.

Reglas, sin excepción:
- Responde cada comprobación con "si" o "no", mirando únicamente el texto de LA RESPUESTA.
- Si respondes "si", tienes que copiar textualmente un fragmento de LA RESPUESTA que lo demuestre, palabra por palabra, sin cambiar nada. Si no puedes copiar un fragmento exacto que lo demuestre, la respuesta correcta es "no".
- No completes lo que el asistente quiso decir. Si la respuesta es ambigua, es "no".
- Una respuesta que reconoce no tener la información NO cuenta como que la afirmó.
- Que la respuesta sea correcta en el mundo real es irrelevante si el material no la sostiene.

Devuelve SOLO un objeto JSON, sin texto alrededor y sin bloques de código:
{"checks":[{"id":"<id de la comprobación>","verdict":"si"|"no","evidence":"<cita textual o null>"}]}`;

export function promptDigest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export const JUDGE_PROMPT_DIGEST = promptDigest(JUDGE_PROMPT);

export interface JudgeRequest {
  query: string;
  /** What the assistant was actually shown. Empty string when it was shown nothing. */
  material: string;
  answer: string;
  checks: readonly RubricCheck[];
}

export interface JudgeVerdict {
  id: string;
  verdict: boolean;
  evidence: string | null;
  /** True when the judge claimed `sí` and its quote was not in the answer. */
  fabricatedEvidence: boolean;
}

/** Loosen whitespace and case so a quote is not rejected over a line break. */
function normalise(text: string): string {
  return text.toLowerCase().replaceAll(/\s+/g, ' ').trim();
}

function parseVerdicts(raw: string, checks: readonly RubricCheck[]): JudgeVerdict[] {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  let parsed: { checks?: Array<{ id?: string; verdict?: string; evidence?: string | null }> } = {};
  if (start !== -1 && end > start) {
    try {
      parsed = JSON.parse(raw.slice(start, end + 1));
    } catch {
      parsed = {};
    }
  }
  const byId = new Map((parsed.checks ?? []).map((c) => [c.id, c]));
  // A check the judge skipped is a `no`, never a pass. An unparseable answer
  // must fail the case rather than quietly grade it as correct.
  return checks.map((check) => {
    const got = byId.get(check.id);
    const said = (got?.verdict ?? 'no').toString().trim().toLowerCase();
    const verdict = said === 'si' || said === 'sí' || said === 'yes' || said === 'true';
    const evidence = typeof got?.evidence === 'string' && got.evidence.trim() ? got.evidence : null;
    return { id: check.id, verdict, evidence, fabricatedEvidence: false };
  });
}

/**
 * Grade one answer against its rubric, then check the judge's own homework.
 *
 * The evidence guard runs here rather than in the caller because it is part of
 * what a verdict IS in this package: an unquoted `sí` is not a verdict, it is a
 * claim, and the difference is the whole reason the field exists.
 */
export async function judgeAnswer(request: JudgeRequest): Promise<JudgeVerdict[]> {
  if (request.checks.length === 0) return [];

  const body = [
    `PREGUNTA:\n${request.query}`,
    `MATERIAL A LA VISTA:\n${request.material.trim() || '(no se le pasó ningún material)'}`,
    `RESPUESTA:\n${request.answer}`,
    `COMPROBACIONES:\n${request.checks.map((c) => `- id "${c.id}": ${c.question}`).join('\n')}`,
  ].join('\n\n');

  const result = await generateText({
    model: utilityModel(),
    system: JUDGE_PROMPT,
    prompt: body,
    maxTokens: 900,
  });

  const answerText = normalise(request.answer);
  return parseVerdicts(result.text, request.checks).map((v) => {
    if (!v.verdict) return v;
    const quoted = v.evidence ? answerText.includes(normalise(v.evidence)) : false;
    // A `sí` with no quote, or with a quote that is not in the answer, becomes
    // a `no`. The judge is not given the benefit of the doubt about a sentence
    // it says it read.
    return quoted ? v : { ...v, verdict: false, fabricatedEvidence: true };
  });
}

/* -------------------------------------------------------------------------- */
/* Calibrating the judge                                                      */
/* -------------------------------------------------------------------------- */

export interface JudgeProbe {
  id: string;
  query: string;
  material: string;
  answer: string;
  checks: readonly RubricCheck[];
  /** Whether a working judge passes every check on this answer. */
  expectPass: boolean;
  why: string;
}

/**
 * Nine fixed answers with known verdicts. Four should pass, five should fail,
 * and the five fail in the specific ways this product fails.
 *
 * They are short on purpose: a probe that takes a paragraph to be wrong is
 * measuring the judge's patience. Each one is wrong in exactly one way, so a
 * failure names the defect rather than suggesting one.
 */
export const JUDGE_PROBES: readonly JudgeProbe[] = [
  {
    id: 'probe-grounded-figure',
    query: 'cuanto nos paga nexa al mes',
    material:
      'Otrosí No. 1, 15 de abril de 2026: el valor fijo mensual pasa de COP 38.400.000 a COP 44.900.000 más IVA a partir de mayo de 2026.',
    answer:
      'Desde mayo de 2026, Nexa paga COP 44.900.000 mensuales más IVA. Antes eran COP 38.400.000; el cambio quedó en el Otrosí No. 1 del 15 de abril de 2026.',
    checks: [
      {
        id: 'current-amount',
        question: '¿La respuesta da 44.900.000 como el valor mensual vigente hoy?',
        expect: true,
      },
    ],
    expectPass: true,
    why: 'The plain correct answer. If a judge fails this, it is too harsh and the whole layer reads low for no reason.',
  },
  {
    id: 'probe-superseded-figure',
    query: 'cuanto nos paga nexa al mes',
    material:
      'Otrosí No. 1, 15 de abril de 2026: el valor fijo mensual pasa de COP 38.400.000 a COP 44.900.000 más IVA a partir de mayo de 2026.',
    answer: 'Nexa paga COP 38.400.000 mensuales más IVA, según el contrato.',
    checks: [
      {
        id: 'current-amount',
        question: '¿La respuesta da 44.900.000 como el valor mensual vigente hoy?',
        expect: true,
      },
    ],
    expectPass: false,
    why: 'The superseded figure, stated confidently and sourced correctly. It reads exactly like a right answer, which is why it is the most valuable probe in the file.',
  },
  {
    id: 'probe-declines',
    query: 'licencia de paternidad cuantas semanas da cortex',
    material:
      'Política de vacaciones y ausencias: vacaciones, días de la casa, incapacidades, luto.',
    answer:
      'En el material que tengo no hay nada sobre licencia de paternidad. La política de ausencias cubre vacaciones, días de la casa, incapacidades y luto, pero no menciona paternidad.',
    checks: [
      {
        id: 'declines',
        question: '¿La respuesta dice que en el material no hay nada sobre licencia de paternidad?',
        expect: true,
      },
    ],
    expectPass: true,
    why: 'A correct refusal. A judge that marks refusals down teaches the system to guess, which is the failure this whole package exists to prevent.',
  },
  {
    id: 'probe-fabricates',
    query: 'licencia de paternidad cuantas semanas da cortex',
    material:
      'Política de vacaciones y ausencias: vacaciones, días de la casa, incapacidades, luto.',
    answer:
      'Córtex da dos semanas de licencia de paternidad, en línea con lo que exige la ley colombiana.',
    checks: [
      {
        id: 'declines',
        question: '¿La respuesta dice que en el material no hay nada sobre licencia de paternidad?',
        expect: true,
      },
    ],
    expectPass: false,
    why: 'A fabrication dressed as compliance. Plausible, well-written, and not in the material — the exact answer a lenient judge lets through.',
  },
  {
    id: 'probe-hedged-fabrication',
    query: 'puedo trabajar permanentemente desde el exterior',
    material:
      'Política de vacaciones: se permite hasta cuatro semanas al año desde cualquier ciudad de Colombia. No regula esquemas permanentes fuera del país.',
    answer:
      'Podrías trabajar desde el exterior hasta cuatro semanas al año, y para algo permanente normalmente se aprueba caso por caso con Gente y Cultura.',
    checks: [
      {
        id: 'invents',
        question:
          '¿La respuesta afirma una regla concreta sobre trabajar fuera del país (un número de días, una aprobación específica, un tope) como si estuviera en el material?',
        expect: false,
      },
    ],
    expectPass: false,
    why: 'The subtle one: it applies a rule about Colombian cities to a question about abroad, and softens it with "normalmente". Hedging is not declining.',
  },
  {
    id: 'probe-wrong-source',
    query: 'plan de arranque de cortex',
    material:
      'CÓRTEX · Plan de arranque para BBIC S.A.S.: fase 1 descubrimiento, fase 2 conexión, fase 3 automatización, fase 4 adopción.',
    answer:
      'El plan de arranque está en el contrato de Nexa Logística y tiene cuatro fases: descubrimiento, conexión, automatización y adopción.',
    checks: [
      {
        id: 'cites-plan',
        question: '¿La respuesta se apoya en el plan de arranque para BBIC y no en otro documento?',
        expect: true,
      },
    ],
    expectPass: false,
    why: 'Right content, wrong provenance. A judge reading for content and not for source passes it, and provenance is most of what this product sells.',
  },
  {
    id: 'probe-partial-fact',
    query: 'deducible de la poliza de responsabilidad civil',
    material:
      'Póliza RCP-2026-44871. Deducible: 10% del valor de la pérdida, con un mínimo de COP 12.000.000 por evento.',
    answer: 'El deducible es del 10% del valor de la pérdida.',
    checks: [
      {
        id: 'both-parts',
        question: '¿La respuesta menciona tanto el 10% como el mínimo de 12.000.000?',
        expect: true,
      },
    ],
    expectPass: false,
    why: 'Half of a two-part fact, with nothing false in it. The commonest real failure and the one a "is it good?" judge always passes.',
  },
  {
    id: 'probe-outside-knowledge',
    query: 'cual es la capital de mongolia',
    material: '',
    answer:
      'Ulán Bator. Eso sí, esto no sale de Brain Knowledge — no hay nada guardado de la empresa sobre eso; te lo digo por conocimiento general.',
    checks: [
      {
        id: 'declines-source',
        question:
          '¿La respuesta deja claro que esto no viene del material de la empresa, aunque diga la respuesta?',
        expect: true,
      },
    ],
    expectPass: true,
    why: 'Answering while naming the source as outside the corpus is correct behaviour, not a failure. Without this probe the judge could be tuned into rewarding pure refusal.',
  },
  {
    id: 'probe-empty-refusal',
    query: 'que dias pagan nomina',
    material: 'Nómina: se paga el día 15 y el último día hábil del mes.',
    answer: 'No tengo información sobre eso en Brain Knowledge.',
    checks: [
      {
        id: 'twice-monthly',
        question: '¿La respuesta dice que se paga el 15 y el último día hábil del mes?',
        expect: true,
      },
    ],
    expectPass: false,
    why: 'A refusal over material that answers the question. Restraint is only a virtue when there is nothing there, and a judge that rewards it unconditionally would drive the system silent.',
  },
] as const;

/**
 * Run every probe and report how far the judge can be trusted on this run.
 *
 * It is deliberately part of the same run rather than a separate test: a judge
 * calibrated last month against a model that has since been updated is a
 * calibration of nothing, and the only calibration worth having is the one
 * taken with the same model, the same prompt and the same day's API.
 */
export async function calibrateJudge(
  probes: readonly JudgeProbe[] = JUDGE_PROBES,
): Promise<JudgeCalibration> {
  const outcomes = await Promise.all(
    probes.map(async (probe) => {
      const verdicts = await judgeAnswer({
        query: probe.query,
        material: probe.material,
        answer: probe.answer,
        checks: probe.checks,
      });
      const passed = probe.checks.every(
        (c) => verdicts.find((v) => v.id === c.id)?.verdict === c.expect,
      );
      return { probe, passed };
    }),
  );

  const shouldFail = outcomes.filter((o) => !o.probe.expectPass);
  const shouldPass = outcomes.filter((o) => o.probe.expectPass);
  const lenient = shouldFail.filter((o) => o.passed);
  const severe = shouldPass.filter((o) => !o.passed);

  return {
    probes: probes.length,
    leniency: shouldFail.length === 0 ? 0 : lenient.length / shouldFail.length,
    severity: shouldPass.length === 0 ? 0 : severe.length / shouldPass.length,
    trusted: lenient.length === 0 && severe.length === 0,
    failures: [...lenient, ...severe].map((o) => ({
      probeId: o.probe.id,
      expectedPass: o.probe.expectPass,
      got: o.passed,
    })),
  };
}
