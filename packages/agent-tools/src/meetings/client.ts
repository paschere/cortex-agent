/**
 * Google Meet REST API v2 client — conference records, transcripts, and the
 * transcript entries that reconstruct what was said.
 *
 * Deliberately NOT the Drive route: Meet writes transcripts to a Google Doc,
 * but the same text is readable straight from `transcripts/*​/entries`, which
 * needs only the Meet scope. No Drive access, no file hunting, no permission
 * surprises when the recording lives in someone else's My Drive.
 *
 * Mirrors the working client in zipdev-matcher (lib/google/meet-transcripts.ts),
 * adapted to ToolContext + ctx.integrations.getAccessToken('google').
 */

import { IntegrationError } from '@zipdev/core';
import type { ToolContext } from '../types';

const MEET_API = 'https://meet.googleapis.com/v2';

/**
 * `meetings.space.readonly` covers everything this family reads:
 * conferenceRecords.list, participants.list, transcripts.list and
 * transcripts.entries.list all accept it. `meetings.space.created` is the
 * narrower alternative (only spaces the app itself created) and would NOT
 * cover meetings created from Google Calendar, so it is not requested.
 */
export const MEET_READONLY_SCOPE = 'https://www.googleapis.com/auth/meetings.space.readonly';

export interface ConferenceRecord {
  name: string; // "conferenceRecords/xxx"
  startTime?: string;
  endTime?: string;
  space?: string; // "spaces/xxx"
}

export interface TranscriptRef {
  name: string; // "conferenceRecords/xxx/transcripts/yyy"
  state?: string; // STARTED | ENDED | FILE_GENERATED
  startTime?: string;
  endTime?: string;
}

export interface MeetParticipant {
  name: string; // participant resource name
  displayName: string | null;
}

