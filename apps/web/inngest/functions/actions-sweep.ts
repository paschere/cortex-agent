import { buildToolContext } from '@/lib/agent';
import { inngest } from '@/lib/inngest';
import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import {
  type ActionRow,
  type CommitmentRow,
  REMINDER_COOLDOWN_MS,
  bogotaToday,
  draftOwnerReminder,
  findReply,
  getCommitment,
  gmailReadThread,
  listActions,
  listCommitments,
  outcomeNoteForResolution,
  planOwnerReminders,
  proposeAction,
  recentlyActedOrigins,
  recordOutcome,
  runTool,
  silenceIsFinal,
} from '@cortex/agent-tools';
import { logger } from '@cortex/core';

/**
 * The part that makes proposed actions a product rather than a chat feature:
 * nobody has to be looking.
 *
 * Every morning, per workspace, Cortex reads what is lapsing or already lapsed,
 * writes the reminder to whoever answers for it, and leaves it in that person's
 * queue. Then it goes back over everything it sent and finds out what came of
 * it — who answered, what got resolved, and what has been sitting in silence
 * long enough to be worth saying out loud.
 *
 * ── NOTHING HERE SENDS ANYTHING ───────────────────────────────────────────
 * This function's entire output is rows in `state='proposed'`. There is no
 * branch, no configuration flag and no elapsed-time condition that causes an
 * action to execute — approval is a human pressing a button, and that button is
 * on a different surface entirely. That is the posture schedule-run already
 * takes with confirmation-gated tools: skip it, report it, never run it.
 *
 * ── IDEMPOTENCE IS NOT BEST-EFFORT ────────────────────────────────────────
 * Inngest retries steps, deploys restart them, and a cron that fires twice is a
 * normal Tuesday. "Have we already proposed this" is therefore not decided
 * here: it is decided by the partial unique index on
 * (organization_id, kind, origin_kind, origin_id) where state='proposed' in
 * migration 0077. This code writes and either wins or is told it already has.
 * The seven-day cooldown on top of that is a different question — not "did we
 * propose this" but "did we already bother this person about it recently" —
 * and it is why an approved-and-sent reminder does not come back tomorrow.
 *
 * ── SHAPE ─────────────────────────────────────────────────────────────────
 * Cron dispatcher + per-workspace event, the same as schedule-dispatch /
 * schedule-run, memory-derive and commitments-watch: one function decides who
 * is due and fans out, one does the work for a single workspace so a failure is
 * contained and Inngest retries only that workspace.
 */

/**
 * 06:30 in Bogotá, thirty minutes after the commitments watcher.
 *
 * The order matters: the watcher recomputes in-force / lapsing / lapsed against
 * today, and drafting a reminder off yesterday's cached state is how somebody
 * gets an email about a SOAT that was renewed last night. Colombia has no
 * daylight saving, so 11:30 UTC is 06:30 there every day of the year.
 */
const SWEEP_CRON = '30 11 * * *';

/**
 * How many reminders one workspace may be offered per run.
 *
 * Not a performance limit — it is an attention limit. A queue that arrives with
 * sixty drafts in it on the first morning does not get worked through, it gets
 * ignored, and the feature is dead before anyone has approved anything.
 * `planOwnerReminders` sorts by due date, so the cap keeps what already lapsed
 * and defers what has a month left to tomorrow.
 */
const MAX_PROPOSALS_PER_RUN = 15;

