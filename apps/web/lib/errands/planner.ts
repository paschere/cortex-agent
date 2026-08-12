import 'server-only';
import { NO_THINKING, chatModel } from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { generateObject } from 'ai';
import { z } from 'zod';
import { ERRAND_KIND_SPECS } from './kinds';
import type { Assessment } from './engine';
import type { ErrandKind, ErrandSource } from './types';

/**
 * The two model calls an errand makes on its own behalf.
 *
 * Everything else an errand does is delegated: the orchestrator plans the
 * legs, the sub-agents do the work, the synthesis writes each leg's report.
 * These two are the errand's own judgement, and they are the two places where
 * it is allowed to decide that it needs a person.
 *
 *   triage    Before a peso is spent: is this request answerable as written,
 *             or is it ambiguous in a way that would send the whole run down
 *             the wrong road?
 *
 *   assess    After a leg: is this the answer, is it worth another leg, or is
 *             there a fork only a person can pick?
 *
 * ── WHY TRIAGE EXISTS AT ALL ──────────────────────────────────────────────
 *
 * "Investiga operadores de carga refrigerada en Buenaventura" has at least
 * three readings — maritime or land, importers or exporters, certified or
 * merely advertising it. Guessing costs forty minutes and produces a document
 * that is wrong in a way nobody notices until they act on it. Asking costs one
 * cheap call and ten seconds of a person's attention, AT THE MOMENT THEY ARE
 * STILL LOOKING AT THE SCREEN. That timing is most of the value: the same
 * question asked forty minutes later gets answered tomorrow.
 *
 * Triage is therefore deliberately reluctant. It asks only when a wrong guess
 * would waste the whole errand, never to be thorough — an assistant that opens
 * with three clarifying questions is a form, and people stop filling in forms.
 *
 * ── WHY BOTH CALLS CAN FAIL SAFELY ────────────────────────────────────────
 *
 * Neither throws. A triage that fails accepts the request as written (the
 * errand proceeds, which is what the person asked for). An assessment that
 * fails returns a question rather than a verdict, because the one thing it
 * must never do is decide something is finished when nobody knows whether it
 * is. Failing towards a question is failing towards a person.
 */

/** Ceiling on the brief handed to the orchestrator. */
const BRIEF_LIMIT = 2_000;
/** How much of a leg's report the assessor reads. */
const LEG_INPUT_LIMIT = 12_000;
/** How much accumulated knowledge it reads alongside it. */
const FINDINGS_LIMIT = 8_000;
/** Sources the model may claim. Beyond this it is padding, not citing. */
const MAX_SOURCES = 25;

// ---------------------------------------------------------------------------
// Triage
// ---------------------------------------------------------------------------

const TriageSchema = z.object({
  ready: z
    .boolean()
    .describe(
      'True if the request can be worked as written. False ONLY if a wrong reading would waste the whole errand.',
    ),
  brief: z
    .string()
    .describe(
      'The request restated as an unambiguous objective, in the language it was written in. Required when ready is true.',
    ),
  question: z
    .string()
    .describe('The single question that would unblock this. Empty string when ready is true.'),
  why: z
    .string()
    .describe('One sentence: what goes wrong if this is guessed. Empty string when ready is true.'),
  options: z
    .array(z.string())
    .describe('Two to four concrete answers the person could pick. Empty array when ready is true.'),
});

export type TriageOutcome =
  | { ready: true; brief: string; tokens: number }
  | { ready: false; question: string; why: string; options: string[]; tokens: number };

const TRIAGE_SYSTEM = `You are the intake desk of an autonomous errand service. Somebody has handed you a job that will run unattended for up to an hour. Your only decision: can this be worked as written, or would a wrong reading waste the whole thing?

ASK ONLY WHEN GUESSING WOULD RUIN IT. The test is not "could this be more precise" — everything could. The test is: are there two plausible readings that would produce completely different work? If yes, ask. If the readings differ only in emphasis, do not ask; note the ambiguity in the brief and work the most useful reading.

You get ONE question. Not two, not a checklist. Somebody is looking at a screen right now and will answer a question; they will abandon a form.

Offer two to four concrete options with the question. "¿Marítima o terrestre?" is answerable in a second; "¿podrías precisar el alcance?" is not.

When you accept, write the brief as a self-contained objective: what to find, what to produce, what counts as done. Keep the person's own words for the subject matter — they know the domain and you do not. Never widen the request, never add deliverables they did not ask for.

Write the brief, the question, the reason and the options in the SAME LANGUAGE the request was written in.`;

