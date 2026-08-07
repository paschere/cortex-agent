import { z } from 'zod';
import { registerTool } from '../index';
import { GRAPH_SCOPES, graphFetch } from '../msgraph/client';

interface GraphEvent {
  id: string;
  subject?: string | null;
  bodyPreview?: string | null;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  isAllDay?: boolean;
  attendees?: Array<{ emailAddress?: { address?: string } }>;
  webLink?: string;
  organizer?: { emailAddress?: { address?: string; name?: string } };
}

const EVENT_SELECT = 'id,subject,bodyPreview,start,end,isAllDay,attendees,webLink,organizer';

export const mscalListEvents = registerTool({
  id: 'mscal.list_events',
  description:
    "Calendar rows from Outlook / Microsoft 365 for an explicit window: title, start, end, attendee addresses and a link. This is the tool for the PAST ('what meetings did I have last week') and for the near future. " +
    'The Microsoft 365 twin of gcal.list_events; use whichever calendar the person actually has.',
  inputSchema: z.object({
    timeMin: z
      .string()
      .optional()
      .describe('ISO 8601 start of the window. Defaults to now when timeMax is given.'),
    timeMax: z
      .string()
      .optional()
      .describe('ISO 8601 end of the window. Defaults to 30 days out.'),
    q: z.string().optional().describe('Only events whose title or preview contains this text'),
    maxResults: z.number().int().min(1).max(50).default(10),
    timeZone: z
      .string()
      .default('America/Bogota')
      .describe('IANA zone the returned times are expressed in'),
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
  requiredScopes: [{ provider: 'microsoft', scopes: [GRAPH_SCOPES.CALENDARS_READ] }],
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const now = new Date();
    const maxResults = input.maxResults ?? 10;
    const timeZone = input.timeZone ?? 'America/Bogota';
    const timeMin = input.timeMin ?? now.toISOString();
    const timeMax = input.timeMax ?? new Date(now.getTime() + 30 * 86_400_000).toISOString();

    // `calendarView` rather than `/me/events`: it expands recurring series into
    // the individual occurrences that actually sit in the window, which is what
    // `singleEvents=true` does on the Google side. `/me/events` would return
    // the series master and a person would be told about a meeting on the wrong
    // day.
    const params = new URLSearchParams({
      startDateTime: timeMin,
      endDateTime: timeMax,
      $select: EVENT_SELECT,
      $orderby: 'start/dateTime',
      // Over-fetch when filtering by text, since the filtering happens here.
      $top: String(Math.min(input.q ? maxResults * 5 : maxResults, 250)),
    });

    const r = await graphFetch<{ value?: GraphEvent[] }>(
      ctx,
      `/me/calendarView?${params.toString()}`,
      {
        // Graph returns UTC unless asked otherwise. Asking for the caller's zone
        // means the strings read the way the calendar's owner sees them.
        prefer: [`outlook.timezone="${timeZone}"`],
      },
    );

    const needle = input.q?.trim().toLowerCase();
    const items = (r?.value ?? []).filter((e) => {
      if (!needle) return true;
      // Filtered here rather than with `$search`: Graph does not support
      // `$search` on calendarView at all, and `$filter=contains(subject,…)` is
      // rejected on the same endpoint. A substring match over the page we
      // already fetched is predictable and cannot 400.
      return `${e.subject ?? ''} ${e.bodyPreview ?? ''}`.toLowerCase().includes(needle);
    });

    return {
      events: items.slice(0, maxResults).map((e) => ({
        id: e.id,
        summary: e.subject ?? null,
        description: e.bodyPreview ?? null,
        start: e.start?.dateTime ?? '',
        end: e.end?.dateTime ?? '',
        attendees: (e.attendees ?? [])
          .map((a) => a.emailAddress?.address ?? '')
          .filter((a) => a.length > 0),
        htmlLink: e.webLink ?? null,
      })),
    };
  },
});
