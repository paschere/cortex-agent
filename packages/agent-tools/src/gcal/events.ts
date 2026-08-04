/**
 * Calendar event plumbing shared by `gcal.upcoming_meetings` and the
 * `meetings.*` family: fetching raw events, turning them into one
 * model-friendly meeting shape, and pulling the Meet code out of an invite.
 *
 * `gcal.list_events` deliberately keeps its thin shape — this module is the
 * richer view built on top of the same Calendar API.
 */

import type { ToolContext } from '../types';
import { gcalFetch } from './client';
import { classifyMeeting, isExternalEmail, type MeetingType } from './classify';

export interface RawGCalEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  hangoutLink?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  organizer?: { email?: string; displayName?: string; self?: boolean };
  creator?: { email?: string; displayName?: string; self?: boolean };
  attendees?: Array<{
    email?: string;
    displayName?: string;
    organizer?: boolean;
    self?: boolean;
    optional?: boolean;
    resource?: boolean;
    responseStatus?: string;
  }>;
  conferenceData?: {
    conferenceId?: string;
    entryPoints?: Array<{ entryPointType?: string; uri?: string; label?: string }>;
    conferenceSolution?: { name?: string };
  };
}

export interface MeetingAttendee {
  email: string;
  name: string | null;
  external: boolean;
  optional: boolean;
  organizer: boolean;
  self: boolean;
  responseStatus: string | null;
}

export interface NormalizedMeeting {
  id: string;
  title: string;
  description: string | null;
  descriptionTruncated: boolean;
  start: string;
  end: string;
  startHuman: string;
  endHuman: string;
  timeZone: string;
  allDay: boolean;
  durationMinutes: number;
  status: string;
  myResponse: string | null;
  organizer: { email: string | null; name: string | null };
  attendees: MeetingAttendee[];
  externalAttendees: string[];
  externalDomains: string[];
  location: string | null;
  conferenceLink: string | null;
  meetCode: string | null;
  htmlLink: string | null;
  guessedType: MeetingType;
  typeConfidence: number;
  typeReasons: string[];
}

const DESCRIPTION_LIMIT = 600;

/**
 * Pull the Meet code (`abc-defg-hij`) out of whatever the invite carries: the
 * dedicated conferenceId field, the hangout link, a video entry point, or a
 * meet.google.com URL pasted into the location or body.
 */
export function parseMeetCode(source: {
  hangoutLink?: string;
  conferenceData?: RawGCalEvent['conferenceData'];
  location?: string;
  description?: string;
}): string | null {
  const direct = source.conferenceData?.conferenceId?.trim();
  if (direct && /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(direct)) return direct.toLowerCase();

  const candidates: string[] = [];
  if (source.hangoutLink) candidates.push(source.hangoutLink);
  for (const ep of source.conferenceData?.entryPoints ?? []) {
    if (ep.uri) candidates.push(ep.uri);
  }
  if (source.location) candidates.push(source.location);
  if (source.description) candidates.push(source.description);

  for (const c of candidates) {
    const m = c.match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
    if (m?.[1]) return m[1].toLowerCase();
  }
  // A bare code typed into the location field.
  if (direct) return direct.toLowerCase();
  return null;
}

/** The joinable link for the meeting, Meet or otherwise (Zoom, Teams, …). */
export function conferenceLinkOf(e: RawGCalEvent): string | null {
  if (e.hangoutLink) return e.hangoutLink;
  const video = (e.conferenceData?.entryPoints ?? []).find((ep) => ep.entryPointType === 'video');
  if (video?.uri) return video.uri;
  const anyUri = (e.conferenceData?.entryPoints ?? []).find((ep) => ep.uri);
  if (anyUri?.uri) return anyUri.uri;
  if (e.location && /^https?:\/\//i.test(e.location)) return e.location;
  return null;
}

function formatHuman(iso: string, timeZone: string, allDay: boolean): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      ...(allDay ? {} : { hour: 'numeric', minute: '2-digit', hour12: true }),
      timeZone,
    }).format(d);
  } catch {
    return d.toISOString();
  }
}

/** The calendar's own timezone, so human times read the way the owner sees them. */
export async function fetchCalendarTimeZone(ctx: ToolContext, calendarId: string): Promise<string> {
  try {
    const cal = await gcalFetch<{ timeZone?: string }>(
      ctx,
      `/calendars/${encodeURIComponent(calendarId)}`,
    );
    return cal.timeZone ?? 'UTC';
  } catch {
    return 'UTC';
  }
}

/** One event by id. Returns null when Calendar has no such event. */
export async function fetchEvent(
  ctx: ToolContext,
  calendarId: string,
  eventId: string,
): Promise<RawGCalEvent | null> {
  try {
    return await gcalFetch<RawGCalEvent>(
      ctx,
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    );
  } catch (err) {
    if (/ 404 /.test((err as Error).message)) return null;
    throw err;
  }
}

