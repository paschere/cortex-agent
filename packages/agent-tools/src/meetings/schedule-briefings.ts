import { z } from 'zod';
import { type MeetingType, meetingTypeLabel } from '../gcal/classify';
import { type NormalizedMeeting, collectUpcomingMeetings } from '../gcal/events';
import { registerTool } from '../index';
import type { ToolContext } from '../types';

/**
 * `meetings.schedule_briefings` — one alarm per meeting, not one cron for all.
 *
 * A single daily cron cannot deliver "30 minutes before it starts": meetings
 * are at different times. So this tool scans the calendar and creates a
 * ONE-OFF scheduled job per qualifying meeting, timed to that meeting's start
 * minus `leadMinutes`. Each job runs an unattended agent turn that prepares
 * the briefing for that exact calendar entry and emails it.
 *
 * Duplicate control — the whole reason `meeting_briefings` exists:
 *   The scan is meant to be run repeatedly (by hand or by a daily routine),
 *   and the same meeting will appear in overlapping windows. Before creating
 *   a job we CLAIM the meeting by inserting (user_id, event_id) into
 *   `meeting_briefings`, which carries a unique constraint on that pair. The
 *   insert is the lock: if it comes back with a uniqueness violation, someone
 *   already scheduled this briefing and we skip it. Claiming BEFORE creating
 *   the job (and deleting the claim if job creation fails) keeps two
 *   concurrent scans from double-booking the same meeting.
 *
 * Writes to the schedule, so it is confirmation-gated.
 */

const UNIQUE_VIOLATION = '23505';

const TYPES = ['interview', 'client', 'internal', 'personal', 'unknown'] as const;

const ScheduledSchema = z.object({
  eventId: z.string(),
  title: z.string(),
  meetingStart: z.string(),
  meetingStartHuman: z.string(),
  type: z.enum(TYPES),
  sendAt: z.string(),
  jobId: z.string(),
  recipients: z.array(z.string()),
});

const SkippedSchema = z.object({
  eventId: z.string(),
  title: z.string(),
  meetingStart: z.string(),
  reason: z.string(),
});

/** The requesting user's own address — always a recipient of their briefings. */
async function fetchUserEmail(ctx: ToolContext): Promise<string | null> {
  const { data } = await ctx.db.from('users').select('email').eq('id', ctx.userId).maybeSingle();
  const email = (data as { email?: string } | null)?.email;
  return email ? email.trim().toLowerCase() : null;
}

/** The unattended instruction the scheduled job will run when it fires. */
function buildInstruction(m: NormalizedMeeting, recipients: string[], leadMinutes: number): string {
  const guests = m.attendees
    .filter((a) => !a.self)
    .map((a) => a.name ?? a.email)
    .slice(0, 6)
    .join(', ');
  return [
    `Prepare the pre-meeting briefing for the calendar entry with id "${m.id}" — "${m.title}", starting ${m.startHuman} (${m.timeZone}), about ${leadMinutes} minutes from when this runs${guests ? `, with ${guests}` : ''}.`,
    `Call meetings.prepare_briefing with eventId "${m.id}" and use exactly what it returns — do not add facts it did not find, and keep the "what could not be found" notes.`,
    `Deliver it by email to ${recipients.join(', ')}: the subject is the briefing's subject and the body is the briefing's emailHtml (fall back to its markdown if HTML cannot be sent).`,
    'Then reply with the full briefing text so it is delivered even if no email tool is available. Do not schedule anything, do not change any record, and do not contact the meeting guests.',
  ].join(' ');
}

