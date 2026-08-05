import { IntegrationError } from '@cortex/core';
import { gcalFetch } from '../gcal/client';
import type { ToolContext } from '../types';
import {
  type CommitmentRow,
  KIND_LABEL,
  addDays,
  cop,
  deriveState,
  describeSource,
  sourceSentence,
} from './shape';

/**
 * Commitments on the calendar of whoever answers for them.
 *
 * ONE WAY, CORTEX -> CALENDAR, AND HERE IS WHY IT STAYS THAT WAY. Two-way sync
 * sounds like one more feature and is actually a different product. It needs a
 * watch channel per calendar with a renewal job, an incremental sync token per
 * calendar that has to survive being invalidated, a rule for what happens when
 * the same commitment is edited in both places in the same minute, and an
 * answer to the question "somebody dragged the event two weeks later — is the
 * SOAT now valid two weeks longer?". That last one is not a merge conflict, it
 * is a provenance conflict: the date in Cortex was READ FROM RUNT, and a drag
 * in Google Calendar is not a new reading of the registry. Accepting it would
 * quietly turn a sourced date into an unsourced one, which is the exact failure
 * this whole module exists to prevent.
 *
 * So the calendar is a VIEW. Cortex owns the date; the event follows it, moves
 * when it moves, and disappears when the commitment is met. If somebody wants
 * to change a deadline they change it in Cortex, where the change is attributed
 * and the notices reopen for the new date. Nobody should read this file and
 * assume the other direction is coming.
 *
 * WHOSE CALENDAR. The owner's. Google credentials in this codebase are
 * per-person (`integrations` keyed by user_id), so the ToolContext handed in
 * here must carry the OWNER's `userId` — that is both how the token is
 * resolved and how the event lands on the right calendar. `calendar_user_id`
 * remembers whose credential created it, because it is the only one that can
 * update or delete it afterwards.
 */

const CALENDAR_ID = 'primary';

interface GCalEvent {
  id: string;
  htmlLink?: string;
  status?: string;
}

/**
 * The status code behind a Calendar failure, or null.
 *
 * `gcalFetch` is the shared client (and the one this module is required to
 * use), and it collapses every HTTP failure into an IntegrationError whose
 * message begins `Calendar <status> <path>`. The distinction that matters here
 * — "the event is gone" versus "Google is unhappy" — is only available in that
 * string, so it is read back out rather than duplicating the client to get a
 * response object.
 */
function statusOf(err: unknown): number | null {
  if (!(err instanceof IntegrationError)) return null;
  const m = /^Calendar (\d{3})/.exec(err.message);
  return m?.[1] ? Number(m[1]) : null;
}

/** Somebody deleted the event by hand in Google. */
function isGone(err: unknown): boolean {
  const s = statusOf(err);
  return s === 404 || s === 410;
}

function eventBody(row: CommitmentRow, today: string) {
  const state = deriveState(row, today);
  const source = describeSource(row);
  const lines = [
    `${KIND_LABEL[row.kind] ?? 'Compromiso'}${row.counterparty ? ` · ${row.counterparty}` : ''}`,
    row.detail ?? '',
    row.amount_cop ? `Valor: ${cop(row.amount_cop)}` : '',
    '',
    sourceSentence(source),
    '',
    'Creado por Cortex. Si la fecha cambia, cámbiala en Cortex — este evento la sigue, no al revés.',
  ].filter(Boolean);

  return {
    summary: `${state === 'overdue' ? '⚠️ ' : ''}${row.title}`,
    description: lines.join('\n'),
    // An all-day event, because a deadline is a calendar day. Google's end date
    // for all-day events is exclusive, hence +1.
    start: { date: row.due_on },
    end: { date: addDays(row.due_on, 1) },
    // The reminder is Google's, on top of Cortex's own mail: a person who lives
    // in their calendar gets it where they are.
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 9 * 60 }] },
    transparency: 'transparent',
  };
}

export interface CalendarSyncResult {
  action: 'created' | 'updated' | 'deleted' | 'recreated' | 'unchanged' | 'skipped';
  eventId: string | null;
  reason: string | null;
}

