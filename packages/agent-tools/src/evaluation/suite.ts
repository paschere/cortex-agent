/**
 * The questions, their known answers, and the hash that makes two runs
 * comparable.
 *
 * SHAPE BORROWED, NOT INVENTED. `kb/relevance.ts` already established the right
 * form in this repository — questions in three groups, the group being the
 * ground truth — and that measurement is what caught the threshold that was
 * throwing away the only document that answered the question. This file is that
 * same shape with the measurement automated instead of pasted into a comment,
 * and with two things the comment could not carry: a `gold` document per
 * question, so "did the RIGHT thing come back" is checkable rather than "did
 * SOMETHING score high", and verifiable criteria for the sentence a person
 * finally reads.
 *
 * WHY THE QUESTIONS ARE WRITTEN BADLY. On purpose, and it is the single most
 * important decision in this file. Measured on the live API against the same
 * passage, "¿plan de arranque de cortex?" scores 0.489 and "¿qué fases tiene el
 * plan de arranque de Córtex para BBIC S.A.S.?" scores 0.652 — 0.163 apart,
 * twelve times the margin that lost a document in production. A suite written
 * in well-formed questions measures a system nobody uses. So most of these are
 * terse, unpunctuated and accent-dropping, a few are well formed, and the mix
 * is deliberate rather than careless.
 *
 * THE THREE GROUPS, AND WHY THE LAST TWO ARE NOT PADDING.
 *   answered   The corpus answers it. Failing is a miss.
 *   absent     A question somebody would reasonably ask THIS corpus, which it
 *              does not answer. There is material nearby — the vacation policy
 *              is genuinely the document to read about working from abroad, it
 *              simply has no rule for it — so retrieval SHOULD return it and
 *              the verdict should be `thin`, not `answered`. Answering these
 *              confidently is the failure mode a purely positive suite rewards.
 *   unrelated  Nothing to do with the corpus. The verdict should be `nothing`.
 *
 * A run reports `grounding` over the first group and `restraint` over the other
 * two, and never averages them. That is the whole reason the groups exist.
 *
 * ONE ENTRY IS A KNOWN TRAP. `rate-in-force` asks about the senior hourly rate,
 * which two documents answer with different numbers. The contract says 210.000
 * and the signed otrosí says 245.000. Retrieval is right to return both;
 * the answer is only right if it gives the one in force. Its criteria say the
 * answer must contain 245.000 and must NOT contain 210.000 as the live rate —
 * a check code can make, with no opinion involved.
 */

import { createHash } from 'node:crypto';
import { CORPUS } from './corpus';
import type { EvalCase } from './types';

/** Bump when the meaning of the suite changes, not when a typo is fixed. */
export const SUITE_ID = 'cortex-brain-v1';

