import type { SlotType, Step, Variable } from './types';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE SLOTS OF A TRÁMITE: WHAT CHANGES BETWEEN ONE RUN AND THE NEXT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A recorded flow is a procedure with holes in it. The holes have always been
 * there — `{{placa}}` in a step's template, declared as a `variable` on the
 * flow — and for a year that was enough, because there was exactly one thing
 * that filled them: a person typing into the box next to the label.
 *
 * This module exists because that stopped being the only filler. A slot is now
 * filled from a Drive sheet, from a document the extraction pass read, from
 * what the PREVIOUS trámite of the same errand brought back. And the moment
 * the value stops passing under a human's eyes on its way in, two things that
 * were free stop being free:
 *
 *   1. SHAPE. Drive says `900.123.456-7`; the DIAN's box wants `9001234567`.
 *      Nobody is there to notice. The portal answers «no se encontró
 *      información», classify.ts reads that as a LEGITIMATE refusal — which is
 *      the verdict that means "stop, do not retry, the answer will be the
 *      same" — and the errand reports, correctly and uselessly, that the
 *      company has no records. A wrong answer delivered confidently, from a
 *      dash.
 *
 *   2. ABSENCE. A hole nobody filled used to be caught by an empty form field.
 *      Unattended, `{{nit}}` renders as the literal string `{{nit}}`, gets
 *      typed into the box, and the same thing happens.
 *
 * So: every value entering a run is normalised by its declared type and
 * checked against it, HERE, in one place, with no database, no browser and no
 * model — which is what makes the rules above readable as rules and testable
 * as functions.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ────────────────────────────────────
 *
 * It does not reject values it merely dislikes. `text` is the default and
 * passes everything through untouched, and the typed rules only ever normalise
 * a shape a person plainly meant — `15/03/2026` is a date, `abc123` is a
 * plate. A validator that guessed harder would start refusing the one portal
 * whose field really does want the dashes, and the failure mode of a rule that
 * is too strict is a trámite that cannot be taught at all.
 */

// ---------------------------------------------------------------------------
// Normalising one value
// ---------------------------------------------------------------------------

/** Digits, and nothing else. */
function digits(text: string): string {
  return text.replace(/\D+/g, '');
}

/**
 * The Colombian NIT as a portal wants it: the number, without the check digit.
 *
 * `900.123.456-7` is one number and one check digit, and EVERY government
 * portal in the country asks for them in two separate boxes. Handing the whole
 * thing to the first box is the single most common way an otherwise correct
 * trámite comes back empty.
 *
 * The dash is what carries the meaning, so it is the only thing trusted: a NIT
 * written with one loses the tail, and one written without keeps every digit.
 * Guessing from length instead would corrupt the NITs of the many companies
 * whose number is nine digits with no verification digit written down.
 */
function normaliseNit(text: string): string {
  const trimmed = text.trim();
  const dashed = /^([\d.\s]+)[-–—]\s*(\d)$/.exec(trimmed);
  if (dashed?.[1]) return digits(dashed[1]);
  return digits(trimmed);
}

/**
 * A date the way a form field wants it, from the way a person writes it.
 *
 * `d/m/y` is read day-first, which is what it means in Colombia and the
 * opposite of what `new Date()` would decide. ISO input passes through. Two
 * digit years are NOT expanded — «03/15/26» is ambiguous in a way no guess
 * improves, so it is left alone for the portal to reject visibly rather than
 * silently turned into 1926.
 */
function normaliseDate(text: string): string {
  const trimmed = text.trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed);
  if (iso?.[1] && iso[2] && iso[3]) {
    return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  }
  const dmy = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec(trimmed);
  if (dmy?.[1] && dmy[2] && dmy[3]) {
    return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  }
  return trimmed;
}

/**
 * An amount as digits.
 *
 * Colombian notation is `$ 1.234.567,89` — dots group, the comma is the
 * decimal point, and that is the reverse of the English convention. Portals
 * that take money almost always want the whole pesos with no punctuation, so
 * the decimals are dropped rather than converted: a form that wanted cents
 * would have had a second box for them.
 */