/**
 * Bring the calendar in line with one commitment.
 *
 * Deliberately total: it decides what the calendar should look like from the
 * commitment's current state rather than from what changed, so calling it after
 * any edit — or twice, or after a failure — converges on the same answer.
 */
export async function syncCommitmentToCalendar(
  ctx: ToolContext,
  row: CommitmentRow,
  today: string,
): Promise<CalendarSyncResult> {
  const skip = (reason: string): CalendarSyncResult => ({
    action: 'skipped',
    eventId: row.calendar_event_id,
    reason,
  });

  // A proposal is not a commitment. Putting an unconfirmed extracted date on
  // somebody's calendar would be the same lie as alerting on it, with a longer
  // half-life — calendars are read months later.
  if (row.review_state !== 'confirmed') return skip('sin confirmar');
  if (!row.owner_user_id) return skip('sin responsable');

  const state = deriveState(row, today);
  const shouldExist = state !== 'met' && state !== 'dropped';

  if (!shouldExist) {
    if (!row.calendar_event_id) return { action: 'unchanged', eventId: null, reason: null };
    try {
      await gcalFetch(ctx, `/calendars/${CALENDAR_ID}/events/${row.calendar_event_id}`, {
        method: 'DELETE',
      });
    } catch (err) {
      // Already gone is the outcome we wanted.
      if (!isGone(err)) throw err;
    }
    await clearEvent(ctx, row.id);
    return { action: 'deleted', eventId: null, reason: null };
  }

  const body = eventBody(row, today);

  if (row.calendar_event_id) {
    if (row.calendar_synced_due_on === row.due_on) {
      return { action: 'unchanged', eventId: row.calendar_event_id, reason: null };
    }
    try {
      const updated = await gcalFetch<GCalEvent>(
        ctx,
        `/calendars/${CALENDAR_ID}/events/${row.calendar_event_id}`,
        { method: 'PATCH', body: JSON.stringify(body) },
      );
      await storeEvent(ctx, row, updated.id);
      return { action: 'updated', eventId: updated.id, reason: null };
    } catch (err) {
      if (!isGone(err)) throw err;
      // Somebody deleted it in Google. Recreating is the right answer: the
      // commitment is still open, and a deletion in Calendar is not a decision
      // about the deadline — the place to decide that is Cortex.
      const recreated = await createEvent(ctx, body);
      await storeEvent(ctx, row, recreated.id);
      return { action: 'recreated', eventId: recreated.id, reason: 'el evento ya no existía' };
    }
  }

  const created = await createEvent(ctx, body);
  await storeEvent(ctx, row, created.id);
  return { action: 'created', eventId: created.id, reason: null };
}

async function createEvent(ctx: ToolContext, body: unknown): Promise<GCalEvent> {
  return gcalFetch<GCalEvent>(ctx, `/calendars/${CALENDAR_ID}/events?sendUpdates=none`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function storeEvent(ctx: ToolContext, row: CommitmentRow, eventId: string): Promise<void> {
  await ctx.db
    .from('commitments')
    .update({
      calendar_event_id: eventId,
      calendar_id: CALENDAR_ID,
      calendar_user_id: ctx.userId,
      calendar_synced_due_on: row.due_on,
      calendar_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', row.id);
}

async function clearEvent(ctx: ToolContext, id: string): Promise<void> {
  await ctx.db
    .from('commitments')
    .update({
      calendar_event_id: null,
      calendar_synced_due_on: null,
      calendar_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);
}

/**
 * Record that the calendar could not be reached, without failing whatever was
 * being done at the time.
 *
 * A commitment whose event did not sync is still a commitment, and the mail
 * still went out. Turning a Google outage into a failed "mark as met" would
 * mean the person's action was lost because a third party was down.
 */
export async function recordCalendarError(
  ctx: ToolContext,
  id: string,
  message: string,
): Promise<void> {
  ctx.logger.warn({ commitmentId: id, error: message }, 'commitment calendar sync failed');
  await ctx.db
    .from('commitments')
    .update({ calendar_error: message.slice(0, 500), updated_at: new Date().toISOString() })
    .eq('id', id);
}
