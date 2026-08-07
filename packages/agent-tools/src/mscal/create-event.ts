import { z } from 'zod';
import { registerTool } from '../index';
import { GRAPH_SCOPES, graphFetch } from '../msgraph/client';

interface CreatedEvent {
  id: string;
  subject?: string | null;
  webLink?: string;
}

export const mscalCreateEvent = registerTool({
  id: 'mscal.create_event',
  description:
    "Create an event on the user's Outlook / Microsoft 365 calendar, with attendees. Requires user confirmation. " +
    'NOTE the one difference from gcal.create_event: Microsoft always emails the invitation to whoever is listed as an attendee — there is no "do not notify" option on Graph. Leave attendees empty for a private block of time.',
  inputSchema: z.object({
    summary: z.string().min(1),
    description: z.string().optional(),
    start: z.string().describe('ISO 8601 local date-time, e.g. 2026-08-14T09:00:00'),
    end: z.string().describe('ISO 8601 local date-time, e.g. 2026-08-14T09:30:00'),
    attendees: z.array(z.string().email()).optional(),
    location: z.string().optional(),
    timeZone: z.string().default('America/Bogota'),
    onlineMeeting: z
      .boolean()
      .default(false)
      .describe('Attach a Microsoft Teams link to the invitation'),
  }),
  outputSchema: z.object({
    event: z.object({
      id: z.string(),
      summary: z.string(),
      htmlLink: z.string(),
    }),
  }),
  requiresConfirmation: true,
  requiredScopes: [{ provider: 'microsoft', scopes: [GRAPH_SCOPES.CALENDARS_READ_WRITE] }],
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    // Graph wants a naked local date-time plus a named zone; an offset-bearing
    // string ("…T09:00:00-05:00") is rejected. Trimming it here means the model
    // can hand over either spelling without a 400 coming back.
    const local = (value: string) => value.replace(/(Z|[+-]\d{2}:?\d{2})$/, '');

    const body: Record<string, unknown> = {
      subject: input.summary,
      body: { contentType: 'Text', content: input.description ?? '' },
      start: { dateTime: local(input.start), timeZone: input.timeZone },
      end: { dateTime: local(input.end), timeZone: input.timeZone },
      attendees: (input.attendees ?? []).map((address) => ({
        emailAddress: { address },
        type: 'required',
      })),
    };
    if (input.location) body.location = { displayName: input.location };
    if (input.onlineMeeting) {
      body.isOnlineMeeting = true;
      body.onlineMeetingProvider = 'teamsForBusiness';
    }

    const r = await graphFetch<CreatedEvent>(ctx, '/me/events', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    return {
      event: {
        id: r.id,
        summary: r.subject ?? input.summary,
        htmlLink: r.webLink ?? `https://outlook.office.com/calendar/item/${r.id}`,
      },
    };
  },
});
