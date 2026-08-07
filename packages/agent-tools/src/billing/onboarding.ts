import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The first ten minutes of a new company.
 *
 * THE PROBLEM THIS SOLVES IS NOT "THERE IS NO WIZARD". It is that a brand-new
 * workspace lands on a dashboard showing four zeros and two empty panels. Cortex
 * is a brain, and an empty brain is not a product with nothing in it yet — it is
 * a product that cannot demonstrate what it is for. Somebody who asks it the
 * first question and gets "no tengo nada sobre eso" has learned the wrong thing
 * about it and will not ask a second.
 *
 * So the guide has exactly one job: get somebody from signing up to a FIRST
 * CONNECTED SOURCE, and from there to an answer that could only have come from
 * their own company. Everything here is ordered by that, not by what is easiest
 * to build.
 *
 * ===========================================================================
 * ONE QUESTION, AND IT HAS TO CHANGE SOMETHING
 * ===========================================================================
 * The guide asks a single thing — what do you want Cortex to do first — and the
 * answer re-orders the steps and picks the source to connect. A question whose
 * answer changes nothing is a form; this one decides whether the person is sent
 * to Google/Microsoft (their mail is the corpus) or to Brain Knowledge (their
 * documents are). Getting that order wrong is the difference between a useful
 * answer in ten minutes and an empty one.
 *
 * ===========================================================================
 * PROGRESS IS DERIVED, NOT STORED
 * ===========================================================================
 * There is no `steps_completed` column and there will not be one. Every step
 * below is answered by counting rows that had to exist for the step to have
 * really happened: an `integrations` row, a `kb_documents` row, an assistant
 * `messages` row, a second directory row. A stored checkbox and the world drift
 * apart — somebody disconnects Google and the guide still says "listo" — and the
 * world is the thing the person is looking at. The only things kept in
 * `organization_onboarding` are the ones that cannot be derived: the answer to
 * the question, the company name typed at signup, and whether the guide was
 * closed.
 *
 * Every count goes through the scoped handle over tenant tables, so a step can
 * only ever be completed by this workspace's own rows.
 *
 * The step COPY is not here. It lives in the web app, in Spanish, next to the
 * links it points at; this module decides which steps there are, what order they
 * come in and which are done.
 */

/** What somebody says they want Cortex to do first. */
export const ONBOARDING_GOALS = ['email', 'documents', 'deadlines', 'meetings'] as const;
export type OnboardingGoal = (typeof ONBOARDING_GOALS)[number];

export const ONBOARDING_STEPS = ['goal', 'source', 'knowledge', 'answer', 'team'] as const;
export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number];

export interface OnboardingStep {
  id: OnboardingStepId;
  done: boolean;
}

export interface OnboardingState {
  goal: OnboardingGoal | null;
  companyName: string | null;
  dismissedAt: string | null;
  steps: OnboardingStep[];
  /** The first step not yet done — what the screen should be pushing. */
  next: OnboardingStepId | null;
  done: boolean;
  /** True when the guide should be put in front of somebody. */
  show: boolean;
}

/**
 * Step order per goal.
 *
 * `goal` is always first because it decides the rest. `team` is always last —
 * inviting people into a workspace that cannot answer anything yet is how a
 * pilot dies on the first day, with four colleagues who each looked once.
 *
 * The middle two swap. If the corpus is going to be their mail or their
 * meetings, connecting the source IS bringing the knowledge, and asking them to
 * upload a file first is busywork. If the corpus is their documents, the upload
 * is the whole point and an OAuth screen in front of it is friction with nothing
 * behind it.
 */
const ORDER: Readonly<Record<OnboardingGoal, OnboardingStepId[]>> = {
  email: ['goal', 'source', 'answer', 'knowledge', 'team'],
  meetings: ['goal', 'source', 'answer', 'knowledge', 'team'],
  documents: ['goal', 'knowledge', 'answer', 'source', 'team'],
  deadlines: ['goal', 'knowledge', 'answer', 'source', 'team'],
};