/** How many executed actions one run follows up on. Each costs a Gmail read. */
const MAX_FOLLOW_UPS_PER_RUN = 40;

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export const actionsSweepDispatch = inngest.createFunction(
  { id: 'actions-sweep-dispatch' },
  { cron: SWEEP_CRON },
  async ({ step }) => {
    // Unscoped, and only here. "Which workspaces have anything to sweep" spans
    // the install and there is no session behind a cron. Every workspace id read
    // here rides on its own event, and the per-workspace function below builds
    // every handle from that id — so one company's sweep can only ever read and
    // write that company's rows.
    const workspaces = await step.run('find-workspaces', async (): Promise<string[]> => {
      const db = getSupabaseServiceClient();
      const seen = new Set<string>();
      // Two sources: somewhere to propose from, and something already sent that
      // is still waiting on an answer.
      const [{ data: commitments }, { data: awaiting }] = await Promise.all([
        db.from('commitments').select('organization_id').limit(20_000),
        db.from('actions').select('organization_id').eq('outcome', 'awaiting').limit(20_000),
      ]);
      for (const row of [...(commitments ?? []), ...(awaiting ?? [])] as Array<{
        organization_id: string | null;
      }>) {
        if (row.organization_id) seen.add(row.organization_id);
      }
      return [...seen];
    });

    if (workspaces.length > 0) {
      await step.sendEvent(
        'sweep-per-workspace',
        workspaces.map((organizationId) => ({
          name: 'actions/sweep.workspace' as const,
          data: { organizationId },
        })),
      );
    }
    return { dispatched: workspaces.length };
  },
);

// ---------------------------------------------------------------------------
// One workspace
// ---------------------------------------------------------------------------

/**
 * The agent a proposal is attributed to.
 *
 * An action has to name one, because executing it later builds a tool context
 * and every audit row in this product is written against an agent. There is no
 * session here to take it from, so it comes off the workspace: its `cortex`
 * agent if it has one, otherwise whichever it has.
 */
async function defaultAgentId(organizationId: string): Promise<string | null> {
  const db = getOrgScopedClient(organizationId);
  const { data: named } = await db
    .from('agents')
    .select('id')
    .eq('slug', 'cortex')
    .maybeSingle();
  if (named?.id) return named.id as string;
  const { data: any } = await db.from('agents').select('id').limit(1).maybeSingle();
  return (any?.id as string | undefined) ?? null;
}

export const actionsSweepWorkspace = inngest.createFunction(
  { id: 'actions-sweep-workspace', concurrency: { limit: 5 } },
  { event: 'actions/sweep.workspace' },
  async ({ event, step }) => {
    const organizationId = event.data.organizationId as string | undefined;
    if (!organizationId) return { skipped: 'no workspace on the event' };

    // Computed once and carried through every step, so a run that straddles
    // midnight in Bogotá still agrees with itself about which day it is
    // deciding for. Same reasoning as commitments-watch.
    const today = bogotaToday();

    // 1. What deserves a reminder, and to whom -----------------------------
    const proposed = await step.run('propose-reminders', async () => {
      const db = getOrgScopedClient(organizationId);
      const agentId = await defaultAgentId(organizationId);
      if (!agentId) return { proposed: 0, skipped: 'no agent in this workspace' };

      const commitments = await listCommitments(db, {
        states: ['due_soon', 'overdue'],
        reviewState: 'confirmed',
        today,
        limit: 1000,
      });
      if (commitments.length === 0) return { proposed: 0 };

      const recent = await recentlyActedOrigins(
        db,
        new Date(Date.now() - REMINDER_COOLDOWN_MS),
      );
      const candidates = planOwnerReminders({
        commitments,
        today,
        recentOriginIds: recent,
      }).slice(0, MAX_PROPOSALS_PER_RUN);
      if (candidates.length === 0) return { proposed: 0 };

      // Addresses in one query. An owner without an email address on their
      // directory row is skipped rather than guessed at.
      const ownerIds = [
        ...new Set(candidates.map((c) => c.commitment.owner_user_id).filter(Boolean)),
      ] as string[];
      const { data: owners } = await db
        .from('users')
        .select('id, name, email')
        .in('id', ownerIds);
      const byId = new Map(
        ((owners ?? []) as Array<{ id: string; name: string | null; email: string }>).map((u) => [
          u.id,
          u,
        ]),
      );

      let count = 0;
      for (const candidate of candidates) {
        const owner = byId.get(candidate.commitment.owner_user_id as string);
        if (!owner?.email) continue;
        const draft = draftOwnerReminder(
          candidate.commitment as CommitmentRow,
          today,
          owner.name?.trim().split(' ')[0] ?? null,
        );
        try {
          const result = await proposeAction(db, {
            // The action belongs to the person who has to answer for the
            // deadline: they approve it, and it leaves from their Gmail.
            userId: owner.id,
            agentId,
            kind: 'remind_owner',
            toolId: 'gmail.send_message',
            payload: { to: [owner.email], subject: draft.subject, body: draft.body },
            originKind: 'commitment',
            originId: candidate.commitment.id,
            rationale: draft.rationale,
          });
          if (result.outcome === 'proposed') count += 1;
        } catch (err) {
          // One bad row must not cost the workspace its whole sweep.
          logger.warn('actions-sweep: could not propose a reminder', {
            organizationId,
            commitmentId: candidate.commitment.id,
            error: (err as Error).message,
          });
        }
      }
      return { proposed: count, considered: candidates.length };
    });

    // 2. What came of what already went out ---------------------------------
    // Deliberately a separate step: a Gmail outage must not cost the workspace
    // the proposals above, which are the part somebody is waiting for.
    const closed = await step.run('close-the-loop', async () => {
      const db = getOrgScopedClient(organizationId);
      const open = await listActions(db, { outcome: 'awaiting', limit: MAX_FOLLOW_UPS_PER_RUN });
      if (open.length === 0) return { closed: 0 };

      const userIds = [...new Set(open.map((a) => a.user_id))];
      const { data: users } = await db.from('users').select('id, email').in('id', userIds);
      const emailOf = new Map(
        ((users ?? []) as Array<{ id: string; email: string }>).map((u) => [u.id, u.email]),
      );

      let count = 0;
      for (const action of open) {
        try {
          if (await closeOne(organizationId, action, emailOf.get(action.user_id) ?? null)) {
            count += 1;
          }
        } catch (err) {
          logger.warn('actions-sweep: follow-up failed', {
            organizationId,
            actionId: action.id,
            error: (err as Error).message,
          });
        }
      }
      return { closed: count, checked: open.length };
    });

    return { proposed, closed };
  },
);

