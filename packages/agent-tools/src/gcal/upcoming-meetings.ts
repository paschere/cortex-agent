import { z } from "zod";
import { registerTool } from "../index";
import { meetingTypeLabel } from "./classify";
import { collectUpcomingMeetings, type NormalizedMeeting } from "./events";

/**
 * `gcal.upcoming_meetings` — the "what's on my plate" view.
 *
 * `gcal.list_events` returns raw calendar rows; this one returns *meetings*:
 * who is in them, who is an outsider, how long they run, where they happen,
 * and what kind of conversation each one is. That last bit is what lets a
 * briefing know whether to look up a candidate or an account.
 */

const AttendeeSchema = z.object({
  email: z.string(),
  name: z.string().nullable(),
  external: z.boolean(),
  optional: z.boolean(),
  organizer: z.boolean(),
  responseStatus: z.string().nullable(),
});

const MeetingSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  start: z.string(),
  end: z.string(),
  startHuman: z.string(),
  endHuman: z.string(),
  timeZone: z.string(),
  allDay: z.boolean(),
  durationMinutes: z.number(),
  myResponse: z.string().nullable(),
  organizer: z.object({
    email: z.string().nullable(),
    name: z.string().nullable(),
  }),
  attendees: z.array(AttendeeSchema),
  externalAttendees: z.array(z.string()),
  externalDomains: z.array(z.string()),
  location: z.string().nullable(),
  conferenceLink: z.string().nullable(),
  meetCode: z.string().nullable(),
  htmlLink: z.string().nullable(),
  guessedType: z.enum([
    "interview",
    "client",
    "internal",
    "personal",
    "unknown",
  ]),
  typeConfidence: z.number(),
  typeReasons: z.array(z.string()),
});

function renderMarkdown(meetings: NormalizedMeeting[], hours: number): string {
  if (meetings.length === 0) {
    return `Nothing on the calendar for the next ${hours} hour(s).`;
  }
  const lines = [
    `**${meetings.length} meeting(s) in the next ${hours} hour(s)**`,
    "",
  ];
  for (const m of meetings) {
    const guests = m.attendees.filter((a) => !a.self);
    const externals = guests.filter((a) => a.external);
    lines.push(`### ${m.title}`);
    lines.push(
      `${m.startHuman} – ${m.endHuman} · ${m.allDay ? "all day" : `${m.durationMinutes} min`} · ${meetingTypeLabel(m.guessedType)}`,
    );
    if (guests.length) {
      const shown = guests
        .slice(0, 8)
        .map(
          (a) => `${a.name ?? a.email}${a.external ? " (external)" : ""}`,
        )
        .join(", ");
      lines.push(
        `With: ${shown}${guests.length > 8 ? ` and ${guests.length - 8} more` : ""}`,
      );
    } else {
      lines.push("With: no other guests");
    }
    if (externals.length)
      lines.push(`Outside domains: ${m.externalDomains.join(", ")}`);
    if (m.conferenceLink) lines.push(`Join: ${m.conferenceLink}`);
    else if (m.location) lines.push(`Where: ${m.location}`);
    if (m.myResponse && m.myResponse !== "accepted")
      lines.push(`Your reply: ${m.myResponse}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export const gcalUpcomingMeetings = registerTool({
  id: "gcal.upcoming_meetings",
  description:
    "See what meetings are coming up on the user's calendar, ready to act on. For each one you get the title, when it starts and ends, how long it runs, who is invited (and which of them are outside the company), the organizer, where it happens or the video link, and a best guess at what kind of conversation it is — an interview, a client call, something internal, or personal time. Use it to answer \"what's on my calendar today\", to pick the meeting someone is talking about, or as the first step before preparing a briefing. Looks 24 hours ahead by default and can reach up to two weeks.",
  inputSchema: z.object({
    hours: z
      .number()
      .int()
      .min(1)
      .max(336)
      .default(24)
      .describe(
        "How far ahead to look, in hours. 24 = the rest of today and tomorrow morning.",
      ),
    includeDeclined: z
      .boolean()
      .default(false)
      .describe("Include meetings the user already declined"),
    calendarId: z.string().default("primary"),
    limit: z.number().int().min(1).max(50).default(25),
  }),
  outputSchema: z.object({
    meetings: z.array(MeetingSchema),
    count: z.number(),
    windowStart: z.string(),
    windowEnd: z.string(),
    timeZone: z.string(),
    markdown: z.string(),
  }),
  requiredScopes: [
    {
      provider: "google",
      scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
    },
  ],
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const hours = input.hours ?? 24;
    const { meetings, windowStart, windowEnd, timeZone } =
      await collectUpcomingMeetings(ctx, {
        calendarId: input.calendarId ?? "primary",
        hours,
        includeDeclined: input.includeDeclined ?? false,
        limit: input.limit ?? 25,
      });

    return {
      meetings: meetings.map((m) => ({
        id: m.id,
        title: m.title,
        description: m.description,
        start: m.start,
        end: m.end,
        startHuman: m.startHuman,
        endHuman: m.endHuman,
        timeZone: m.timeZone,
        allDay: m.allDay,
        durationMinutes: m.durationMinutes,
        myResponse: m.myResponse,
        organizer: m.organizer,
        attendees: m.attendees
          .filter((a) => !a.self)
          .map((a) => ({
            email: a.email,
            name: a.name,
            external: a.external,
            optional: a.optional,
            organizer: a.organizer,
            responseStatus: a.responseStatus,
          })),
        externalAttendees: m.externalAttendees,
        externalDomains: m.externalDomains,
        location: m.location,
        conferenceLink: m.conferenceLink,
        meetCode: m.meetCode,
        htmlLink: m.htmlLink,
        guessedType: m.guessedType,
        typeConfidence: m.typeConfidence,
        typeReasons: m.typeReasons,
      })),
      count: meetings.length,
      windowStart,
      windowEnd,
      timeZone,
      markdown: renderMarkdown(meetings, hours),
    };
  },
});