export async function triageRequest(input: {
  kind: ErrandKind;
  request: string;
  model?: string | null;
}): Promise<TriageOutcome> {
  const spec = ERRAND_KIND_SPECS[input.kind];
  try {
    const { object, usage } = await generateObject({
      model: chatModel(input.model),
      schema: TriageSchema,
      system: TRIAGE_SYSTEM,
      prompt: [
        `KIND OF ERRAND: ${spec.label} — ${spec.blurb}`,
        `WHAT THIS KIND MUST PRODUCE\n${spec.deliverableBrief}`,
        `THE REQUEST\n${input.request}`,
        'Decide.',
      ].join('\n\n'),
      // A shape-constrained call with an explicit schema: extended thinking
      // buys little and its tokens count against maxTokens, which would
      // truncate the brief. Same argument as the orchestrator's planner.
      experimental_providerMetadata: NO_THINKING,
      maxTokens: 2048,
    });

    const tokens = usage?.totalTokens ?? 0;
    const question = object.question.trim();

    if (object.ready || !question) {
      const brief = object.brief.trim().slice(0, BRIEF_LIMIT) || input.request;
      return { ready: true, brief, tokens };
    }

    return {
      ready: false,
      question: question.slice(0, 600),
      why:
        object.why.trim().slice(0, 600) ||
        'Hay dos maneras de leer lo que pediste y llevan a resultados distintos.',
      options: object.options
        .map((o) => o.trim())
        .filter(Boolean)
        .slice(0, 4),
      tokens,
    };
  } catch (err) {
    // Accept the request as written. The person asked for work to happen; a
    // broken intake desk must not be the reason it does not.
    logger.error('errands: triage failed, accepting the request as written', {
      error: (err as Error).message,
    });
    return { ready: true, brief: input.request.slice(0, BRIEF_LIMIT), tokens: 0 };
  }
}

// ---------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------

const SourceSchema = z.object({
  title: z.string().describe('What this source is, in a few words.'),
  url: z.string().describe('The URL it was read from. Empty string for an internal source.'),
});

const AssessSchema = z.object({
  verdict: z
    .enum(['deliver', 'ask', 'continue', 'unchanged'])
    .describe(
      'deliver: this answers the request. ask: a fork only a person can pick. continue: real progress but a concrete gap remains. unchanged: monitors only, nothing moved since the baseline.',
    ),
  deliverable: z
    .string()
    .describe('The finished answer in markdown, following the required shape. Empty unless deliver.'),
  note: z.string().describe('One sentence closing the errand for the person. Empty unless deliver.'),
  sources: z.array(SourceSchema).describe('Everything the deliverable rests on. Empty unless deliver.'),
  question: z.string().describe('The single question. Empty unless ask.'),
  why: z.string().describe('Why the errand cannot sensibly continue without it. Empty unless ask.'),
  options: z.array(z.string()).describe('Two to four concrete answers. Empty unless ask.'),
  nextObjective: z
    .string()
    .describe('A self-contained objective for the next leg, naming the specific gap. Empty unless continue.'),
  findings: z
    .string()
    .describe('Everything established so far, rewritten to stand alone. Required for continue, useful otherwise.'),
  reading: z
    .string()
    .describe('The current reading, in the same line-per-value shape as the baseline. Empty unless unchanged.'),
});

const ASSESS_SYSTEM = `You are running an autonomous errand. A leg of work just finished and you are the only one who sees both what was asked and what came back. Decide what happens next.

FOUR VERDICTS, and the honest one is usually not "deliver":

  deliver    What came back answers the request. Write the finished deliverable now, in the shape the errand requires. This is your last word — nobody edits it after you.

  ask        There is a fork you cannot pick for the person: two defensible directions, a contradiction between sources, a definition only they know. ASK, do not guess. Guessing produces a document that is wrong in a way nobody catches until they act on it.

  continue   Real progress, and a NAMED, CONCRETE gap another leg would close. Not "more detail would be nice" — a specific missing thing, with an objective that says how to get it. If you cannot name the gap in one sentence, the verdict is deliver or ask.

  unchanged  Monitors only. Compare today's reading with the baseline. Nothing that a person would call a change: say so and give today's reading.

RULES YOU DO NOT GET A VOTE ON:
- Never invent a figure, a name, a price or a date. If the leg did not find it, it is missing, and a missing thing named is worth more than a plausible thing invented.
- Every claim in the deliverable that came from outside carries a bracketed marker — [1], [2] — matching the position of its source in your sources array.
- Say what is missing, plainly, in its own words. A gap papered over is the one thing that makes the whole document untrustworthy.
- Write everything in the language of the request.

YOU CANNOT SEND, BUY, BOOK OR COMMIT ANYTHING, and neither can the legs. If your conclusion is that somebody should write to these suppliers or book that flight, say so as a recommendation in the deliverable. Somebody will read it and decide.`;

export interface AssessInput {
  kind: ErrandKind;
  request: string;
  brief: string;
  /** What earlier legs established. */
  priorFindings: string | null;
  /** The reading a monitor is comparing against. */
  baseline: string | null;
  /** Answered clarifications, oldest first. */
  answered: Array<{ question: string; answer: string }>;
  /** The report the finished leg produced. */
  legSummary: string | null;
  /** One line per sub-agent: what it was for and how it ended. */
  taskDigest: string;
  /** Legs still affordable after this one. Zero means this is the last word. */
  legsLeft: number;
  model?: string | null;
}

export interface AssessOutcome {
  assessment: Assessment;
  tokens: number;
}

