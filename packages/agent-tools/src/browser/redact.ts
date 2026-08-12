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
  'otp',
  'codigo de verificacion',
  'código de verificación',
  'segunda clave',
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

/** What a value is allowed to look like in a run row, a trace or a log. */
export function redactValue(value: StepValue | undefined, inputs: Record<string, string>): string {
  if (!value) return '';
  if (value.kind === 'secret') return REDACTED;
  const text =
    value.kind === 'template'
      ? value.text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (whole, key: string) =>
          Object.hasOwn(inputs, key) ? (inputs[key] ?? '') : whole,
        )
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
    const isCredential =
      looksLikeCredentialField(step.label) ||
      step.targets.some(
        (t) => looksLikeCredentialField(t.value) || looksLikeCredentialField(t.name ?? ''),
      );
    if (!isCredential) return step;
    redacted += 1;
    return {
      ...step,
      value: { kind: 'secret' as const, field: fieldNameFor(step.label) },
    };
  });
  return { steps: out, redacted };
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
 * Strip anything that is not a variable out of a run's recorded inputs.
 *
 * Belt and braces over the type system: `inputs` is typed as the variables and
 * nothing else, but this is the value that gets written to a row people can
 * read, so it is filtered against the flow's declared variable names rather
 * than trusted to be already clean.
 */
export function safeInputs(
  inputs: Record<string, string>,
  variableNames: string[],
): Record<string, string> {
  const allowed = new Set(variableNames);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(inputs)) {
    if (!allowed.has(key)) continue;
    out[key] = value.length > 200 ? `${value.slice(0, 200)}…` : value;
  }
  return out;
}