export const CASES: readonly EvalCase[] = [
  /* ---------------------------------------------------------------- answered */
  {
    id: 'plan-arranque',
    group: 'answered',
    query: '¿plan de arranque de cortex?',
    gold: ['plan-bbic'],
    answer: {
      contains: ['BBIC'],
      rubric: [
        {
          id: 'cites-plan',
          question: '¿La respuesta se apoya en el plan de arranque para BBIC y no en otro documento?',
          expect: true,
        },
      ],
    },
    why: 'The exact question, typed the exact way, that a 0.45 floor discarded in production. It is first in the file so that a change which breaks it breaks the most-read line of the report.',
  },
  {
    id: 'fases-plan',
    group: 'answered',
    query: 'cuantas fases tiene el plan de bbic y cuanto dura cada una',
    gold: ['plan-bbic'],
    answer: {
      contains: ['4', 'semana'],
      rubric: [
        {
          id: 'four-phases',
          question: '¿La respuesta dice que el plan tiene cuatro fases?',
          expect: true,
        },
      ],
    },
    why: 'The same document asked about in a way that needs the body, not the title — separating "the title matched" from "the content was read".',
  },
  {
    id: 'mensualidad-nexa',
    group: 'answered',
    query: 'cuanto nos paga nexa al mes',
    gold: ['otrosi-nexa', 'contract-nexa'],
    answer: {
      contains: ['44.900.000'],
      absent: ['38.400.000'],
      rubric: [
        {
          id: 'current-amount',
          question: '¿La respuesta da 44.900.000 como el valor mensual vigente hoy?',
          expect: true,
        },
      ],
    },
    why: 'Two documents answer it with different numbers and only the later one is in force. Retrieval passing is not enough; the answer has to pick.',
  },
  {
    id: 'rate-in-force',
    group: 'answered',
    query: 'tarifa hora ingeniero senior nexa',
    gold: ['otrosi-nexa', 'contract-nexa'],
    answer: {
      contains: ['245.000'],
      rubric: [
        {
          id: 'not-superseded',
          question:
            '¿La respuesta presenta 245.000 como la tarifa vigente, sin presentar 210.000 como si todavía aplicara?',
          expect: true,
        },
      ],
    },
    why: 'The deliberate conflict. A confident wrong answer here reads exactly like a confident right one, which is why it is graded on the figure and not on the tone.',
  },
  {
    id: 'preaviso',
    group: 'answered',
    query: 'preaviso para terminar el contrato de nexa',
    gold: ['contract-nexa', 'otrosi-nexa'],
    answer: {
      contains: ['60'],
      rubric: [
        {
          id: 'sixty-days',
          question: '¿La respuesta dice que el preaviso es de sesenta días?',
          expect: true,
        },
      ],
    },
    why: 'The otrosí explicitly leaves this clause alone. The right answer comes from the older document, so a system that always prefers the newest one gets it wrong.',
  },
  {
    id: 'dias-casa',
    group: 'answered',
    query: 'dias de la casa cuantos son',
    gold: ['policy-vacaciones'],
    answer: {
      contains: ['3'],
      rubric: [
        { id: 'three-days', question: '¿La respuesta dice que son tres días?', expect: true },
      ],
    },
    why: 'Local jargon with no literal overlap with the policy title — the case where keyword search contributes nothing and the semantic arm is the whole answer.',
  },
  {
    id: 'pago-nomina',
    group: 'answered',
    query: 'que dias pagan nomina',
    gold: ['policy-nomina'],
    answer: {
      contains: ['15'],
      rubric: [
        {
          id: 'twice-monthly',
          question: '¿La respuesta dice que se paga el 15 y el último día hábil del mes?',
          expect: true,
        },
      ],
    },
    why: 'The most ordinary question in the corpus. If this ever fails, nothing else in the report matters.',
  },
  {
    id: 'deducible-poliza',
    group: 'answered',
    query: 'deducible de la poliza de responsabilidad civil',
    gold: ['policy-poliza'],
    answer: {
      contains: ['10', '12.000.000'],
      rubric: [
        {
          id: 'both-parts',
          question: '¿La respuesta menciona tanto el 10% como el mínimo de 12.000.000?',
          expect: true,
        },
      ],
    },
    why: 'A two-part fact. Answers that give half of it are the common partial failure and would pass a looser check.',
  },
  {
    id: 'primera-semana',
    group: 'answered',
    query: '¿qué se espera de alguien en su primera semana?',
    gold: ['guide-onboarding'],
    answer: {
      rubric: [
        {
          id: 'pr-merged',
          question:
            '¿La respuesta menciona abrir un pull request o pasar por revisión de código en la primera semana?',
          expect: true,
        },
      ],
    },
    why: 'A well-formed question, kept as a control: if the ugly ones fail and this one passes, the problem is phrasing, not the corpus.',
  },
  {
    id: 'mascotas',
    group: 'answered',
    query: 'podemos traer mascotas a la oficina',
    gold: ['guide-onboarding'],
    answer: {
      rubric: [
        {
          id: 'says-no',
          question: '¿La respuesta dice que no se permiten mascotas, apoyándose en la guía de onboarding?',
          expect: true,
        },
      ],
    },
    why: 'It sounds unrelated and is not: the onboarding guide answers it outright. Filed as `answered` because the corpus answers it — the same case the relevance measurement had mislabelled.',
  },
  {
    id: 'por-que-subio',
    group: 'answered',
    query: 'por que le subimos el precio a nexa',
    gold: ['call-nexa', 'otrosi-nexa'],
    answer: {
      rubric: [
        {
          id: 'scope-not-inflation',
          question:
            '¿La respuesta explica que el aumento fue por la entrada de conciliación de fletes al alcance?',
          expect: true,
        },
      ],
    },
    why: 'The reason lives in a call transcript, not in a contract. Transcripts chunk differently and are the material most often lost.',
  },
  {
    id: 'auxilio-educativo',
    group: 'answered',
    query: 'cuanto dan para estudiar al año',
    gold: ['policy-nomina'],
    answer: {
      contains: ['3.000.000'],
      rubric: [
        { id: 'amount', question: '¿La respuesta da la cifra de 3.000.000 al año?', expect: true },
      ],
    },
    why: 'Colloquial phrasing against a formal heading ("auxilio educativo"), with a figure to check.',
  },

  /* ------------------------------------------------------------------ absent */
  {
    id: 'exterior-permanente',
    group: 'absent',
    query: 'puedo trabajar permanentemente desde el exterior',
    gold: [],
    answer: {
      rubric: [
        {
          id: 'declines',
          question:
            '¿La respuesta reconoce que el material no dice nada sobre trabajar permanentemente fuera del país?',
          expect: true,
        },
        {
          id: 'invents',
          question: '¿La respuesta afirma una regla concreta sobre trabajar fuera del país (un número de días, una aprobación específica, un tope) como si estuviera en el material?',
          expect: false,
        },
      ],
    },
    why: 'The hardest of the three groups. The vacation policy is the neighbouring document — it allows four weeks a year from any Colombian city — and it says nothing at all about living abroad. Retrieval should return it as a lead; the answer must not stretch the domestic rule to cover the question. The policy deliberately does not carry a "this is not covered here" line, because a corpus that announced its own gaps would make this test easy in a way real corpora never are.',
  },
  {
    id: 'licencia-paternidad',
    group: 'absent',
    query: 'licencia de paternidad cuantas semanas da cortex',
    gold: [],
    answer: {
      rubric: [
        {
          id: 'declines',
          question: '¿La respuesta dice que en el material no hay nada sobre licencia de paternidad?',
          expect: true,
        },
      ],
    },
    why: 'Sits squarely inside the HR policies without being in them. The neighbouring documents score well, which is exactly what makes it a good test of the floor.',
  },
  {
    id: 'tarifa-datos',
    group: 'absent',
    query: 'tarifa hora de un ingeniero de datos',
    gold: [],
    answer: {
      rubric: [
        {
          id: 'declines',
          question:
            '¿La respuesta aclara que el contrato no tiene tarifa para ingeniero de datos y no inventa una?',
          expect: true,
        },
      ],
    },
    why: 'The rate card is one word away and lists three roles, none of them this one. A system that answers by nearest neighbour gives a number here.',
  },
  {
    id: 'penalidad-bbic',
    group: 'absent',
    query: 'cual es la penalidad por terminar el contrato con bbic',
    gold: [],
    answer: {
      rubric: [
        {
          id: 'declines',
          question:
            '¿La respuesta aclara que con BBIC solo hay un plan de arranque y no un contrato con penalidad?',
          expect: true,
        },
      ],
    },
    why: 'Mixes a real client with a clause that exists for a different client. The tempting failure is to answer with the Nexa penalty.',
  },
  {
    id: 'cobertura-ciber',
    group: 'absent',
    query: 'la poliza cubre un ataque de ransomware',
    gold: [],
    answer: {
      rubric: [
        {
          id: 'declines',
          question:
            '¿La respuesta dice que la póliza no habla de ransomware o ciberataques, en vez de deducir que sí lo cubre?',
          expect: true,
        },
      ],
    },
    why: 'The policy has a data-loss extension that reads adjacent to it. Inferring coverage from an adjacent clause is how an assistant creates liability.',
  },

  /* --------------------------------------------------------------- unrelated */
  {
    id: 'receta-ajiaco',
    group: 'unrelated',
    query: 'receta de ajiaco santafereño',
    gold: [],
    answer: {
      rubric: [
        {
          id: 'declines',
          question: '¿La respuesta deja claro que esto no está en el material de la empresa?',
          expect: true,
        },
      ],
    },
    why: 'The canonical nonsense query. If this comes back `answered`, the floor is gone.',
  },
  {
    id: 'clima-medellin',
    group: 'unrelated',
    query: 'como va a estar el clima en medellin el fin de semana',
    gold: [],
    answer: {
      rubric: [
        {
          id: 'declines',
          question: '¿La respuesta deja claro que el material de la empresa no responde esto?',
          expect: true,
        },
      ],
    },
    why: 'Plausible-sounding, mentions a Colombian city, and has nothing to do with anything indexed.',
  },
  {
    id: 'partido-seleccion',
    group: 'unrelated',
    query: 'a que hora juega la seleccion colombia',
    gold: [],
    answer: {
      rubric: [
        {
          id: 'declines',
          question: '¿La respuesta deja claro que el material de la empresa no responde esto?',
          expect: true,
        },
      ],
    },
    why: 'Short, common, and the kind of thing a chat surface really receives.',
  },
  {
    id: 'capital-mongolia',
    group: 'unrelated',
    query: 'cual es la capital de mongolia',
    gold: [],
    answer: {
      rubric: [
        {
          id: 'declines-source',
          question:
            '¿La respuesta deja claro que esto no viene del material de la empresa, aunque diga la respuesta?',
          expect: true,
        },
      ],
    },
    why: 'The model knows the answer. The requirement is not silence — it is saying where the answer came from, which is a different and more useful behaviour than refusing.',
  },
  {
    id: 'vuelo-bogota',
    group: 'unrelated',
    query: 'vuelos baratos bogota cartagena diciembre',
    gold: [],
    answer: {
      rubric: [
        {
          id: 'declines',
          question: '¿La respuesta deja claro que el material de la empresa no responde esto?',
          expect: true,
        },
      ],
    },
    why: 'Commercial phrasing with no company footprint. Rounds the third group out to five, matching the shape of the original measurement.',
  },

  /* ------------------------------------------- selection-only (no retrieval) */
  {
    id: 'sel-placa',
    group: 'unrelated',
    query: 'consulta los comparendos de la placa WXY123',
    gold: [],
    needsFamily: 'vehicles',
    why: 'The vehicles family shipped registered, granted, and matched by no selection pattern, so Cortex truthfully said it had no access to the RUNT. This is that incident, as a test.',
  },
  {
    id: 'sel-correo',
    group: 'unrelated',
    query: 'mandale un correo a daniela con el resumen de la reunion',
    gold: [],
    needsFamily: 'gmail',
    why: 'The most common non-KB request there is. If mail is not offered, every other number in the report is beside the point.',
  },
  {
    id: 'sel-agenda',
    group: 'unrelated',
    query: 'que tengo en la agenda el jueves',
    gold: [],
    needsFamily: 'gcal',
    why: 'Calendar phrased without the word calendar — the case a keyword filter misses and a semantic ranker should not.',
  },
  {
    id: 'sel-vencimientos',
    group: 'unrelated',
    query: 'que soat se me vence este mes',
    gold: [],
    needsFamily: 'commitments',
    why: 'Domain vocabulary (SOAT) with no overlap with the family name. Exercises the description rather than the id.',
  },
  {
    id: 'sel-correo-persona',
    group: 'unrelated',
    query: 'cual es el correo de daniela rios',
    gold: [],
    needsFamily: 'people',
    why: 'Resolving a name to an address is what `people.search` exists for, and it is the step almost every mail or invite request needs first. This slot previously asked who was on holiday next week, which no tool in this product can answer — an assertion about a capability that does not exist measures the suite, not the system, so it was replaced rather than argued with.',
  },
] as const;

