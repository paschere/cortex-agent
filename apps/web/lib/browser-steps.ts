import type { Proposal, ProposedStep } from './browser-shape';

/**
 * Corregir lo que el modelo entendió, antes de que se vuelva un trámite.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * A recording is read once, by a model, from pictures. What comes back is
 * plausible and roughly right, and "roughly right" has three predictable
 * shapes: a step that is not a step (the cookie banner, a click on nothing), a
 * name written by a machine that a person will later read at 3am when the flow
 * fails, and a typed value frozen as a constant when it is the whole reason the
 * errand is worth repeating. Until those can be fixed on the review screen, the
 * only remedy is to record the errand again and hope the model reads it better.
 *
 * The rules live HERE, in a module with no React in it and no import of the
 * `@cortex/agent-tools` barrel, for two reasons. The screen needs them to know
 * which arrow to grey out; the POST route needs them because a rule enforced
 * only in a browser is not a rule. Both call the same functions, so the
 * sentence a person reads before saving is the same sentence the server would
 * have said.
 *
 * ---------------------------------------------------------------------------
 * THE ANCHOR
 * ---------------------------------------------------------------------------
 * A `goto` in first position is not an ordinary step: it is where the errand
 * starts. The replay service (services/browser/src/replay.ts) never navigates
 * on its own -- it opens a blank page and runs the list -- so a flow whose
 * first step is not a `goto` is a flow that does its first click on nothing.
 * And the address on that step is not the model's: `alignFirstGoto` overwrites
 * it with the URL the person confirmed in «Empieza en», because a shared tab
 * contains the page and not the address bar above it.
 *
 * So the anchor is pinned: nothing moves above it, it does not move down, it
 * cannot be deleted, and it cannot be optional. Everything else on the screen
 * can be reordered, renamed, removed and made optional.
 *
 * ---------------------------------------------------------------------------
 * THE DATUM THAT CHANGES
 * ---------------------------------------------------------------------------
 * There is already a mechanism for it and this file does not invent a second
 * one: `{kind:'template'}` with `{{holes}}`, filled at run time by
 * `renderTemplate`. Marking a value as variable is therefore two edits made
 * together -- the step's value becomes a template naming a hole, and the flow
 * declares a variable with that name -- which is exactly why they are done by
 * one function here instead of by two controls on a screen.
 */

export type ProposedVariable = Proposal['variables'][number];

/** Matches `proposalSchema` in agent-tools. Exceeding them is a 400, not a UI hint. */
export const MAX_STEPS = 60;
export const MAX_STEP_LABEL = 200;
export const MAX_VARIABLES = 12;

/** The same shape the flow engine reads holes with. Keep the two in step. */
const HOLE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** A variable name the engine and the schema both accept. */
const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/;

/* ---------------------------------------------------------------------------
 * Qué se puede hacer con cada paso
 * -------------------------------------------------------------------------*/

/** El arranque: un `goto` en la primera posición. See the note above. */
export function isAnchor(steps: ProposedStep[], index: number): boolean {
  return index === 0 && steps[0]?.action === 'goto';
}

export function canMoveUp(steps: ProposedStep[], index: number): boolean {
  if (index <= 0 || index >= steps.length) return false;
  // Nothing passes over the anchor, so the second step has nowhere to go.
  return !isAnchor(steps, index - 1);
}

export function canMoveDown(steps: ProposedStep[], index: number): boolean {
  if (index < 0 || index >= steps.length - 1) return false;
  return !isAnchor(steps, index);
}

/**
 * The anchor stays, and the last step standing stays: `proposalSchema` demands
 * at least one, and an empty list is not an edit anybody meant to make.
 */
export function canRemove(steps: ProposedStep[], index: number): boolean {
  if (index < 0 || index >= steps.length) return false;
  if (steps.length <= 1) return false;
  return !isAnchor(steps, index);
}

/**
 * Opcional means "the replay skips this when it cannot find it". Applied to the
 * step that opens the site it would mean "run the errand on a blank page if the
 * portal is down", which is not a thing anybody wants.
 */
export function canBeOptional(steps: ProposedStep[], index: number): boolean {
  return steps[index]?.action !== 'goto';
}

