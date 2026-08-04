import { z } from 'zod';
import { registerTool } from '../index';
import { fetchEvent, normalizeEvent } from '../gcal/events';
import {
  MEET_READONLY_SCOPE,
  fetchSpaceMeetingCode,
  fetchTranscriptText,
  listConferenceRecords,
  listParticipants,
  listTranscripts,
  pickTranscript,
  recordDurationMinutes,
} from './client';

/**
 * `meetings.get_transcript` — read what was actually said in a meeting.
 *
 * Takes whatever the caller has: a calendar event id (the meeting code is
 * resolved from the invite) or the Meet code itself. Scans the most recent
 * conferences for that code and returns the first one that produced a
 * finished transcript.
 *
 * Missing transcripts are the normal case, not an error: Meet only writes one
 * when someone turned transcription on. The tool always resolves, and says so
 * in plain words via `available: false` + `note`.
 */

const NOT_ENABLED_NOTE =
  'No transcript was found for this meeting. Google Meet only writes one when someone turns on transcription (or recording with transcript) during the call, so this most likely means it was never enabled. It can also take a few minutes to appear after a call ends.';

export const meetingsGetTranscript = registerTool({
  id: 'meetings.get_transcript',
  description:
    'Read the transcript of a past Google Meet call — the full conversation with who said what. Give it either the calendar entry for the meeting or the Meet code from the invite link, and it finds the most recent recorded session and returns the text, who took part, when it ended and how long it ran. Use it to answer "what did we agree on", "what did the client ask for", or to recap a call someone missed. If nobody turned on transcription there is nothing to read, and it will say so plainly instead of failing.',
  inputSchema: z
    .object({
      eventId: z.string().optional().describe('Calendar entry id for the meeting'),
      meetCode: z
        .string()
        .optional()
        .describe('Meet code from the join link, e.g. "abc-defg-hij"'),
      calendarId: z.string().default('primary'),
      maxChars: z
        .number()
        .int()
        .min(1000)
        .max(200_000)
        .default(20_000)
        .describe('Stop reading after this many characters of conversation'),
      lookbackDays: z
        .number()
        .int()
        .min(1)
        .max(180)
        .default(30)
        .describe('How far back to look for a session of this meeting'),
    })
    .refine((v) => Boolean(v.eventId || v.meetCode), {
      message: 'Provide the calendar entry id or the Meet code',
    }),
  outputSchema: z.object({
    available: z.boolean(),
    note: z.string(),
    eventId: z.string().nullable(),
    title: z.string().nullable(),
    meetingCode: z.string().nullable(),
    startedAt: z.string().nullable(),
    endedAt: z.string().nullable(),
    durationMinutes: z.number().nullable(),
    participants: z.array(z.string()),
    transcript: z.string(),
    truncated: z.boolean(),
    totalChars: z.number(),
    source: z.string(),
    fetchedAt: z.string(),
    markdown: z.string(),
  }),
  requiredScopes: [
    {
      provider: 'google',
      scopes: ['https://www.googleapis.com/auth/calendar.readonly', MEET_READONLY_SCOPE],
    },
  ],
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const fetchedAt = new Date().toISOString();
    const maxChars = input.maxChars ?? 20_000;
    const lookbackDays = input.lookbackDays ?? 30;

    const empty = (note: string, extra: Partial<{ title: string | null; meetingCode: string | null }> = {}) => ({
      available: false,
      note,
      eventId: input.eventId ?? null,
      title: extra.title ?? null,
      meetingCode: extra.meetingCode ?? input.meetCode ?? null,
      startedAt: null,
      endedAt: null,
      durationMinutes: null,
      participants: [] as string[],
      transcript: '',
      truncated: false,
      totalChars: 0,
      source: 'Google Meet',
      fetchedAt,
      markdown: note,
    });

    // Resolve the meeting code — from the invite when only an event id is known.
    let meetingCode = input.meetCode?.trim().toLowerCase() ?? null;
    let title: string | null = null;
    if (input.eventId) {
      const raw = await fetchEvent(ctx, input.calendarId ?? 'primary', input.eventId);
      if (!raw) {
        return empty('That meeting is not on the calendar any more, so there is nothing to read.');
      }
      const meeting = normalizeEvent(raw, 'UTC');
      title = meeting.title;
      meetingCode = meetingCode ?? meeting.meetCode;
      if (!meetingCode) {
        return empty(
          'This calendar entry has no Google Meet link, so there is no Meet transcript to read. If the call happened somewhere else (Zoom, a phone call, in person), the notes would have to come from elsewhere.',
          { title },
        );
      }
    }
    if (!meetingCode) return empty('No Meet code was provided and none could be resolved.');

    try {
      const startAfter = new Date(Date.now() - lookbackDays * 86_400_000);
      const records = await listConferenceRecords(ctx, { meetingCode, startAfter, pageSize: 25 });
      if (records.length === 0) {
        return empty(
          `No Google Meet session was found for this meeting in the last ${lookbackDays} days. Either the call has not happened yet, or it ran under a different link.`,
          { title, meetingCode },
        );
      }

      // Newest first; the first record with a finished transcript wins.
      for (const record of records.slice(0, 5)) {
        const transcripts = await listTranscripts(ctx, record.name);
        const transcript = pickTranscript(transcripts);
        if (!transcript) continue;

        const participants = await listParticipants(ctx, record.name);
        const speakers = new Map<string, string>();
        for (const p of participants) {
          if (p.displayName) speakers.set(p.name, p.displayName);
        }

        const text = await fetchTranscriptText(ctx, {
          transcriptName: transcript.name,
          speakers,
          maxChars,
        });

        if (!text.text.trim()) {
          return empty(
            'A transcript exists for this meeting but it came back empty — Meet may still be finishing it. Try again in a few minutes.',
            { title, meetingCode },
          );
        }

        const names = [...new Set(participants.map((p) => p.displayName).filter(Boolean))] as string[];
        const duration = recordDurationMinutes(record);
        const note = text.truncated
          ? `Transcript found. Showing the first ${maxChars.toLocaleString()} characters of a longer conversation.`
          : 'Full transcript found.';

        const markdown = [
          `# Transcript — ${title ?? `Meet ${meetingCode}`}`,
          [
            record.endTime ? `Ended ${record.endTime}` : null,
            duration != null ? `${duration} min` : null,
            names.length ? `${names.length} participant(s)` : null,
          ]
            .filter(Boolean)
            .join(' · '),
          names.length ? `**Who was there:** ${names.join(', ')}` : '',
          '',
          text.text,
          text.truncated ? '\n_(transcript continues beyond this point)_' : '',
        ]
          .filter((l) => l !== '')
          .join('\n');

        return {
          available: true,
          note,
          eventId: input.eventId ?? null,
          title,
          meetingCode,
          startedAt: record.startTime ?? null,
          endedAt: record.endTime ?? null,
          durationMinutes: duration,
          participants: names,
          transcript: text.text,
          truncated: text.truncated,
          totalChars: text.totalChars,
          source: 'Google Meet',
          fetchedAt,
          markdown,
        };
      }

      // Sessions exist, but none of them produced a transcript.
      const latest = records[0];
      const code = latest?.space ? await fetchSpaceMeetingCode(ctx, latest.space) : null;
      return empty(NOT_ENABLED_NOTE, { title, meetingCode: code ?? meetingCode });
    } catch (err) {
      // Never hand the model a raw failure to interpret — say what is missing.
      ctx.logger.warn(
        { err: (err as Error).message, meetingCode },
        'meetings.get_transcript: Meet lookup failed',
      );
      return empty(
        "The meeting records could not be reached right now, so the transcript is unavailable. This usually means the Google account needs to be reconnected with permission to read Meet recordings. Nothing was lost — try again once that's sorted.",
        { title, meetingCode },
      );
    }
  },
});
