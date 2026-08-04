/**
 * Meeting classification — shared by `gcal.upcoming_meetings` and the
 * `meetings.*` family.
 *
 * The type decides what context a briefing gathers (candidate profile vs.
 * account history vs. nothing), so the rules are deliberately explicit and
 * ordered rather than a black-box score: every verdict carries the reasons
 * that produced it, and the caller can show them to a human who disagrees.
 *
 * Signals, in order of trust:
 *   1. Title keywords ("interview", "kickoff", "1:1", "dentist").
 *   2. Attendee domains — anyone outside the workspace's own email domains
 *      turns a meeting outward: either a candidate (personal mailbox) or a
 *      client.
 *   3. Description hints (ATS links, "resume", "candidate").
 *
 * Which domains are "ours" comes from `INTERNAL_EMAIL_DOMAINS`; see
 * `internalEmailDomains()` for why an unset list means nobody is internal.
 */

import { isInternalEmailDomain } from '@cortex/core';

export type MeetingType = 'interview' | 'client' | 'internal' | 'personal' | 'unknown';

/** Free mailbox providers — a candidate signal, since clients use their own domain. */
const PERSONAL_MAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'yahoo.com',
  'yahoo.com.mx',
  'yahoo.com.br',
  'icloud.com',
  'me.com',
  'protonmail.com',
  'proton.me',
  'aol.com',
  'zoho.com',
]);

const INTERVIEW_KEYWORDS = [
  'interview',
  'entrevista',
  'screening',
  'screen call',
  'phone screen',
  'tech screen',
  'technical screen',
  'candidate',
  'candidato',
  'candidata',
  'hiring',
  'culture fit',
  'panel',
  'take home review',
  'debrief',
  'shortlist review',
  'reference check',
];

const CLIENT_KEYWORDS = [
  'client',
  'cliente',
  'kickoff',
  'kick-off',
  'kick off',
  'discovery',
  'demo',
  'proposal',
  'propuesta',
  'quote',
  'sow',
  'contract',
  'renewal',
  'qbr',
  'business review',
  'intro call',
  'introductory',
  'sales',
  'onboarding call',
  'account review',
  'check-in with',
  'catch up with',
  'partnership',
  'prospect',
];

const INTERNAL_KEYWORDS = [
  '1:1',
  '1-1',
  'one on one',
  'one-on-one',
  'standup',
  'stand-up',
  'stand up',
  'daily',
  'retro',
  'retrospective',
  'sprint',
  'planning',
  'grooming',
  'refinement',
  'all hands',
  'all-hands',
  'town hall',
  'team sync',
  'weekly sync',
  'okr',
  'roadmap',
  'internal',
  'staff meeting',
  'leadership',
];

const PERSONAL_KEYWORDS = [
  'lunch',
  'almuerzo',
  'dentist',
  'dentista',
  'doctor',
  'medico',
  'médico',
  'gym',
  'holiday',
  'vacation',
  'vacaciones',
  'pto',
  'ooo',
  'out of office',
  'birthday',
  'cumpleaños',
  'personal',
  'focus time',
  'deep work',
  'block',
  'busy',
  'commute',
  'travel',
];

const CANDIDATE_DESCRIPTION_HINTS = [
  'workable',
  'greenhouse',
  'lever.co',
  'ashby',
  'resume',
  'résumé',
  'curriculum',
  'cv:',
  'candidate',
  'candidato',
  'applicant',
  'entrevista',
  'job application',
];

const CLIENT_DESCRIPTION_HINTS = [
  'hubspot',
  'deal',
  'proposal',
  'statement of work',
  'msa',
  'invoice',
  'account',
];

/** Domain part of an email address, lowercased. `null` when unparseable. */
export function emailDomain(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain.length > 0 ? domain : null;
}

/**
 * True when the address is outside the company (rooms and resources never
 * count). With no `INTERNAL_EMAIL_DOMAINS` configured every human attendee
 * reads as external, which pushes meetings toward the client/interview
 * branches. That is the deliberate trade: over-classifying a standup as a
 * client call costs a wrong briefing, while assuming an unknown domain is a
 * colleague would hide the outside guest the briefing exists to prepare for.
 */
export function isExternalEmail(email: string | null | undefined): boolean {
  const domain = emailDomain(email);
  if (!domain) return false;
  if (isInternalEmailDomain(domain)) return false;
  // Google Workspace rooms/equipment come through as calendar resources.
  if (domain.endsWith('resource.calendar.google.com')) return false;
  if (domain.endsWith('group.calendar.google.com')) return false;
  return true;
}

function matched(haystack: string, needles: string[]): string | null {
  for (const n of needles) {
    if (haystack.includes(n)) return n;
  }
  return null;
}