/** Events in a window, single (expanded) occurrences, ordered by start time. */
export async function fetchEventsInRange(
  ctx: ToolContext,
  opts: {
    calendarId: string;
    timeMin: string;
    timeMax: string;
    maxResults?: number;
    q?: string;
  },
): Promise<RawGCalEvent[]> {
  const params = new URLSearchParams({
    timeMin: opts.timeMin,
    timeMax: opts.timeMax,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: String(Math.min(opts.maxResults ?? 50, 250)),
  });
  if (opts.q) params.set('q', opts.q);
  const r = await gcalFetch<{ items?: RawGCalEvent[] }>(
    ctx,
    `/calendars/${encodeURIComponent(opts.calendarId)}/events?${params.toString()}`,
  );
  return r.items ?? [];
}

/** Turn a raw Calendar event into the shape every meeting tool speaks. */
export function normalizeEvent(e: RawGCalEvent, calendarTimeZone: string): NormalizedMeeting {
  const allDay = Boolean(e.start?.date && !e.start?.dateTime);
  const start = e.start?.dateTime ?? e.start?.date ?? '';
  const end = e.end?.dateTime ?? e.end?.date ?? '';
  const timeZone = e.start?.timeZone ?? calendarTimeZone;

  const startMs = start ? Date.parse(start) : Number.NaN;
  const endMs = end ? Date.parse(end) : Number.NaN;
  const durationMinutes =
    Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
      ? Math.round((endMs - startMs) / 60000)
      : 0;

  const attendees: MeetingAttendee[] = (e.attendees ?? [])
    .filter((a) => a.email && !a.resource)
    .map((a) => ({
      email: (a.email ?? '').toLowerCase(),
      name: a.displayName ?? null,
      external: isExternalEmail(a.email),
      optional: Boolean(a.optional),
      organizer: Boolean(a.organizer),
      self: Boolean(a.self),
      responseStatus: a.responseStatus ?? null,
    }));

  const myResponse = attendees.find((a) => a.self)?.responseStatus ?? null;
  const otherEmails = attendees.filter((a) => !a.self).map((a) => a.email);

  const rawDescription = e.description?.trim() ?? '';
  const descriptionTruncated = rawDescription.length > DESCRIPTION_LIMIT;
  const description = rawDescription
    ? descriptionTruncated
      ? `${rawDescription.slice(0, DESCRIPTION_LIMIT)}…`
      : rawDescription
    : null;

  const classification = classifyMeeting({
    title: e.summary ?? null,
    description: rawDescription,
    attendeeEmails: otherEmails,
    hasAttendeeList: Array.isArray(e.attendees) && e.attendees.length > 0,
    organizerEmail: e.organizer?.email ?? null,
  });

  return {
    id: e.id,
    title: e.summary?.trim() || '(no title)',
    description,
    descriptionTruncated,
    start,
    end,
    startHuman: start ? formatHuman(start, timeZone, allDay) : '',
    endHuman: end ? formatHuman(end, timeZone, allDay) : '',
    timeZone,
    allDay,
    durationMinutes,
    status: e.status ?? 'confirmed',
    myResponse,
    organizer: { email: e.organizer?.email ?? null, name: e.organizer?.displayName ?? null },
    attendees,
    externalAttendees: classification.externalAttendees,
    externalDomains: classification.externalDomains,
    location: e.location ?? null,
    conferenceLink: conferenceLinkOf(e),
    meetCode: parseMeetCode(e),
    htmlLink: e.htmlLink ?? null,
    guessedType: classification.type,
    typeConfidence: classification.confidence,
    typeReasons: classification.reasons,
  };
}

/**
 * Upcoming meetings in one call — the shared engine behind
 * `gcal.upcoming_meetings` and `meetings.schedule_briefings`.
 */
export async function collectUpcomingMeetings(
  ctx: ToolContext,
  opts: {
    calendarId?: string;
    hours?: number;
    includeDeclined?: boolean;
    limit?: number;
  } = {},
): Promise<{
  meetings: NormalizedMeeting[];
  windowStart: string;
  windowEnd: string;
  timeZone: string;
}> {
  const calendarId = opts.calendarId ?? 'primary';
  const hours = Math.min(Math.max(opts.hours ?? 24, 1), 336);
  const now = new Date();
  const windowStart = now.toISOString();
  const windowEnd = new Date(now.getTime() + hours * 3_600_000).toISOString();

  const timeZone = await fetchCalendarTimeZone(ctx, calendarId);
  const raw = await fetchEventsInRange(ctx, {
    calendarId,
    timeMin: windowStart,
    timeMax: windowEnd,
    maxResults: Math.min((opts.limit ?? 25) * 3, 250),
  });

  const meetings = raw
    .filter((e) => e.status !== 'cancelled')
    .map((e) => normalizeEvent(e, timeZone))
    .filter((m) => (opts.includeDeclined ? true : m.myResponse !== 'declined'))
    .slice(0, opts.limit ?? 25);

  return { meetings, windowStart, windowEnd, timeZone };
}