function normaliseMoney(text: string): string {
  const cleaned = text.replace(/[^\d,.-]/g, '').trim();
  const decimal = /^(-?[\d.]+),(\d{1,2})$/.exec(cleaned);
  const whole = decimal?.[1] ?? cleaned;
  const negative = whole.startsWith('-');
  return `${negative ? '-' : ''}${digits(whole)}`;
}

/**
 * Put one value into the shape its slot declares.
 *
 * Total: every type returns something for every input, including nonsense.
 * Deciding whether the result is USABLE is `checkSlots`' job, one level up —
 * separated so that "what shape is this" and "is this missing" stay two
 * questions with two answers.
 */
export function normaliseSlot(type: SlotType, raw: string): string {
  const trimmed = raw.trim();
  switch (type) {
    case 'number':
      return digits(trimmed.replace(/[.\s]/g, ''));
    case 'money':
      return normaliseMoney(trimmed);
    case 'date':
      return normaliseDate(trimmed);
    case 'nit':
      return normaliseNit(trimmed);
    case 'plate':
      return trimmed.toUpperCase().replace(/[^A-Z0-9]/g, '');
    case 'email':
      return trimmed.toLowerCase();
    // A code is typed exactly as it arrived, minus the spaces a phone puts in
    // the middle of a six-digit number. Nothing else: a portal that wants
    // letters in its OTP is a portal, not a bug.
    case 'code':
      return trimmed.replace(/\s+/g, '');
    // A file reference is a machine string; upper- or lower-casing a bucket
    // path would break it. See uploads.ts.
    case 'file':
      return trimmed;
    default:
      return trimmed;
  }
}

// ---------------------------------------------------------------------------
// Filling a whole flow's slots
// ---------------------------------------------------------------------------

export interface SlotFill {
  /** Every declared slot that had a usable value, normalised. */
  inputs: Record<string, string>;
  /** Labels of required slots nobody filled. Empty means "go". */
  missing: string[];
  /**
   * Slots the caller sent that the flow does not declare. Dropped, not
   * refused: an errand assembling inputs from a document will occasionally
   * offer a field the trámite has no box for, and that is not a reason to
   * abandon a run whose actual slots are all present. Reported so it can be
   * logged rather than disappearing.
   */
  unknown: string[];
  /**
   * Required slots whose value normalised down to nothing — «-», «N/A», a NIT
   * that was only a dash. Reported apart from `missing` because the sentence a
   * person needs is different: something WAS supplied and it was not usable,
   * which points at the source rather than at the request.
   */
  unusable: string[];
}

/**
 * Take whatever a caller offers and produce the inputs a run may use.
 *
 * The order is load-bearing. Normalisation happens BEFORE emptiness is judged,
 * so a NIT of `-` and a plate of `   ` are caught as unusable rather than
 * typed into a portal as one dash. And unknown keys are dropped before
 * anything else, so a caller cannot smuggle a value into a slot the flow never
 * declared — which is the same rule `safeInputs` applies on the way out to a
 * row, applied here on the way in to a browser.
 */
export function fillSlots(
  variables: readonly Variable[],
  offered: Record<string, string>,
): SlotFill {
  const declared = new Map(variables.map((v) => [v.name, v]));
  const inputs: Record<string, string> = {};
  const missing: string[] = [];
  const unusable: string[] = [];
  const unknown = Object.keys(offered).filter((key) => !declared.has(key));

  for (const variable of variables) {
    const raw = offered[variable.name];
    if (raw === undefined || raw === null) {
      if (variable.required) missing.push(variable.label);
      continue;
    }
    const value = normaliseSlot(variable.type ?? 'text', String(raw));
    if (value.length === 0) {
      if (variable.required) unusable.push(variable.label);
      continue;
    }
    inputs[variable.name] = value;
  }

  return { inputs, missing, unknown, unusable };
}

/**
 * The sentence to hand a person when a run cannot start, or null when it can.
 *
 * One function rather than a string assembled at each call site, because this
 * text reaches three surfaces — the run button, the chat, an errand's question
 * — and they must not drift into telling somebody three different things about
 * the same missing plate.
 */
