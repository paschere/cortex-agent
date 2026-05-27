import { z } from 'zod';
import { registerTool } from '../index';
import { gcalFetch } from './client';

export const gcalListEvents = registerTool({
  id: 'gcal.list_events',
  description: "List the user's calendar events between timeMin and timeMax.",
  inputSchema: z.object({
    calendarId: z.string().default('primary'),
    timeMin: z.string().optional(),
    timeMax: z.string().optional(),
    q: z.string().optional(),
    maxResults: z.number().int().min(1).max(50).default(10),
  }),
  outputSchema: z.object({
    events: z.array(
      z.object({
        id: z.string(),
        summary: z.string().nullable(),
        description: z.string().nullable().optional(),
        start: z.string(),
        end: z.string(),
        attendees: z.array(z.string()).optional(),
        htmlLink: z.string().nullable(),
      }),
    ),
  }),
  requiredScopes: [{ provider: 'google', scopes: ['https://www.googleapis.com/auth/calendar.readonly'] }],
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    type GCalEvent = {
      id: string;
      summary?: string;
      description?: string;
      start: { dateTime?: string; date?: string };
      end: { dateTime?: string; date?: string };
      attendees?: Array<{ email: string }>;
      htmlLink?: string;
    };
    type R = { items?: GCalEvent[] };

    const params = new URLSearchParams({
      maxResults: String(input.maxResults),
      singleEvents: 'true',
      orderBy: 'startTime',
    });
    if (input.timeMin) params.set('timeMin', input.timeMin);
    if (input.timeMax) params.set('timeMax', input.timeMax);
    if (input.q) params.set('q', input.q);

    const calendarId = encodeURIComponent(input.calendarId ?? 'primary');
    const r = await gcalFetch<R>(ctx, `/calendars/${calendarId}/events?${params.toString()}`);
    return {
      events: (r.items ?? []).map((e) => ({
        id: e.id,
        summary: e.summary ?? null,
        description: e.description ?? null,
        start: e.start.dateTime ?? e.start.date ?? '',
        end: e.end.dateTime ?? e.end.date ?? '',
        attendees: (e.attendees ?? []).map((a) => a.email),
        htmlLink: e.htmlLink ?? null,
      })),
    };
  },
});
