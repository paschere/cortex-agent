import type { SupabaseClient } from '@supabase/supabase-js';
import { type CommitmentRow, deriveState } from '../commitments/shape';

/**
 * What the unattended sweep should offer this morning, decided as a pure
 * function of what it can see.
 *
 * WHY ONLY `remind_owner` IS DRAFTED UNATTENDED. The recipient has to be
 * somebody we can actually name. A colleague we can: `owner_user_id` is a
 * directory row with an address on it. A client contact we cannot —
 * `commitments.counterparty` is free text ("Coltrans"), and the only ways to
 * turn that into an email address with nobody watching are to guess or to go
 * fishing through the mailbox for the last person who wrote from a
 * similar-looking domain. Both of those are how a cobro reaches the wrong
 * company, and a cobro reaching the wrong company is not a bug you apologise
 * for, it is one you lose the account over.
 *
 * So the sweep hands the deadline to the person who answers for it, and the
 * cobro itself is drafted in the conversation, where the model can establish
 * the recipient from the thread, the CRM or the directory and a human reads the
 * address before it goes. The unattended reminder for a lapsed receivable ends
 * by saying exactly that, so the path from one to the other is one message.
 *
 * This is the same posture the rest of the unattended machinery already takes:
 * schedule-run refuses a confirmation-gated tool and reports it rather than
 * running it. Nothing here decides to contact a customer on its own.
 */

/**
 * How long after touching a commitment the sweep leaves it alone.
 *
 * Without this, an approved-and-sent reminder is followed the next morning by
 * an identical proposal, because the deadline is still there — the partial
 * unique index only stops a second OPEN proposal, not a second one after the
 * first was answered. Seven days is the same rhythm as the proposal's own life:
 * long enough not to nag, short enough that a deadline that keeps slipping
 * comes back before it lapses.
 */
export const REMINDER_COOLDOWN_MS = 7 * 24 * 60 * 60_000;

export interface ReminderCandidate {
  commitment: CommitmentRow;
  /** Derived from the date today, never read off the cached column. */
  state: 'due_soon' | 'overdue';
}

/**
 * Which commitments have earned a reminder today.
 *
 * Deliberately narrow. `in_force` is not a candidate: a SOAT that expires in
 * four months is not news, and an inbox that contains four months of
 * not-news is an inbox nobody opens. Only the two states that mean "this is
 * now somebody's problem" produce a draft.
 */
export function planOwnerReminders(input: {
  commitments: CommitmentRow[];
  today: string;
  /** Commitment ids touched by an action recently. See REMINDER_COOLDOWN_MS. */
  recentOriginIds: Set<string>;
}): ReminderCandidate[] {
  const out: ReminderCandidate[] = [];
  for (const c of input.commitments) {
    if (!c.owner_user_id) continue;
    if (input.recentOriginIds.has(c.id)) continue;
    const state = deriveState(c, input.today);
    if (state !== 'due_soon' && state !== 'overdue') continue;
    out.push({ commitment: c, state });
  }
  // Most urgent first, so a workspace that hits the per-run cap gets the
  // deadlines that already passed rather than the ones that have a month left.
  return out.sort((a, b) => a.commitment.due_on.localeCompare(b.commitment.due_on));
}

/**
 * Commitment ids this workspace has proposed or sent an action about lately.
 *
 * One query rather than one per commitment, and it counts EVERY state: a
 * proposal somebody dismissed yesterday is a decision, and re-offering it this
 * morning would be arguing with them.
 */
export async function recentlyActedOrigins(
  db: SupabaseClient,
  since: Date,
): Promise<Set<string>> {
  const { data } = await db
    .from('actions')
    .select('origin_id')
    .eq('origin_kind', 'commitment')
    .gt('created_at', since.toISOString())
    .limit(5000);
  const ids = new Set<string>();
  for (const row of (data ?? []) as Array<{ origin_id: string | null }>) {
    if (row.origin_id) ids.add(row.origin_id);
  }
  return ids;
}