/**
 * Por qué la flecha está apagada, dicho para una persona.
 *
 * A control that is off and silent is indistinguishable from a control that is
 * broken, and the two reasons a step will not move are completely different
 * facts: one is «this is the start of the errand» and the other is «it is
 * already at the end». Both are said out loud, in the `title`.
 */
export function whyPinned(steps: ProposedStep[], index: number, direction: 'up' | 'down'): string {
  if (isAnchor(steps, index)) {
    return 'Este paso abre el sitio: es el arranque y va siempre de primero.';
  }
  if (direction === 'up' && index === 1 && isAnchor(steps, 0)) {
    return 'Nada puede ir antes del paso que abre el sitio.';
  }
  return direction === 'up' ? 'Ya es el primero.' : 'Ya es el último.';
}

/* ---------------------------------------------------------------------------
 * Las ediciones. Todas puras: devuelven una lista nueva.
 * -------------------------------------------------------------------------*/

export function moveStep(
  steps: ProposedStep[],
  index: number,
  direction: 'up' | 'down',
): ProposedStep[] {
  const allowed = direction === 'up' ? canMoveUp(steps, index) : canMoveDown(steps, index);
  if (!allowed) return steps;
  const target = direction === 'up' ? index - 1 : index + 1;
  const next = [...steps];
  const a = next[index];
  const b = next[target];
  if (!a || !b) return steps;
  next[index] = b;
  next[target] = a;
  return next;
}

export function removeStep(steps: ProposedStep[], index: number): ProposedStep[] {
  if (!canRemove(steps, index)) return steps;
  return steps.filter((_, i) => i !== index);
}

export function renameStep(steps: ProposedStep[], index: number, label: string): ProposedStep[] {
  return patchStep(steps, index, (step) => ({ ...step, label: label.slice(0, MAX_STEP_LABEL) }));
}

/**
 * `false` is written as an ABSENT key rather than as `optional: false`.
 * The engine reads truthiness either way; what this protects is the diff a
 * person sees between two versions of a flow, where a step that gained
 * `optional: false` looks like a change and is not one.
 */
export function setStepOptional(
  steps: ProposedStep[],
  index: number,
  optional: boolean,
): ProposedStep[] {
  if (optional && !canBeOptional(steps, index)) return steps;
  return patchStep(steps, index, (step) => {
    const { optional: _drop, ...rest } = step;
    return optional ? { ...rest, optional: true } : rest;
  });
}

/** Un valor fijo: el mismo texto en cada corrida. */
export function setStepLiteral(steps: ProposedStep[], index: number, text: string): ProposedStep[] {
  return patchStep(steps, index, (step) =>
    // A credential is never turned into typed text. See `checkSteps`.
    step.value?.kind === 'secret' ? step : { ...step, value: { kind: 'literal', text } },
  );
}

/** Un valor con {{huecos}}: lo que cambia en cada corrida. */
export function setStepTemplate(
  steps: ProposedStep[],
  index: number,
  text: string,
): ProposedStep[] {
  return patchStep(steps, index, (step) =>
    step.value?.kind === 'secret' ? step : { ...step, value: { kind: 'template', text } },
  );
}

function patchStep(
  steps: ProposedStep[],
  index: number,
  patch: (step: ProposedStep) => ProposedStep,
): ProposedStep[] {
  const step = steps[index];
  if (!step) return steps;
  const next = [...steps];
  next[index] = patch(step);
  return next;
}

/* ---------------------------------------------------------------------------
 * Los datos que cambian
 * -------------------------------------------------------------------------*/

/** `{{placa}}` — how a hole is written, in the one place it is written. */
export function hole(name: string): string {
  return `{{${name}}}`;
}

/** Every hole a step would ask the run for: in its typed value and in its URL. */
export function holesIn(step: ProposedStep): string[] {
  const sources = [step.value?.kind === 'template' ? step.value.text : '', step.url ?? ''];
  const found: string[] = [];
  for (const source of sources) {
    for (const match of source.matchAll(HOLE)) {
      const name = match[1];
      if (name && !found.includes(name)) found.push(name);
    }
  }
  return found;
}

export function usedVariableNames(steps: ProposedStep[]): Set<string> {
  const used = new Set<string>();
  for (const step of steps) for (const name of holesIn(step)) used.add(name);
  return used;
}

