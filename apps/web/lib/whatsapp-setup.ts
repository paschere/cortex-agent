/**
 * The order in which a WhatsApp connection actually becomes useful.
 *
 * WHY THIS IS A MODULE AND NOT THREE `if`s IN THE COMPONENT. The first thing
 * anybody wants from this surface is to text the number and get an answer, and
 * that needs three things done in a fixed order: the company line paired, the
 * asker's own number linked to their Cortex user, and — only then — a decision
 * about which groups are read. Skip the middle one and the product answers
 * "no te reconozco", which is how people concluded it was broken.
 *
 * So the sequence is stated once, here, as data the screen renders rather than
 * as prose somebody has to keep in sync. Exactly one step is ever `now`: a
 * checklist with two highlighted rows is a list, not an instruction.
 *
 * Deliberately free of `@cortex/agent-tools` imports: this is read by a
 * `'use client'` component, and that barrel drags `node:dns` into the browser
 * bundle. See `commitments-shape.ts` for the incident.
 */

export type StepKey = 'pair' | 'link' | 'groups';

/** `now` is the one thing to do next; `later` is not actionable yet. */
export type StepState = 'done' | 'now' | 'later';

export interface SetupFacts {
  /** The company line is paired AND the bridge is reporting. */
  connected: boolean;
  /** The person reading the screen has their own number linked to their user. */
  myNumberLinked: boolean;
  /** Groups with archiving or answering switched on. */
  groupsConfigured: number;
}

export interface SetupStep {
  key: StepKey;
  state: StepState;
}

export const STEP_ORDER: readonly StepKey[] = ['pair', 'link', 'groups'] as const;

function isDone(key: StepKey, facts: SetupFacts): boolean {
  if (key === 'pair') return facts.connected;
  if (key === 'link') return facts.myNumberLinked;
  return facts.groupsConfigured > 0;
}

/**
 * The three steps with their state.
 *
 * A later step can be done before an earlier one — groups can be chosen by an
 * admin who never linked their own number — and that is reported honestly
 * rather than reset to `later`. What is never reported twice is `now`.
 */
export function setupSteps(facts: SetupFacts): SetupStep[] {
  let claimed = false;
  return STEP_ORDER.map((key) => {
    if (isDone(key, facts)) return { key, state: 'done' as const };
    if (!claimed) {
      claimed = true;
      return { key, state: 'now' as const };
    }
    return { key, state: 'later' as const };
  });
}

/** What to do next, or null when there is nothing left. */
export function nextStep(facts: SetupFacts): StepKey | null {
  return setupSteps(facts).find((s) => s.state === 'now')?.key ?? null;
}

/**
 * Whether Cortex would answer this person right now, and why not.
 *
 * The one question the screen exists to answer before somebody tests it with
 * their thumb. Both conditions are real: an unpaired line answers nobody, and a
 * paired line refuses a number it does not know.
 */
export function wouldAnswerMe(facts: SetupFacts): { yes: boolean; blockedBy: StepKey | null } {
  if (!facts.connected) return { yes: false, blockedBy: 'pair' };
  if (!facts.myNumberLinked) return { yes: false, blockedBy: 'link' };
  return { yes: true, blockedBy: null };
}