/**
 * The cases each layer grades.
 *
 * Selection-only cases carry `gold: []` and would otherwise be scored as
 * `unrelated` retrieval questions, which they are not — nobody expects the
 * corpus to hold a plate lookup, and counting them as restraint wins would
 * inflate the number that exists to be hard to win. So the split is explicit:
 * a case with `needsFamily` is graded by selection and by nothing else.
 */
export const RETRIEVAL_CASES: readonly EvalCase[] = CASES.filter((c) => !c.needsFamily);
export const SELECTION_CASES: readonly EvalCase[] = CASES.filter((c) => !!c.needsFamily);
export const ANSWER_CASES: readonly EvalCase[] = RETRIEVAL_CASES.filter((c) => !!c.answer);

/** Every query the suite ever embeds, deduped and ordered — the fixture's key set. */
export function suiteQueries(): string[] {
  return [...new Set(CASES.map((c) => c.query))];
}

/**
 * A hash over everything a comparison depends on: the corpus bytes, the
 * questions, their groups, their gold documents and their criteria.
 *
 * Two runs whose digests differ were not asked the same thing, and comparing
 * their scores is a category error however similar the numbers look. `compare`
 * refuses on a mismatch rather than warning, because a warning next to two
 * numbers that both say 0.9 gets skipped every time.
 */
export function suiteDigest(): string {
  const h = createHash('sha256');
  h.update(SUITE_ID);
  for (const doc of CORPUS) h.update(` ${doc.id} ${doc.title} ${doc.body}`);
  for (const c of CASES) {
    h.update(` ${c.id} ${c.group} ${c.query} ${c.gold.join(',')}`);
    h.update(` ${c.needsFamily ?? ''} ${JSON.stringify(c.answer ?? null)}`);
  }
  return h.digest('hex').slice(0, 16);
}