export interface MeetingClassifyInput {
  title?: string | null;
  description?: string | null;
  /** Attendee emails excluding the calendar owner. */
  attendeeEmails: string[];
  /** Whether the calendar event carried an attendee list at all. */
  hasAttendeeList: boolean;
  organizerEmail?: string | null;
}

export interface MeetingClassification {
  type: MeetingType;
  /** 0–1. How much the signals agree; shown to humans, never used as a gate. */
  confidence: number;
  reasons: string[];
  externalAttendees: string[];
  externalDomains: string[];
}

/**
 * Ordered cascade. Reads top to bottom: the first rule that fires wins, and
 * every rule records why. Adding a keyword should never silently reorder the
 * others.
 */
export function classifyMeeting(input: MeetingClassifyInput): MeetingClassification {
  const title = (input.title ?? '').toLowerCase();
  const description = (input.description ?? '').toLowerCase();
  const reasons: string[] = [];

  const externalAttendees = input.attendeeEmails.filter((e) => isExternalEmail(e));
  const externalDomains = [
    ...new Set(externalAttendees.map((e) => emailDomain(e)).filter((d): d is string => Boolean(d))),
  ];
  const hasExternal = externalAttendees.length > 0;
  const others = input.attendeeEmails.length;

  const finish = (type: MeetingType, confidence: number): MeetingClassification => ({
    type,
    confidence,
    reasons,
    externalAttendees,
    externalDomains,
  });

  // 1. An explicit interview title beats everything — it is unambiguous.
  const interviewHit = matched(title, INTERVIEW_KEYWORDS);
  if (interviewHit) {
    reasons.push(`The title mentions "${interviewHit}"`);
    if (hasExternal) reasons.push(`${externalAttendees.length} guest(s) from outside the company`);
    return finish('interview', hasExternal ? 0.92 : 0.72);
  }

  // 2. Someone from outside the company is in the room: candidate or client.
  if (hasExternal) {
    reasons.push(`Guest(s) from outside the company: ${externalDomains.join(', ')}`);

    const candidateHint = matched(description, CANDIDATE_DESCRIPTION_HINTS);
    if (candidateHint) {
      reasons.push(`The invitation text mentions "${candidateHint}"`);
      return finish('interview', 0.8);
    }

    const clientHit = matched(title, CLIENT_KEYWORDS);
    if (clientHit) {
      reasons.push(`The title mentions "${clientHit}"`);
      return finish('client', 0.9);
    }

    const clientHint = matched(description, CLIENT_DESCRIPTION_HINTS);
    if (clientHint) {
      reasons.push(`The invitation text mentions "${clientHint}"`);
      return finish('client', 0.75);
    }

    // Personal mailboxes point at a person, not a company.
    const allPersonalMail =
      externalDomains.length > 0 && externalDomains.every((d) => PERSONAL_MAIL_DOMAINS.has(d));
    if (allPersonalMail) {
      reasons.push('The outside guest uses a personal email address, which usually means a candidate');
      return finish('interview', 0.6);
    }

    reasons.push('Outside guests on a company domain, so this is treated as a client conversation');
    return finish('client', 0.65);
  }

  // 3. Everyone is internal (or the invite is solo).
  const personalHit = matched(title, PERSONAL_KEYWORDS);
  if (others === 0) {
    if (!input.hasAttendeeList && !personalHit) {
      reasons.push('No guest list and no clear topic — not enough to tell what this is');
      return finish('unknown', 0.3);
    }
    reasons.push(
      personalHit
        ? `A solo entry whose title mentions "${personalHit}"`
        : 'A solo calendar entry with no other guests',
    );
    return finish('personal', personalHit ? 0.85 : 0.55);
  }

  const internalHit = matched(title, INTERNAL_KEYWORDS);
  if (internalHit) {
    reasons.push(`The title mentions "${internalHit}" and everyone invited is a colleague`);
    return finish('internal', 0.88);
  }

  const clientHit = matched(title, CLIENT_KEYWORDS);
  if (clientHit) {
    reasons.push(
      `The title mentions "${clientHit}" but everyone invited is a colleague — an internal conversation about a client`,
    );
    return finish('internal', 0.6);
  }

  reasons.push(`Everyone invited (${others}) is a colleague`);
  return finish('internal', 0.7);
}

/** Human label for the type, for briefings and summaries. */
export function meetingTypeLabel(type: MeetingType): string {
  switch (type) {
    case 'interview':
      return 'Interview';
    case 'client':
      return 'Client conversation';
    case 'internal':
      return 'Internal meeting';
    case 'personal':
      return 'Personal time';
    default:
      return 'Unclassified';
  }
}