/**
 * Decide, for one sent action, whether the loop has closed.
 *
 * The order is what makes the answers honest. A reply is the strongest evidence
 * and is checked first. The commitment being met is next, and it is checked
 * even when the mailbox cannot be read — a payment recorded as received closes
 * the cobro whether or not anybody wrote back. Silence is last, and only
 * counts once the window has genuinely passed.
 */
async function closeOne(
  organizationId: string,
  action: ActionRow,
  ourEmail: string | null,
): Promise<boolean> {
  const db = getOrgScopedClient(organizationId);

  // Did anybody answer?
  if (action.thread_id && action.executed_at && ourEmail && action.agent_id) {
    try {
      const ctx = buildToolContext({
        organizationId,
        userId: action.user_id,
        agentId: action.agent_id,
        surface: 'schedule',
      });
      const read = await runTool(gmailReadThread, { threadId: action.thread_id }, ctx);
      const verdict = findReply(read.thread.messages, {
        executedAt: new Date(action.executed_at),
        ourAddresses: [ourEmail],
      });
      if (verdict.replied) {
        await recordOutcome(db, { id: action.id, outcome: 'replied', note: verdict.note });
        return true;
      }
    } catch (err) {
      // A missing scope, a revoked token, a deleted thread. None of those are a
      // reason to stop asking the other two questions.
      logger.debug('actions-sweep: could not read the thread', {
        actionId: action.id,
        error: (err as Error).message,
      });
    }
  }

  // Did the thing it was about get closed?
  if (action.origin_kind === 'commitment' && action.origin_id) {
    const commitment = await getCommitment(db, action.origin_id);
    if (commitment && (commitment.state === 'met' || commitment.state === 'dropped')) {
      await recordOutcome(db, {
        id: action.id,
        outcome: 'resolved',
        note: outcomeNoteForResolution(
          commitment.state === 'met' ? 'commitment_met' : 'commitment_dropped',
        ),
      });
      return true;
    }
  }

  // Has the silence gone on long enough to be a finding?
  if (silenceIsFinal(action.executed_at)) {
    await recordOutcome(db, {
      id: action.id,
      outcome: 'no_reply',
      note: 'Nadie contestó en diez días. Puede que valga la pena insistir o llamar.',
    });
    return true;
  }

  return false;
}
