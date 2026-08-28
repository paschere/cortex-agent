import type { Step, StepValue } from './types';

/**
 * Keeping a credential out of everything that is not the errand itself.
 *
 * There are exactly two moments where a secret exists in this system as
 * readable text: inside `browser_credentials.secret_encrypted`, and inside the
 * body of the one HTTPS request that hands it to the browser service. This file
 * is what guarantees there is no third -- not a run row, not a step trace, not
 * a log line, not an API response, not a model prompt.
 *
 * THE RULE IS A CONSTANT, NOT A TRANSFORMATION. `'***'` is a fixed string with
 * no relationship to the value it stands for. Not the first character, not the
 * last four, and above all not the length: a password manager's report will
 * tell you how much a length narrows a search, and "eight characters" plus a
 * known portal is a materially easier problem than "unknown".
 */

export const REDACTED = '***';

/**
 * Words that mean a field holds a credential.
 *
 * Used in two places, and it is the second one that matters. The first is
 * cosmetic: labelling a step on screen. The second is the last line of defence
 * on the teaching path -- a model reading a screen recording is TOLD never to
 * transcribe a credential, and `enforceSecrets` below assumes it did anyway.
 * A model instruction is a request; this is the check.
 */
const CREDENTIAL_WORDS = [
  'contrasena',
  'contraseña',
  'clave',
  'password',
  'passwd',
  'pin',
  'token',
  'usuario',
  'user',
  'username',
  'correo de acceso',
  'login',
  'credencial',
  'secreto',
  'segunda clave',
];

/**
 * A CODE THAT ARRIVES, WHICH IS NOT A CREDENTIAL AND USED TO BE FILED AS ONE.
 *
 * These words lived in the list above, and the effect was subtle and total: the
 * extractor saw «Código de verificación» in the recording, `enforceSecrets`
 * rewrote the step as `{kind:'secret', field:'codigo_de_verificacion'}`, and
 * the trámite was then permanently waiting for somebody to store, in an
 * encrypted column, A NUMBER THAT CHANGES EVERY NINETY SECONDS. There is no
 * value anybody could have put there that would ever have been right. The
 * trámite could be taught, could be reviewed, could be bound to a credential —
 * and could never run.
 *
 * Split out because the two things need opposite treatment. A password is a
 * fact about the account and belongs in `browser_credentials`, encrypted, once.
 * A one-time code is a fact about THIS MINUTE and belongs nowhere: it is asked
 * for while the tab is open and forgotten the moment it is typed. That is what
 * a `pause` step is, and `pauseForOneTimeCodes` below is what turns the one the
 * recording found into one.
 *
 * They are still both kept out of the recording's transcribed text, which is
 * what the old grouping was really protecting. Nothing here makes a code more
 * quotable — it makes it un-storable, which is stricter.
 */
const ONE_TIME_WORDS = [
  'otp',
  'codigo de verificacion',
  'código de verificación',
  'codigo de seguridad',
  'código de seguridad',
  'codigo temporal',
  'código temporal',
  'token sms',
  'codigo sms',
  'código sms',
  'doble factor',
  'segundo factor',
];

function fold(text: string): string {
  return (
    text
      .normalize('NFD')
      // biome-ignore lint/suspicious/noMisleadingCharacterClass: stripping combining marks is the intent
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
  );
}

/** Does this label name a field a person would type a credential into? */
export function looksLikeCredentialField(label: string): boolean {
  const folded = fold(label);
  return CREDENTIAL_WORDS.some((word) => folded.includes(fold(word)));
}

/** Does this label name the code that arrives by SMS while the trámite waits? */
export function looksLikeOneTimeCode(label: string): boolean {
  const folded = fold(label);
  return ONE_TIME_WORDS.some((word) => folded.includes(fold(word)));
}

/** What a value is allowed to look like in a run row, a trace or a log. */
export function redactValue(value: StepValue | undefined, inputs: Record<string, string>): string {
  if (!value) return '';
  if (value.kind === 'secret') return REDACTED;
  const fill = (raw: string) =>
    raw.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (whole, key: string) =>
      Object.hasOwn(inputs, key) ? (inputs[key] ?? '') : whole,
    );
  // A file step's value is a REFERENCE — `doc:<uuid>`, a bucket path — and
  // showing it is the right thing to show: it names which document was
  // attached without revealing a byte of it, which is exactly what somebody
  // auditing a filing wants to see.
  const text =
    value.kind === 'file'
      ? fill(value.from)
      : value.kind === 'template'
        ? fill(value.text)
        : value.text;
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/**
 * The teaching-path defence: rewrite any step that looks like it types a
 * credential so that it CANNOT carry the characters, whatever the extractor
 * produced.
 *
 * Two triggers, and the first is the one that catches the case nobody plans
 * for. `sawMaskedInput` is set by the extractor when the frames showed a field
 * rendering as dots -- somebody typing their password with the recording
 * running, which will happen on the first day. The second is the field's own
 * label, which catches a portal that renders its credential field as plain
 * text, and catches the "show password" eye toggle.
 *
 * The rewrite is destructive on purpose. Whatever text came back is dropped
 * here, before the proposal is returned to the browser, before it is stored,
 * before it is rendered. The step becomes a hole that has to be filled by
 * binding a stored credential -- which is where a password belongs anyway.
 */
