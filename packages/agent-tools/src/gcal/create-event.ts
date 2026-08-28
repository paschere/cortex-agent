import { z } from 'zod';
import { registerTool } from '../index';
import { gcalFetch } from './client';

export const gcalCreateEvent = registerTool({
  id: 'gcal.create_event',
  description:
    "Create a calendar event on the user's calendar with attendees. Requires user confirmation.",
  inputSchema: z.object({
    calendarId: z.string().default('primary'),
    summary: z.string().min(1),
    description: z.string().optional(),
    start: z.string(),
    end: z.string(),
    attendees: z.array(z.string().email()).optional(),
    sendUpdates: z.enum(['all', 'externalOnly', 'none']).default('none'),
    timeZone: z.string().default('America/Mexico_City'),
  }),
  outputSchema: z.object({
    event: z.object({
      id: z.string(),
      summary: z.string(),
      htmlLink: z.string(),
    }),
  }),
  requiresConfirmation: true,
  requiredScopes: [
    { provider: 'google', scopes: ['https://www.googleapis.com/auth/calendar.events'] },
  ],
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    type R = { id: string; summary: string; htmlLink: string };

    const calendarId = encodeURIComponent(input.calendarId ?? 'primary');
    const body = {
      summary: input.summary,
      description: input.description ?? '',
      start: { dateTime: input.start, timeZone: input.timeZone },
      end: { dateTime: input.end, timeZone: input.timeZone },
      attendees: (input.attendees ?? []).map((email) => ({ email })),
    };

    const r = await gcalFetch<R>(
      ctx,
      `/calendars/${calendarId}/events?sendUpdates=${input.sendUpdates ?? 'none'}`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
    );
    return { event: { id: r.id, summary: r.summary, htmlLink: r.htmlLink } };
  },
});