export async function assessLeg(input: AssessInput): Promise<AssessOutcome> {
  const spec = ERRAND_KIND_SPECS[input.kind];

  const sections = [
    `KIND OF ERRAND: ${spec.label}`,
    `WHAT A FINISHED DELIVERABLE MUST LOOK LIKE\n${spec.deliverableBrief}`,
    `WHAT THE PERSON ASKED FOR, IN THEIR WORDS\n${input.request}`,
    `THE OBJECTIVE BEING WORKED\n${input.brief}`,
  ];

  if (input.answered.length > 0) {
    sections.push(
      `WHAT THEY ALREADY CLARIFIED\n${input.answered
        .map((a) => `- ${a.question}\n  → ${a.answer}`)
        .join('\n')}`,
    );
  }
  if (input.priorFindings) {
    sections.push(`WHAT EARLIER LEGS ESTABLISHED\n${input.priorFindings.slice(0, FINDINGS_LIMIT)}`);
  }
  if (input.baseline) {
    sections.push(
      `THE BASELINE READING TO COMPARE AGAINST\n${input.baseline.slice(0, FINDINGS_LIMIT)}`,
    );
  }
  sections.push(`THE SUB-AGENTS THAT JUST RAN\n${input.taskDigest}`);
  sections.push(
    `WHAT THIS LEG PRODUCED\n${(input.legSummary ?? '(nothing — the leg produced no report)').slice(0, LEG_INPUT_LIMIT)}`,
  );
  sections.push(
    input.legsLeft > 0
      ? `You may commission ${input.legsLeft} more ${input.legsLeft === 1 ? 'leg' : 'legs'} if a concrete gap justifies it.`
      : 'THIS IS THE LAST LEG THIS ERRAND CAN AFFORD. "continue" is no longer available: deliver what exists, naming what is missing, or ask.',
  );
  sections.push('Decide.');

  try {
    const { object, usage } = await generateObject({
      model: chatModel(input.model),
      schema: AssessSchema,
      system: ASSESS_SYSTEM,
      prompt: sections.join('\n\n'),
      // Headroom for a full comparison table plus its reading. A short cap
      // here truncates the deliverable mid-sentence, which is the one failure
      // that looks like the model being stupid rather than the cap being low.
      maxTokens: 8192,
    });

    return { assessment: normalise(object), tokens: usage?.totalTokens ?? 0 };
  } catch (err) {
    // Fail towards a person, never towards a verdict. "I could not work out
    // what this means" is a legitimate thing to say and a terrible thing to
    // decide silently.
    logger.error('errands: assessment failed, asking instead of guessing', {
      error: (err as Error).message,
    });
    return {
      assessment: {
        verdict: 'ask',
        question: '¿Quieres que lo intente otra vez o que te entregue lo que ya tiene?',
        why:
          'No logré leer lo que trajo esta vuelta —falló el paso que decide qué sigue—, y prefiero ' +
          'preguntarte antes que darte por buena una conclusión que no revisé. Lo que encontró está guardado.',
        options: ['Inténtalo otra vez', 'Entrégame lo que tengas'],
      },
      tokens: 0,
    };
  }
}

/**
 * The model's flat object becomes the discriminated union the engine folds.
 *
 * Every branch has a fallback into `ask`, because an assessment that came back
 * shaped like a verdict but empty of content is exactly the case where
 * inventing a completion would be worst.
 */
function normalise(raw: z.infer<typeof AssessSchema>): Assessment {
  const trimmed = {
    deliverable: raw.deliverable.trim(),
    note: raw.note.trim(),
    question: raw.question.trim(),
    why: raw.why.trim(),
    nextObjective: raw.nextObjective.trim(),
    findings: raw.findings.trim(),
    reading: raw.reading.trim(),
  };

  switch (raw.verdict) {
    case 'deliver':
      if (!trimmed.deliverable) break;
      return {
        verdict: 'deliver',
        deliverable: trimmed.deliverable,
        note: trimmed.note,
        sources: cleanSources(raw.sources),
      };
    case 'continue':
      if (!trimmed.nextObjective) break;
      return {
        verdict: 'continue',
        nextObjective: trimmed.nextObjective,
        findings: trimmed.findings || trimmed.deliverable,
      };
    case 'unchanged':
      if (!trimmed.reading) break;
      return { verdict: 'unchanged', reading: trimmed.reading };
    case 'ask':
      break;
  }

  return {
    verdict: 'ask',
    question: trimmed.question || '¿Cómo quieres que siga con esto?',
    why:
      trimmed.why ||
      'Lo que trajo esta vuelta no alcanza para cerrar el encargo y no quiero elegir por ti.',
    options: raw.options
      .map((o) => o.trim())
      .filter(Boolean)
      .slice(0, 4),
  };
}

function cleanSources(raw: Array<{ title: string; url: string }>): ErrandSource[] {
  const readAt = new Date().toISOString();
  const seen = new Set<string>();
  const out: ErrandSource[] = [];
  for (const item of raw) {
    const title = item.title.trim();
    if (!title) continue;
    const url = item.url.trim();
    const key = url || title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      title: title.slice(0, 300),
      url: /^https?:\/\//i.test(url) ? url.slice(0, 2000) : null,
      readAt,
    });
    if (out.length >= MAX_SOURCES) break;
  }
  return out;
}