export function enforceSecrets(steps: Step[]): { steps: Step[]; redacted: number } {
  let redacted = 0;
  const out = steps.map((step) => {
    if (!step.value || step.value.kind === 'secret') return step;
    const words = [step.label, ...step.targets.flatMap((t) => [t.value, t.name ?? ''])];
    // A one-time code is checked FIRST and is not a credential. It is left for
    // `pauseForOneTimeCodes` to turn into a pause; rewriting it as a secret
    // here would produce a trámite waiting forever for somebody to store a
    // number that expires in ninety seconds. What still must not survive is
    // the digits the recording captured, so the value is emptied.
    if (words.some(looksLikeOneTimeCode)) {
      redacted += 1;
      return { ...step, value: { kind: 'template' as const, text: hole(step.label) } };
    }
    if (!words.some(looksLikeCredentialField)) return step;
    redacted += 1;
    return {
      ...step,
      value: { kind: 'secret' as const, field: fieldNameFor(step.label) },
    };
  });
  return { steps: out, redacted };
}

/** `{{codigo_de_verificacion}}`, from what the field was called on the page. */
function hole(label: string): string {
  return `{{${fieldNameFor(label)}}}`;
}

/**
 * Turn a one-time code the recording found into the pause that asks for it.
 *
 * ── WHY THIS IS A REWRITE AND NOT A WARNING ───────────────────────────────
 *
 * The alternative was to notice the OTP field, tell the person on the review
 * screen, and let them add the pause by hand. That reads as respectful and is
 * not: the person who just recorded a bank login does not know what a `pause`
 * step is, has no reason to, and the trámite that results from them skipping it
 * is one that types an empty string into a code box and fails at 3am with «no
 * lo encontré». The whole promise of teaching from a recording is that the
 * person does the errand once and Cortex works out the machinery.
 *
 * So the pause is INSERTED, immediately before the step that types the code,
 * with the field's own words as the question — «Código de verificación» is what
 * the portal called it and therefore what the person will recognise on their
 * phone. The step that follows already carries `{{that_name}}` from
 * `enforceSecrets`, so the two halves line up by construction: the pause fills
 * the slot, the fill types it.
 *
 * Idempotent. A step already preceded by a pause that fills its hole is left
 * alone, so re-teaching a trámite does not accumulate pauses.
 */
export function pauseForOneTimeCodes(steps: Step[]): { steps: Step[]; added: string[] } {
  const out: Step[] = [];
  const added: string[] = [];

  for (const step of steps) {
    const name =
      step.value?.kind === 'template'
        ? /^\{\{\s*([a-zA-Z0-9_]+)\s*\}\}$/.exec(step.value.text)?.[1]
        : undefined;
    const isCode = name !== undefined && looksLikeOneTimeCode(step.label);
    const alreadyAsked = isCode && out.some((s) => s.action === 'pause' && s.extractAs === name);

    if (isCode && !alreadyAsked && name) {
      out.push({
        action: 'pause',
        label: `Dime el ${step.label.toLowerCase()} que te acaba de llegar`,
        targets: [],
        landmarks: step.landmarks,
        extractAs: name,
      });
      added.push(name);
    }
    out.push(step);
  }

  return { steps: out, added };
}

/**
 * A stable field name for a credential hole, derived from what the field was
 * called on the page. `usuario`, `clave`, `codigo_de_verificacion`. Derived
 * rather than sequential so that re-teaching the same errand produces the same
 * names and an existing credential still binds.
 */
export function fieldNameFor(label: string): string {
  const slug = fold(label)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return slug || 'secreto';
}

/**
 * Strip anything that is not a variable out of a run's recorded inputs, and
 * blank the slots whose whole nature is to be single-use.
 *
 * Belt and braces over the type system: `inputs` is typed as the variables and
 * nothing else, but this is the value that gets written to a row people can
 * read, so it is filtered against the flow's declared variable names rather
 * than trusted to be already clean.
 *
 * ── A `code` SLOT IS A SECOND KIND OF SECRET ──────────────────────────────
 * The OTP a bank texts is not a credential — it is not stored anywhere, nobody
 * can rotate it, and it is worthless in ninety seconds. That makes it easy to
 * treat as ordinary data, and it is not: for those ninety seconds it is the
 * SECOND factor of an account whose first factor is already sitting encrypted
 * in this same database. Writing it into `browser_flow_runs.inputs` — a column
 * rendered on the run history screen, forever — would put both halves of a
 * bank login on one page.
 *
 * So it is dropped here, at the one place a run's inputs become a row. The
 * caller may pass plain names (every call site before slots existed) or the
 * declared variables; only the second form can know which slots are codes,
 * which is why the parameter widened rather than a second function appearing.
 */
export function safeInputs(
  inputs: Record<string, string>,
  variables: ReadonlyArray<string | { name: string; type?: string }>,
): Record<string, string> {
  const allowed = new Set<string>();
  const oneUse = new Set<string>();
  for (const variable of variables) {
    if (typeof variable === 'string') {
      allowed.add(variable);
      continue;
    }
    allowed.add(variable.name);
    if (variable.type === 'code') oneUse.add(variable.name);
  }

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(inputs)) {
    if (!allowed.has(key)) continue;
    if (oneUse.has(key)) {
      // Present rather than absent: the run DID have a code, and a row that
      // simply omitted it would read as a run that never needed one.
      if (value.length > 0) out[key] = REDACTED;
      continue;
    }
    out[key] = value.length > 200 ? `${value.slice(0, 200)}…` : value;
  }
  return out;
}