/** Before the question is answered, the neutral order. */
const DEFAULT_ORDER: OnboardingStepId[] = ['goal', 'source', 'knowledge', 'answer', 'team'];

interface Counts {
  integrations: number;
  documents: number;
  answers: number;
  people: number;
}

async function countAll(db: SupabaseClient): Promise<Counts> {
  const head = { count: 'exact' as const, head: true };
  const [integrations, documents, answers, people] = await Promise.all([
    db.from('integrations').select('user_id', head),
    db.from('kb_documents').select('id', head),
    db.from('messages').select('id', head).eq('role', 'assistant'),
    db.from('users').select('id', head),
  ]);
  return {
    integrations: integrations.count ?? 0,
    documents: documents.count ?? 0,
    answers: answers.count ?? 0,
    people: people.count ?? 0,
  };
}

/**
 * Where this workspace is in its first ten minutes.
 *
 * Never throws: a guide that fails to load must not take the page with it, so a
 * failed read reports a dismissed, complete state — the least intrusive lie
 * available, and one that resolves itself on the next request.
 */
export async function readOnboarding(db: SupabaseClient): Promise<OnboardingState> {
  try {
    const [{ data }, counts] = await Promise.all([
      db
        .from('organization_onboarding')
        .select('primary_goal, company_name, dismissed_at')
        .maybeSingle(),
      countAll(db),
    ]);

    const row = data as
      | { primary_goal?: string | null; company_name?: string | null; dismissed_at?: string | null }
      | null
      | undefined;
    const goal = (ONBOARDING_GOALS as readonly string[]).includes(row?.primary_goal ?? '')
      ? (row?.primary_goal as OnboardingGoal)
      : null;

    const done: Record<OnboardingStepId, boolean> = {
      goal: goal !== null,
      source: counts.integrations > 0,
      knowledge: counts.documents > 0,
      answer: counts.answers > 0,
      // One person is a workspace, two is a team. The directory row is written
      // on the invitee's first request (lib/session.ts), so this only turns true
      // once somebody actually arrived — which is the thing worth celebrating,
      // not the invitation having been sent.
      team: counts.people > 1,
    };

    const steps = (goal ? ORDER[goal] : DEFAULT_ORDER).map((id) => ({ id, done: done[id] }));
    const next = steps.find((s) => !s.done)?.id ?? null;
    const dismissedAt = row?.dismissed_at ?? null;

    return {
      goal,
      companyName: row?.company_name ?? null,
      dismissedAt,
      steps,
      next,
      done: next === null,
      show: next !== null && dismissedAt === null,
    };
  } catch {
    return {
      goal: null,
      companyName: null,
      dismissedAt: new Date().toISOString(),
      steps: DEFAULT_ORDER.map((id) => ({ id, done: true })),
      next: null,
      done: true,
      show: false,
    };
  }
}

/**
 * Record the answer to the question, or that the guide was closed.
 *
 * Upsert rather than update: the row is normally created by the trigger in
 * migration 0085 § 8, but a workspace that predates the trigger and was never
 * backfilled would otherwise have nowhere to put the answer.
 */
export async function saveOnboarding(
  db: SupabaseClient,
  patch: { goal?: OnboardingGoal; companyName?: string; dismissed?: boolean },
): Promise<void> {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.goal) row.primary_goal = patch.goal;
  if (patch.companyName) row.company_name = patch.companyName.slice(0, 200);
  if (patch.dismissed !== undefined) row.dismissed_at = patch.dismissed ? new Date().toISOString() : null;
  await db.from('organization_onboarding').upsert(row, { onConflict: 'organization_id' });
}

/** The steps in the order this workspace should do them. */
export function onboardingSteps(state: OnboardingState): OnboardingStep[] {
  return state.steps;
}
