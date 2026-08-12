import type { Step, StepOutcome, Target, TargetKind } from './types';

/**
 * Rewriting a flow with what the page says, not what the model saw.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * Extraction reads a recording. A recording is pixels: it shows the words on a
 * button, the label beside a field and the order things happened in, and it can
 * show nothing else, because nothing else was ever photographed. Everything the
 * model writes into `targets` is therefore an inference from a picture -- often
 * right, occasionally a paraphrase ("Consultar" for a button that actually says
 * "Consultar placa"), and never able to include the three most durable locators
 * there are: a `data-testid` put there for automation, the accessible name a
 * screen reader would read, and the server-generated `name` attribute that the
 * JSF and ASP.NET stacks most Colombian portals run on never change.
 *
 * But the verification pass runs in our own Playwright, and Playwright can see
 * the DOM. So the moment a step resolves, the element hands over its own
 * description (`observeTargets` in services/browser/src/snapshot.ts), and this
 * function folds it back into the flow.
 *
 * THE DIVISION OF LABOUR, STATED ONCE: the video says WHICH STEPS THERE ARE AND
 * IN WHAT ORDER -- which is what a sequence of pictures is genuinely evidence of
 * and what no DOM dump would tell you, since a DOM has no idea what the person
 * was trying to do. The DOM says WHAT EACH THING IS CALLED -- which a picture
 * can never say. Neither source is asked for what it does not have.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS A MERGE AND NOT A REPLACEMENT
 * ---------------------------------------------------------------------------
 * The model's guesses are kept, ranked below the observed ones. They cost
 * nothing to carry -- `resolveTarget` tries candidates in order and stops at the
 * first that resolves -- and they are a different KIND of description: what the
 * page looked like to a person on the day it was taught. A portal that
 * regenerates its `name` attributes in a rebuild keeps its visible labels, and
 * on that day the model's paraphrase is the candidate that carries the step.
 *
 * The merged list is ordered by KIND, not by who proposed it, because the
 * ranking is a claim about what survives a redesign and that claim does not
 * depend on where a candidate came from. Within one kind the observed value
 * wins, since it is the page's own spelling rather than a reading of a
 * screenshot.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT WILL NOT DO
 * ---------------------------------------------------------------------------
 * Only steps that RAN are refined, and only their `targets`. The action, the
 * value, the variable binding and the order are left exactly as the recording
 * described them. A step that failed is not refined -- there is no element to
 * ask -- and that case belongs to repair, which is a model call and has to
 * justify itself separately.
 */

/**
 * Best first, and this is the ranking the whole module rests on. It is written
 * out here rather than taken from `TARGET_KINDS.indexOf` because that array is
 * the wire vocabulary -- a set of permitted strings -- and the day somebody
 * appends a kind to it alphabetically, the ranking must not move with it.
 *
 * `name` above `text`: a form field's `name` is server-generated and survives
 * any cosmetic change, while the words on a button are exactly what a redesign
 * rewrites. That ordering also matches `targetsFor` in the browser service and
 * the table in docs/operations/browser.md.
 */
const RANK: Record<TargetKind, number> = {
  testid: 0,
  role: 1,
  label: 2,
  placeholder: 3,
  name: 4,
  text: 5,
  css: 6,
};

/** How many candidates a step may carry. The schema's cap. */
const MAX_TARGETS = 8;

function keyOf(target: Target): string {
  return `${target.kind}|${target.value.trim().toLowerCase()}|${(target.name ?? '').trim().toLowerCase()}`;
}

/**
 * Observed first within a kind, then the model's, then everything sorted by how
 * well the kind survives a redesign. A stable sort keeps the observed candidate
 * ahead of the taught one when both are the same kind.
 */
export function mergeTargets(observed: Target[], taught: Target[]): Target[] {
  const seen = new Set<string>();
  const ordered: { target: Target; rank: number; fromDom: boolean }[] = [];

  for (const [list, fromDom] of [
    [observed, true],
    [taught, false],
  ] as const) {
    for (const target of list) {
      if (!target?.value?.trim()) continue;
      const key = keyOf(target);
      if (seen.has(key)) continue;
      seen.add(key);
      ordered.push({ target, rank: RANK[target.kind] ?? 9, fromDom });
    }
  }

  return ordered
    .sort((a, b) => a.rank - b.rank || Number(b.fromDom) - Number(a.fromDom))
    .slice(0, MAX_TARGETS)
    .map((entry) => entry.target);
}

export interface Refinement {
  steps: Step[];
  /** Indexes whose locator list actually moved. Empty means nothing to save. */
  changed: number[];
  /** How many steps gained a locator no picture could have supplied. */
  gainedStrong: number;
}

/** The kinds a recording structurally cannot produce. */
const INVISIBLE_TO_A_CAMERA: TargetKind[] = ['testid', 'name'];

export function refineFromDom(steps: Step[], outcomes: StepOutcome[]): Refinement {
  const changed: number[] = [];
  let gainedStrong = 0;

  const next = steps.map((step, index) => {
    const outcome = outcomes.find((o) => o.index === index);
    const observed = outcome?.ok ? (outcome.observedTargets ?? []) : [];
    if (observed.length === 0) return step;

    const merged = mergeTargets(observed, step.targets);
    const before = step.targets.map(keyOf).join('~');
    if (merged.map(keyOf).join('~') === before) return step;

    const had = new Set(step.targets.map((t) => t.kind));
    if (merged.some((t) => INVISIBLE_TO_A_CAMERA.includes(t.kind) && !had.has(t.kind))) {
      gainedStrong += 1;
    }
    changed.push(index);
    return { ...step, targets: merged };
  });

  return { steps: next, changed, gainedStrong };
}

/** One sentence for the version history. Never mentions a value, only a shape. */
export function refinementNote(refinement: Refinement): string {
  const strong =
    refinement.gainedStrong > 0
      ? ` ${refinement.gainedStrong} de ellos ganaron un identificador que en un video no se ve (el id de prueba o el nombre interno del campo).`
      : '';
  return `Corrí el trámite contra el sitio y le pregunté a cada elemento cómo se llama de verdad. Reescribí los localizadores de ${refinement.changed.length} paso(s) con lo que dijo la página en vez de lo que se dedujo de la grabación.${strong}`;
}