async function meetGet<T>(ctx: ToolContext, path: string): Promise<T> {
  const { token } = await ctx.integrations.getAccessToken('google');
  const r = await fetch(`${MEET_API}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: ctx.signal,
  });
  if (!r.ok) {
    throw new IntegrationError(`Meet ${r.status} ${path}: ${await r.text()}`, 'google');
  }
  return r.json() as Promise<T>;
}

/** Google accepts the dashed code; some older invites carry it undashed. */
export function meetCodeVariants(code: string): string[] {
  const clean = code.trim().toLowerCase().replace(/^https?:\/\/meet\.google\.com\//, '');
  const dashed = clean;
  const undashed = clean.replace(/-/g, '');
  return dashed === undashed ? [dashed] : [dashed, undashed];
}

/**
 * Past conferences, newest first. Filter by meeting code and/or a start-time
 * floor; both are server-side filters supported by conferenceRecords.list.
 */
export async function listConferenceRecords(
  ctx: ToolContext,
  opts: { meetingCode?: string; startAfter?: Date; pageSize?: number } = {},
): Promise<ConferenceRecord[]> {
  const codes = opts.meetingCode ? meetCodeVariants(opts.meetingCode) : [undefined];

  for (const code of codes) {
    const clauses: string[] = [];
    if (code) clauses.push(`space.meeting_code = "${code}"`);
    if (opts.startAfter) clauses.push(`start_time >= "${opts.startAfter.toISOString()}"`);
    const params = new URLSearchParams({ pageSize: String(opts.pageSize ?? 25) });
    if (clauses.length) params.set('filter', clauses.join(' AND '));

    const data = await meetGet<{ conferenceRecords?: ConferenceRecord[] }>(
      ctx,
      `conferenceRecords?${params.toString()}`,
    );
    const records = data.conferenceRecords ?? [];
    if (records.length > 0) {
      return [...records].sort(
        (a, b) => Date.parse(b.startTime ?? '') - Date.parse(a.startTime ?? ''),
      );
    }
  }
  return [];
}

/** Transcripts attached to one conference record. */
export async function listTranscripts(
  ctx: ToolContext,
  conferenceRecordName: string,
): Promise<TranscriptRef[]> {
  const data = await meetGet<{ transcripts?: TranscriptRef[] }>(
    ctx,
    `${conferenceRecordName}/transcripts`,
  );
  return data.transcripts ?? [];
}

/** A finished transcript is the only one worth reading; fall back to any. */
export function pickTranscript(transcripts: TranscriptRef[]): TranscriptRef | null {
  return (
    transcripts.find((t) => t.state === 'ENDED' || t.state === 'FILE_GENERATED') ??
    transcripts[0] ??
    null
  );
}

/** Who was in the room, keyed by participant resource name for speaker labels. */
export async function listParticipants(
  ctx: ToolContext,
  conferenceRecordName: string,
): Promise<MeetParticipant[]> {
  const out: MeetParticipant[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 5; page++) {
    const qs = new URLSearchParams({ pageSize: '250' });
    if (pageToken) qs.set('pageToken', pageToken);
    const data = await meetGet<{
      participants?: Array<{
        name: string;
        signedinUser?: { displayName?: string };
        anonymousUser?: { displayName?: string };
        phoneUser?: { displayName?: string };
      }>;
      nextPageToken?: string;
    }>(ctx, `${conferenceRecordName}/participants?${qs.toString()}`);

    for (const p of data.participants ?? []) {
      out.push({
        name: p.name,
        displayName:
          p.signedinUser?.displayName ??
          p.anonymousUser?.displayName ??
          p.phoneUser?.displayName ??
          null,
      });
    }
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

export interface TranscriptText {
  text: string;
  truncated: boolean;
  totalChars: number;
  lineCount: number;
}

/**
 * Reconstruct the transcript as "Speaker: line" text, stopping once maxChars
 * is reached (the caller decides how much context it can afford).
 */
export async function fetchTranscriptText(
  ctx: ToolContext,
  opts: {
    transcriptName: string;
    speakers: Map<string, string>;
    maxChars: number;
    maxPages?: number;
  },
): Promise<TranscriptText> {
  const lines: string[] = [];
  let totalChars = 0;
  let truncated = false;
  let pageToken: string | undefined;

  for (let page = 0; page < (opts.maxPages ?? 50); page++) {
    const qs = new URLSearchParams({ pageSize: '1000' });
    if (pageToken) qs.set('pageToken', pageToken);
    const data = await meetGet<{
      transcriptEntries?: Array<{ participant?: string; text?: string }>;
      nextPageToken?: string;
    }>(ctx, `${opts.transcriptName}/entries?${qs.toString()}`);

    for (const entry of data.transcriptEntries ?? []) {
      if (!entry.text) continue;
      const speaker = entry.participant ? opts.speakers.get(entry.participant) : undefined;
      const line = speaker ? `${speaker}: ${entry.text}` : entry.text;
      totalChars += line.length + 1;
      if (totalChars > opts.maxChars) {
        truncated = true;
        continue;
      }
      lines.push(line);
    }
    pageToken = data.nextPageToken;
    if (!pageToken) break;
    if (truncated) break;
  }

  return { text: lines.join('\n'), truncated, totalChars, lineCount: lines.length };
}

/** The joinable code for a space, used to label a conference record. */
export async function fetchSpaceMeetingCode(
  ctx: ToolContext,
  spaceName: string,
): Promise<string | null> {
  try {
    const data = await meetGet<{ meetingCode?: string }>(ctx, spaceName);
    return data.meetingCode ?? null;
  } catch {
    return null;
  }
}

/** Minutes between the record's start and end, when both are present. */
export function recordDurationMinutes(record: ConferenceRecord): number | null {
  const s = record.startTime ? Date.parse(record.startTime) : Number.NaN;
  const e = record.endTime ? Date.parse(record.endTime) : Number.NaN;
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return null;
  return Math.round((e - s) / 60000);
}