export function slotComplaint(fill: SlotFill, flowName: string): string | null {
  if (fill.missing.length === 0 && fill.unusable.length === 0) return null;
  const parts: string[] = [];
  if (fill.missing.length > 0) {
    parts.push(`me falta ${fill.missing.join(', ')}`);
  }
  if (fill.unusable.length > 0) {
    parts.push(
      `lo que me pasaron para ${fill.unusable.join(', ')} no sirve como dato (llegó vacío o sólo con signos)`,
    );
  }
  return `Para hacer «${flowName}» ${parts.join(' y ')}.`;
}

// ---------------------------------------------------------------------------
// Which slots a flow actually uses, and where
// ---------------------------------------------------------------------------

const HOLE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** Every `{{hole}}` named anywhere in a step list, in order of first sight. */
export function holesIn(steps: readonly Step[]): string[] {
  const seen = new Set<string>();
  const consider = (text: string | undefined) => {
    if (!text) return;
    for (const match of text.matchAll(HOLE)) {
      const name = match[1];
      if (name) seen.add(name);
    }
  };
  for (const step of steps) {
    consider(step.url);
    if (step.value?.kind === 'template') consider(step.value.text);
    if (step.value?.kind === 'file') consider(step.value.from);
  }
  return [...seen];
}

/**
 * Does what the flow DECLARES match what its steps actually ask for?
 *
 * The two halves are written by different things — the variables by a person
 * on the review screen, the holes by the model that read the recording — so
 * they drift, and each direction of drift breaks something different:
 *
 *   a hole with no variable    nothing will ever fill it; the literal text
 *                              `{{nit}}` is typed into the portal
 *   a variable with no hole    the run demands a value it will not use, which
 *                              is how a trámite ends up asking an errand for a
 *                              plate it never types anywhere
 *
 * A `pause` step's `extractAs` counts as a filler on the declaring side: the
 * slot it fills is supplied mid-run by a person, so it is legitimately
 * declared, legitimately used in a later hole, and legitimately absent from
 * the inputs a caller has to provide.
 */
export function auditSlots(
  variables: readonly Variable[],
  steps: readonly Step[],
): { undeclared: string[]; unused: string[] } {
  const declared = new Set(variables.map((v) => v.name));
  const used = new Set(holesIn(steps));
  const filledByPause = new Set(
    steps.filter((s) => s.action === 'pause' && s.extractAs).map((s) => s.extractAs as string),
  );
  return {
    undeclared: [...used].filter((name) => !declared.has(name) && !filledByPause.has(name)),
    unused: [...declared].filter((name) => !used.has(name)),
  };
}

/**
 * The slots a CALLER has to supply, which is not the same as the slots a flow
 * declares.
 *
 * A slot a `pause` step fills is answered by a person while the run is already
 * open in a tab — asking for it up front would be asking somebody for a code
 * that has not been sent yet. This is the list the tool descriptions advertise
 * and the list `missingSlots` is computed against.
 */
export function callerSlots(variables: readonly Variable[], steps: readonly Step[]): Variable[] {
  const filledByPause = pauseFilled(steps);
  return variables.filter((v) => !filledByPause.has(v.name));
}

function pauseFilled(steps: readonly Step[]): Set<string> {
  return new Set(
    steps.filter((s) => s.action === 'pause' && s.extractAs).map((s) => s.extractAs as string),
  );
}

/**
 * The slots as a RUN should judge them, which is not the same as either of the
 * two lists above.
 *
 * A pause-filled slot is not dropped — if a caller happens to have the value
 * already (a retry, a code somebody read out before it was asked for) it is
 * perfectly good and typing it saves a round trip. It is only relieved of
 * being REQUIRED, because demanding it up front would mean asking somebody for
 * a code the bank has not sent yet.
 *
 * Dropping it instead was the first version of this, and it was wrong in a way
 * a test caught: the value was silently discarded and the run stopped to ask
 * for something it had been handed.
 */
export function runnableSlots(variables: readonly Variable[], steps: readonly Step[]): Variable[] {
  const filledByPause = pauseFilled(steps);
  return variables.map((v) => (filledByPause.has(v.name) ? { ...v, required: false } : v));
}