/**
 * Un nombre de variable a partir de lo que la persona escribió.
 *
 * The name is an identifier the engine substitutes on, not a caption: it has to
 * survive `variableSchema`'s regex, so accents are folded and everything else
 * becomes an underscore. The words the person typed live on in `label`.
 */
export function variableNameFrom(label: string, taken: Iterable<string> = []): string {
  const base =
    label
      .normalize('NFD')
      // biome-ignore lint/suspicious/noMisleadingCharacterClass: stripping combining marks is the intent
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/^([0-9])/, 'd$1')
      .slice(0, 36) || 'dato';
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base}_${n}`.slice(0, 40);
    if (!used.has(candidate)) return candidate;
  }
  return base;
}

/** Declarar un dato nuevo, o corregir el que ya existe con ese nombre. */
export function upsertVariable(
  variables: ProposedVariable[],
  variable: ProposedVariable,
): ProposedVariable[] {
  const at = variables.findIndex((v) => v.name === variable.name);
  const current = variables[at];
  if (at === -1 || !current) return [...variables, variable];
  const next = [...variables];
  next[at] = { ...current, ...variable };
  return next;
}

/**
 * Los datos que ya no usa ningún paso dejan de estar declarados.
 *
 * Turning a variable back into a fixed value has to remove the variable too, or
 * the review screen keeps asking for a test value for something nothing reads,
 * and the saved flow carries an input nobody can satisfy. Done by recomputing
 * from the steps rather than by bookkeeping on every edit: the steps are the
 * truth about what the errand asks for.
 */
export function pruneVariables(
  variables: ProposedVariable[],
  steps: ProposedStep[],
): ProposedVariable[] {
  const used = usedVariableNames(steps);
  return variables.filter((v) => used.has(v.name));
}

/**
 * Marcar el valor de un paso como el dato que cambia, y declararlo de una vez.
 *
 * The example is seeded with whatever was recorded -- the plate the person
 * actually typed -- so the proving run has something real to type and the
 * screen shows it instead of an empty box.
 */
export function markStepAsVariable(
  input: { steps: ProposedStep[]; variables: ProposedVariable[]; sample: Record<string, string> },
  index: number,
  variable: { name: string; label: string },
): { steps: ProposedStep[]; variables: ProposedVariable[]; sample: Record<string, string> } {
  const step = input.steps[index];
  if (!step || step.value?.kind === 'secret') return input;

  const recorded = step.value?.kind === 'literal' ? step.value.text : '';
  const already = input.variables.find((v) => v.name === variable.name);
  const example = already?.example || recorded;

  const steps = setStepTemplate(input.steps, index, hole(variable.name));
  const variables = pruneVariables(
    upsertVariable(input.variables, {
      name: variable.name,
      label: variable.label || already?.label || variable.name,
      example,
      required: already?.required ?? true,
    }),
    steps,
  );
  const sample = { ...input.sample };
  if (!sample[variable.name]) sample[variable.name] = example;
  return { steps, variables, sample };
}

/**
 * Volver a dejarlo fijo: el hueco desaparece y, si nadie más lo usaba, el dato
 * declarado también. El texto que se escribe vuelve a ser el del ejemplo, que
 * es lo último que se sabe que ese campo llevaba.
 */
export function markStepAsFixed(
  input: { steps: ProposedStep[]; variables: ProposedVariable[]; sample: Record<string, string> },
  index: number,
): { steps: ProposedStep[]; variables: ProposedVariable[]; sample: Record<string, string> } {
  const step = input.steps[index];
  if (!step || step.value?.kind !== 'template') return input;

  const [name] = holesIn(step);
  const declared = name ? input.variables.find((v) => v.name === name) : undefined;
  const text = (name ? input.sample[name] : '') || declared?.example || '';

  const steps = setStepLiteral(input.steps, index, text);
  return { steps, variables: pruneVariables(input.variables, steps), sample: input.sample };
}

/* ---------------------------------------------------------------------------
 * Lo que no se puede guardar
 * -------------------------------------------------------------------------*/

export interface StepProblem {
  /** El paso, empezando en 0. `null` cuando el problema es del trámite entero. */
  index: number | null;
  message: string;
}

/**
 * The rules a valid step list obeys, said once for both sides of the wire.
 *
 * These BLOCK a save. They are not the same thing as `audit()` in the extractor,
 * which produces advice -- «este paso tiene una sola forma de encontrarse» is
 * worth reading and is not worth refusing a save over. What is here is the set
 * of things the replay engine cannot do anything sensible with.
 */
export function checkSteps(steps: ProposedStep[], variables: ProposedVariable[]): StepProblem[] {
  const problems: StepProblem[] = [];

  if (steps.length === 0) {
    problems.push({ index: null, message: 'Un trámite necesita al menos un paso.' });
  }
  if (steps.length > MAX_STEPS) {
    problems.push({
      index: null,
      message: `Un trámite no puede tener más de ${MAX_STEPS} pasos, y este tiene ${steps.length}.`,
    });
  }
  if (variables.length > MAX_VARIABLES) {
    problems.push({
      index: null,
      message: `No puedo manejar más de ${MAX_VARIABLES} datos que cambian.`,
    });
  }

  const declared = new Set<string>();
  for (const variable of variables) {
    if (!VARIABLE_NAME.test(variable.name)) {
      problems.push({
        index: null,
        message: `El dato «${variable.name}» tiene un nombre que no sirve: sólo minúsculas, números y guiones bajos, empezando por una letra.`,
      });
    }
    if (declared.has(variable.name)) {
      problems.push({
        index: null,
        message: `Hay dos datos que se llaman «${variable.name}». Ponle otro nombre a uno.`,
      });
    }
    declared.add(variable.name);
  }

  for (const [index, step] of steps.entries()) {
    const n = index + 1;

    if (step.label.trim().length === 0) {
      problems.push({
        index,
        message: `El paso ${n} se quedó sin nombre. Es lo que vas a leer el día que falle, así que dile qué hace.`,
      });
    }
    if (step.label.length > MAX_STEP_LABEL) {
      problems.push({
        index,
        message: `El nombre del paso ${n} es demasiado largo: máximo ${MAX_STEP_LABEL} caracteres.`,
      });
    }

    // The anchor rules, checked here rather than trusted to the buttons.
    if (step.action === 'goto' && index > 0) {
      problems.push({
        index,
        message: `El paso ${n} abre una dirección, y eso sólo lo puede hacer el primer paso: es el arranque del trámite. Súbelo al principio o cámbialo por el clic que llevaba a esa página.`,
      });
    }
    if (step.action === 'goto' && step.optional) {
      problems.push({
        index,
        message: `El paso ${n} abre el sitio, así que no puede ser opcional: sin él el trámite corre sobre una página en blanco.`,
      });
    }

    for (const name of holesIn(step)) {
      if (!declared.has(name)) {
        problems.push({
          index,
          message: `El paso ${n} usa {{${name}}} y no hay ningún dato que se llame así. Decláralo o quítalo del texto.`,
        });
      }
    }
  }

  return problems;
}

/** Los mismos controles, sobre una propuesta completa. Lo que llama la ruta. */
export function checkProposal(proposal: {
  steps: ProposedStep[];
  variables: ProposedVariable[];
}): StepProblem[] {
  return checkSteps(proposal.steps, proposal.variables);
}

/**
 * `null` no es «no viene»: es un valor, y los esquemas de los pasos no lo aceptan.
 *
 * `JSON.stringify` drops a key whose value is `undefined` and keeps one whose
 * value is `null`. An edited proposal makes that difference matter: a step whose
 * value was cleared, a target whose accessible name was removed, a `optional`
 * that went back to false -- any of them can leave the browser as `null`, and
 * `stepSchema` in agent-tools declares those fields `.optional()`, which rejects
 * `null` and turns one cleared field into «Esa propuesta no tiene una forma
 * válida», with no indication of which field or why.
 *
 * That exact confusion between the two has already cost this repo a whole
 * screen. So nulls are stripped at the door, before the schema ever sees them,
 * and the schema keeps deciding everything else.
 */
export function withoutNulls<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => withoutNulls(item)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item !== null) out[key] = withoutNulls(item);
    }
    return out as T;
  }
  return value;
}