export const meetingsScheduleBriefings = registerTool({
  id: 'meetings.schedule_briefings',
  description:
    "Set up a pre-meeting briefing for every meeting coming up on the user's calendar, each one timed to arrive shortly before that meeting starts. It looks at the next day of meetings, works out what kind of conversation each one is, and books a separate reminder per meeting — 30 minutes ahead by default — that emails the prepared briefing. Personal time, all-day entries, declined invitations and very short meetings are left alone, and a meeting that already has a briefing booked is never booked twice. Returns exactly what was set up and what was left out and why. This creates real reminders, so confirm with the user first.",
  inputSchema: z.object({
    hours: z
      .number()
      .int()
      .min(1)
      .max(168)
      .default(24)
      .describe('How far ahead to scan the calendar, in hours'),
    leadMinutes: z
      .number()
      .int()
      .min(5)
      .max(240)
      .default(30)
      .describe('How long before each meeting the briefing should arrive'),
    minMinutes: z
      .number()
      .int()
      .min(0)
      .max(240)
      .default(15)
      .describe('Skip meetings shorter than this'),
    types: z
      .array(z.enum(TYPES))
      .default(['interview', 'client', 'internal', 'unknown'])
      .describe('Which kinds of meeting deserve a briefing'),
    recipients: z
      .array(z.string().email())
      .max(20)
      .default([])
      .describe('Extra people to send each briefing to, beyond the user'),
    calendarId: z.string().default('primary'),
  }),
  outputSchema: z.object({
    scheduled: z.array(ScheduledSchema),
    skipped: z.array(SkippedSchema),
    scannedCount: z.number(),
    leadMinutes: z.number(),
    windowStart: z.string(),
    windowEnd: z.string(),
    markdown: z.string(),
  }),
  requiresConfirmation: true,
  requiredScopes: [
    { provider: 'google', scopes: ['https://www.googleapis.com/auth/calendar.readonly'] },
  ],
  rateLimit: { perMinute: 4 },
  handler: async (input, ctx) => {
    const hours = input.hours ?? 24;
    const leadMinutes = input.leadMinutes ?? 30;
    const minMinutes = input.minMinutes ?? 15;
    const wanted = new Set<MeetingType>(
      (input.types ?? ['interview', 'client', 'internal', 'unknown']) as MeetingType[],
    );

    const userEmail = await fetchUserEmail(ctx);
    const recipients = [
      ...new Set([...(userEmail ? [userEmail] : []), ...(input.recipients ?? [])]),
    ];
    if (recipients.length === 0) {
      throw new Error(
        'No email address to send the briefings to — the account has no address on file and none was provided.',
      );
    }

    const { meetings, windowStart, windowEnd } = await collectUpcomingMeetings(ctx, {
      calendarId: input.calendarId ?? 'primary',
      hours,
      includeDeclined: false,
      limit: 50,
    });

    const scheduled: Array<z.infer<typeof ScheduledSchema>> = [];
    const skipped: Array<z.infer<typeof SkippedSchema>> = [];
    const skip = (m: NormalizedMeeting, reason: string) =>
      skipped.push({ eventId: m.id, title: m.title, meetingStart: m.start, reason });

    // Meetings already claimed in a previous scan.
    const { data: existingRows } = await ctx.db
      .from('meeting_briefings')
      .select('event_id')
      .eq('user_id', ctx.userId)
      .in(
        'event_id',
        meetings.map((m) => m.id),
      );
    const alreadyClaimed = new Set(
      ((existingRows as Array<{ event_id: string }> | null) ?? []).map((r) => r.event_id),
    );

    const now = Date.now();

    for (const m of meetings) {
      if (alreadyClaimed.has(m.id)) {
        skip(m, 'A briefing is already booked for this meeting.');
        continue;
      }
      if (m.allDay) {
        skip(m, 'All-day entry, not a meeting.');
        continue;
      }
      if (m.myResponse === 'declined') {
        skip(m, 'You declined this invitation.');
        continue;
      }
      if (!wanted.has(m.guessedType)) {
        skip(
          m,
          `Looks like ${meetingTypeLabel(m.guessedType).toLowerCase()}, which is not on the list.`,
        );
        continue;
      }
      if (m.durationMinutes < minMinutes) {
        skip(
          m,
          `Only ${m.durationMinutes} minutes long — shorter than the ${minMinutes} minute cutoff.`,
        );
        continue;
      }

      const startMs = Date.parse(m.start);
      if (!Number.isFinite(startMs)) {
        skip(m, 'The start time on this entry could not be read.');
        continue;
      }
      const sendAtMs = startMs - leadMinutes * 60_000;
      if (sendAtMs <= now) {
        skip(
          m,
          `It starts too soon — there is no room to send a briefing ${leadMinutes} minutes ahead.`,
        );
        continue;
      }
      const sendAt = new Date(sendAtMs).toISOString();

      // 1. Claim the meeting. The unique (user_id, event_id) index is the lock.
      const { data: claim, error: claimError } = await ctx.db
        .from('meeting_briefings')
        .insert({
          user_id: ctx.userId,
          event_id: m.id,
          meeting_start: m.start,
          status: 'scheduled',
        })
        .select('id')
        .single();

      if (claimError) {
        if (claimError.code === UNIQUE_VIOLATION) {
          skip(m, 'A briefing is already booked for this meeting.');
        } else {
          ctx.logger.warn(
            { err: claimError.message, eventId: m.id },
            'meetings.schedule_briefings: claim failed',
          );
          skip(m, 'The reminder could not be recorded, so it was left alone.');
        }
        continue;
      }
      const claimId = (claim as { id: string }).id;

      // 2. Create the one-off job that will send the briefing.
      const { data: job, error: jobError } = await ctx.db
        .from('scheduled_jobs')
        .insert({
          user_id: ctx.userId,
          agent_id: ctx.agentId,
          name: `Briefing: ${m.title}`.slice(0, 120),
          kind: 'agent',
          instruction: buildInstruction(m, recipients, leadMinutes),
          schedule_kind: 'once',
          timezone: m.timeZone,
          run_at: sendAt,
          next_run_at: sendAt,
          status: 'active',
          notify_conversation: true,
          notify_email: true,
          allow_unattended_writes: false,
          recipients,
        })
        .select('id')
        .single();

      if (jobError || !job) {
        // Roll the claim back so a later scan can try again.
        await ctx.db.from('meeting_briefings').delete().eq('id', claimId);
        ctx.logger.warn(
          { err: jobError?.message, eventId: m.id },
          'meetings.schedule_briefings: job creation failed',
        );
        skip(m, 'The reminder could not be created, so nothing was booked for this meeting.');
        continue;
      }
      const jobId = (job as { id: string }).id;

      // 3. Link the claim to its job, so cancelling one shows up in the other.
      await ctx.db.from('meeting_briefings').update({ job_id: jobId }).eq('id', claimId);

      scheduled.push({
        eventId: m.id,
        title: m.title,
        meetingStart: m.start,
        meetingStartHuman: m.startHuman,
        type: m.guessedType,
        sendAt,
        jobId,
        recipients,
      });
    }

    const markdown = [
      scheduled.length
        ? `**${scheduled.length} briefing(s) booked** — each arrives ${leadMinutes} minutes before its meeting, to ${recipients.join(', ')}.`
        : `**No new briefings booked** in the next ${hours} hour(s).`,
      '',
      ...scheduled.map(
        (s) =>
          `- **${s.title}** (${meetingTypeLabel(s.type as MeetingType).toLowerCase()}) — meeting at ${s.meetingStartHuman}, briefing sent ${new Date(s.sendAt).toISOString()}`,
      ),
      skipped.length ? '' : '',
      skipped.length ? '**Left alone:**' : '',
      ...skipped.map((s) => `- ${s.title} — ${s.reason}`),
    ]
      .filter((l, i, arr) => !(l === '' && arr[i - 1] === ''))
      .join('\n')
      .trim();

    return {
      scheduled,
      skipped,
      scannedCount: meetings.length,
      leadMinutes,
      windowStart,
      windowEnd,
      markdown,
    };
  },
});
