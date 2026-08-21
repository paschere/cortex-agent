import { z } from 'zod';
import { registerTool } from '../index';
import { fetchCalendarTimeZone, fetchEventsInRange, normalizeEvent } from '../gcal/events';
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
 * `meetings.list_transcripts` — which recent calls left a record.
 *
 * Answers "what did we discuss with X last time" without knowing the meeting
 * code: scan the recent conferences, keep the ones that produced a transcript,
 * and label each with the calendar title (matched back through the Meet code)
 * plus a short excerpt. The caller then pulls the full text for the one it
 * cares about with `meetings.get_transcript`.
 *
 * Cost discipline: reading entries is one API call per meeting, so the scan is
 * capped and each excerpt reads a single page.
 */

const MAX_RECORDS_SCANNED = 20;

const MeetingSchema = z.object({
  meetingCode: z.string().nullable(),
  title: z.string().nullable(),
  eventId: z.string().nullable(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  durationMinutes: z.number().nullable(),
  participants: z.array(z.string()),
  excerpt: z.string(),
  conferenceRecord: z.string(),
});

export const meetingsListTranscripts = registerTool({
  id: 'meetings.list_transcripts',
  description:
    'Show which recent meetings left a transcript behind, so you can pick the one worth reading. For each call you get the title, when it happened, how long it ran, who took part and the opening lines of the conversation. Ideal for "what did we discuss with Acme last time" or "did we record the interview with María" — filter by a person\'s name or email to narrow it down. Covers the last 7 days by default and up to two months.',
  inputSchema: z.object({
    days: z
      .number()
      .int()
      .min(1)
      .max(60)
      .default(7)
      .describe('How far back to look, in days'),
    limit: z.number().int().min(1).max(25).default(10),
    attendee: z
      .string()
      .optional()
      .describe("Only keep meetings involving this person (name or email, partial is fine)"),
    excerptChars: z.number().int().min(100).max(4000).default(500),
    calendarId: z.string().default('primary'),
  }),
  outputSchema: z.object({
    meetings: z.array(MeetingSchema),
    count: z.number(),
    scanned: z.number(),
    windowStart: z.string(),
    note: z.string(),
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
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const fetchedAt = new Date().toISOString();
    const days = input.days ?? 7;
    const limit = input.limit ?? 10;
    const excerptChars = input.excerptChars ?? 500;
    const calendarId = input.calendarId ?? 'primary';
    const needle = input.attendee?.trim().toLowerCase() ?? null;
    const since = new Date(Date.now() - days * 86_400_000);

    const bail = (note: string) => ({
      meetings: [],
      count: 0,
      scanned: 0,
      windowStart: since.toISOString(),
      note,
      source: 'Google Meet',
      fetchedAt,
      markdown: note,
    });

    // Calendar side: titles and guest lists, indexed by Meet code.
    const byCode = new Map<
      string,
      { title: string; eventId: string; attendeeText: string }
    >();
    try {
      const tz = await fetchCalendarTimeZone(ctx, calendarId);
      const events = await fetchEventsInRange(ctx, {
        calendarId,
        timeMin: since.toISOString(),
        timeMax: new Date(Date.now() + 3_600_000).toISOString(),
        maxResults: 250,
      });
      for (const raw of events) {
        const m = normalizeEvent(raw, tz);
        if (!m.meetCode) continue;
        byCode.set(m.meetCode, {
          title: m.title,
          eventId: m.id,
          attendeeText: m.attendees
            .map((a) => `${a.email} ${a.name ?? ''}`)
            .join(' ')
            .toLowerCase(),
        });
      }
    } catch (err) {
      ctx.logger.warn(
        { err: (err as Error).message },
        'meetings.list_transcripts: calendar titles unavailable',
      );
    }

    let records: Awaited<ReturnType<typeof listConferenceRecords>> = [];
    try {
      records = await listConferenceRecords(ctx, { startAfter: since, pageSize: MAX_RECORDS_SCANNED });
    } catch (err) {
      ctx.logger.warn(
        { err: (err as Error).message },
        'meetings.list_transcripts: Meet lookup failed',
      );
    }

    const liveRows =
      (
        await ctx.db
          .from('live_calls')
          .select('meet_code, title, started_at, ended_at, participants, transcript, session_id')
          .gte('started_at', since.toISOString())
          .order('started_at', { ascending: false })
          .limit(limit)
      ).data ?? [];

    if (records.length === 0 && liveRows.length === 0) {
      return bail(
        `No transcripts were found in the last ${days} day(s). Cortex keeps the calls it joined; Google Meet only leaves a transcript when someone turns transcription on.`,
      );
    }

    const out: Array<z.infer<typeof MeetingSchema>> = [];
    let scanned = 0;

    for (const row of liveRows) {
      if (out.length >= limit) break;
      const lines = (row.transcript as Array<{ text?: string; speaker?: string | null }>) ?? [];
      const excerpt = lines
        .map((l) => `${l.speaker?.trim() ? `${l.speaker}: ` : ''}${l.text ?? ''}`)
        .join('\n')
        .trim()
        .slice(0, excerptChars);
      if (!excerpt) continue;
      const names = [
        ...new Set(
          ((row.participants as Array<{ name?: string }> | null) ?? [])
            .map((p) => p.name)
            .filter((n): n is string => Boolean(n)),
        ),
      ];
      if (needle) {
        const hay = `${names.join(' ')} ${row.title ?? ''}`.toLowerCase();
        if (!hay.includes(needle)) continue;
      }
      const start = row.started_at as string | null;
      const end = row.ended_at as string | null;
      out.push({
        meetingCode: (row.meet_code as string | null) ?? null,
        title: (row.title as string | null) ?? null,
        eventId: null,
        startedAt: start,
        endedAt: end,
        durationMinutes:
          start && end ? Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 60_000)) : null,
        participants: names,
        excerpt: excerpt.length >= excerptChars ? `${excerpt}…` : excerpt,
        conferenceRecord: `liveSessions/${row.session_id as string}`,
      });
    }

    for (const record of records.slice(0, MAX_RECORDS_SCANNED)) {
      if (out.length >= limit) break;
      scanned++;
      try {
        const transcript = pickTranscript(await listTranscripts(ctx, record.name));
        if (!transcript) continue;

        const code = record.space ? await fetchSpaceMeetingCode(ctx, record.space) : null;
        if (code && out.some((m) => m.meetingCode === code.toLowerCase())) continue;
        const calendarMatch = code ? byCode.get(code.toLowerCase()) : undefined;

        const participants = await listParticipants(ctx, record.name);
        const speakers = new Map<string, string>();
        for (const p of participants) {
          if (p.displayName) speakers.set(p.name, p.displayName);
        }
        const names = [...new Set(participants.map((p) => p.displayName).filter(Boolean))] as string[];

        if (needle) {
          const haystack = [
            names.join(' '),
            calendarMatch?.attendeeText ?? '',
            calendarMatch?.title ?? '',
          ]
            .join(' ')
            .toLowerCase();
          if (!haystack.includes(needle)) continue;
        }

        // One page of entries is plenty for an excerpt.
        const text = await fetchTranscriptText(ctx, {
          transcriptName: transcript.name,
          speakers,
          maxChars: excerptChars,
          maxPages: 1,
        });
        if (!text.text.trim()) continue;

        out.push({
          meetingCode: code ?? null,
          title: calendarMatch?.title ?? null,
          eventId: calendarMatch?.eventId ?? null,
          startedAt: record.startTime ?? null,
          endedAt: record.endTime ?? null,
          durationMinutes: recordDurationMinutes(record),
          participants: names,
          excerpt: text.truncated ? `${text.text}…` : text.text,
          conferenceRecord: record.name,
        });
      } catch (err) {
        ctx.logger.warn(
          { err: (err as Error).message, record: record.name },
          'meetings.list_transcripts: skipped a meeting',
        );
      }
    }

    const note =
      out.length === 0
        ? needle
          ? `None of the last ${days} day(s) of calls involving "${input.attendee}" have a transcript. Transcription has to be switched on during the call for one to exist.`
          : `No transcripts were found in the last ${days} day(s). Transcription has to be switched on during a call for one to exist.`
        : `${out.length} meeting(s) with a transcript in the last ${days} day(s).`;

    const markdown =
      out.length === 0
        ? note
        : [
            `**${note}**`,
            '',
            ...out.map((m) =>
              [
                `### ${m.title ?? `Meet ${m.meetingCode ?? 'call'}`}`,
                [
                  m.startedAt ? new Date(m.startedAt).toUTCString() : 'time unknown',
                  m.durationMinutes != null ? `${m.durationMinutes} min` : null,
                ]
                  .filter(Boolean)
                  .join(' · '),
                m.participants.length ? `With: ${m.participants.join(', ')}` : '',
                '',
                `> ${m.excerpt.replace(/\n/g, '\n> ')}`,
                '',
              ]
                .filter((l) => l !== '')
                .join('\n'),
            ),
          ].join('\n');

    return {
      meetings: out,
      count: out.length,
      scanned,
      windowStart: since.toISOString(),
      note,
      source: 'Google Meet',
      fetchedAt,
      markdown,
    };
  },
});
