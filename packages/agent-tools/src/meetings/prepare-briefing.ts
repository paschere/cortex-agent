import { z } from 'zod';
import { getTool, registerTool, runTool } from '../index';
import type { AnyTool, ToolContext } from '../types';
import { meetingTypeLabel, type MeetingType } from '../gcal/classify';
import {
  fetchCalendarTimeZone,
  fetchEvent,
  fetchEventsInRange,
  normalizeEvent,
  type NormalizedMeeting,
} from '../gcal/events';
import { MEET_READONLY_SCOPE } from './client';
import { meetingsListTranscripts } from './list-transcripts';

/**
 * `meetings.prepare_briefing` — walk into the meeting already knowing things.
 *
 * One call turns a calendar entry into a ready-to-send briefing. What it
 * gathers depends on what kind of conversation it is:
 *   interview → the candidate's file: stage, role applied to, profile facts
 *   client    → the account: company, open deals, recent activity
 *   internal  → no CRM/ATS noise, just the agenda and the last transcript
 * and, for every type, the Knowledge Base plus the transcript of the last call
 * with the same people.
 *
 * Two rules make the output trustworthy:
 *   1. Every claim carries a numbered source with a freshness stamp.
 *   2. A lookup that found nothing says so — it is listed in `gaps` and in the
 *      email footer, never quietly padded with plausible-sounding filler.
 *
 * Resilience: each lookup runs inside `attempt`, so a HubSpot outage costs the
 * client section and nothing else.
 */

const TYPES = ['interview', 'client', 'internal', 'personal', 'unknown'] as const;

const SectionSchema = z.object({
  key: z.string(),
  title: z.string(),
  body: z.string(),
  sourceRefs: z.array(z.number().int()),
});

const SourceSchema = z.object({
  ref: z.number().int(),
  label: z.string(),
  detail: z.string(),
  freshness: z.string(),
});

interface SourceEntry {
  ref: number;
  label: string;
  detail: string;
  freshness: string;
}

/** Collects numbered sources so every section can point at where it came from. */
class Sources {
  private items: SourceEntry[] = [];
  add(label: string, detail: string, freshness: string): number {
    const ref = this.items.length + 1;
    this.items.push({ ref, label, detail, freshness });
    return ref;
  }
  all(): SourceEntry[] {
    return this.items;
  }
}

/** "3 days ago" / "today" — how old a fact is, in words. */
function freshnessOf(iso: string | null | undefined, fallback = 'checked just now'): string {
  if (!iso) return fallback;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return fallback;
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30);
  return months <= 1 ? 'about a month ago' : `about ${months} months ago`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Very small markdown → HTML: bold, line breaks, bullet lists. */
function inlineHtml(s: string): string {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
}

function bodyHtml(body: string): string {
  const lines = body.split('\n');
  const out: string[] = [];
  let inList = false;
  for (const line of lines) {
    const bullet = line.match(/^\s*[-•]\s+(.*)$/);
    if (bullet) {
      if (!inList) {
        out.push('<ul style="margin:6px 0 10px;padding-left:20px;">');
        inList = true;
      }
      out.push(
        `<li style="margin:0 0 4px;">${inlineHtml(bullet[1] ?? '').replace(/<br>/g, ' ')}</li>`,
      );
      continue;
    }
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
    if (line.trim()) out.push(`<p style="margin:0 0 10px;">${inlineHtml(line)}</p>`);
  }
  if (inList) out.push('</ul>');
  return out.join('');
}

interface Attempted<T> {
  ok: boolean;
  value: T | null;
  error: string | null;
}

/**
 * Run one context lookup in isolation. A failure becomes a recorded gap, never
 * an exception that takes the whole briefing down with it.
 */
async function attempt<T>(
  ctx: ToolContext,
  gaps: string[],
  what: string,
  fn: () => Promise<T>,
  opts: { silent?: boolean } = {},
): Promise<Attempted<T>> {
  try {
    return { ok: true, value: await fn(), error: null };
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    ctx.logger.warn({ err: message, what }, 'meetings.prepare_briefing: lookup failed');
    if (!opts.silent) gaps.push(`${what} could not be checked this time.`);
    return { ok: false, value: null, error: message };
  }
}

/** runTool against a registry id, so the audit trail and gates still apply. */
async function call<T>(id: string, input: unknown, ctx: ToolContext): Promise<T> {
  const tool = getTool(id);
  if (!tool) throw new Error(`${id} is not available`);
  return (await runTool(tool as AnyTool, input, ctx)) as T;
}

/** Locate the meeting: by id, or by title/time when that is all we have. */
async function resolveMeeting(
  ctx: ToolContext,
  input: {
    eventId?: string;
    title?: string;
    startTime?: string;
    calendarId?: string;
  },
): Promise<{ meeting: NormalizedMeeting; timeZone: string } | null> {
  const calendarId = input.calendarId ?? 'primary';
  const timeZone = await fetchCalendarTimeZone(ctx, calendarId);

  if (input.eventId) {
    const raw = await fetchEvent(ctx, calendarId, input.eventId);
    if (!raw) return null;
    return { meeting: normalizeEvent(raw, timeZone), timeZone };
  }

  const anchor = input.startTime ? Date.parse(input.startTime) : Date.now();
  const base = Number.isFinite(anchor) ? anchor : Date.now();
  const timeMin = new Date(base - (input.startTime ? 2 : 0) * 86_400_000).toISOString();
  const timeMax = new Date(base + (input.startTime ? 2 : 14) * 86_400_000).toISOString();

  const events = await fetchEventsInRange(ctx, {
    calendarId,
    timeMin,
    timeMax,
    maxResults: 100,
    ...(input.title ? { q: input.title } : {}),
  });
  const candidates = events
    .filter((e) => e.status !== 'cancelled')
    .map((e) => normalizeEvent(e, timeZone));
  if (candidates.length === 0) return null;

  const needle = input.title?.toLowerCase() ?? '';
  const scored = candidates
    .map((m) => {
      const titleScore = needle && m.title.toLowerCase().includes(needle) ? 0 : 1;
      const timeScore = Math.abs(Date.parse(m.start) - base);
      return { m, titleScore, timeScore };
    })
    .sort((a, b) => a.titleScore - b.titleScore || a.timeScore - b.timeScore);

  const best = scored[0];
  return best ? { meeting: best.m, timeZone } : null;
}

export const meetingsPrepareBriefing = registerTool({
  id: 'meetings.prepare_briefing',
  description:
    "Prepare everything the user needs to walk into a meeting well-informed, tailored to what kind of meeting it is. For an interview it pulls the candidate's file — where they are in the process, which role they applied to, the highlights of their profile. For a client call it pulls the account — the company, open deals and what happened recently. For internal meetings it sticks to the agenda and the last conversation. In every case it adds what the company's Knowledge Base knows about the topic and the transcript of the previous call with the same people. Give it the calendar entry (or just the meeting title and time) and it returns the briefing as text and as a ready-to-send email, with a short list of suggested talking points and a footnote saying where each fact came from and how fresh it is. Anything it could not find is stated plainly rather than guessed.",
  inputSchema: z
    .object({
      eventId: z.string().optional().describe('Calendar entry id for the meeting'),
      title: z.string().optional().describe('Meeting title, when the calendar id is unknown'),
      startTime: z
        .string()
        .optional()
        .describe('Roughly when the meeting starts (ISO), to disambiguate by title'),
      calendarId: z.string().default('primary'),
      includeTranscript: z
        .boolean()
        .default(true)
        .describe('Attach an excerpt of the last recorded call with the same people'),
      transcriptLookbackDays: z.number().int().min(1).max(60).default(30),
    })
    .refine((v) => Boolean(v.eventId || v.title), {
      message: 'Provide the calendar entry id or the meeting title',
    }),
  outputSchema: z.object({
    event: z.object({
      id: z.string(),
      title: z.string(),
      start: z.string(),
      end: z.string(),
      startHuman: z.string(),
      endHuman: z.string(),
      timeZone: z.string(),
      durationMinutes: z.number(),
      organizer: z.object({
        email: z.string().nullable(),
        name: z.string().nullable(),
      }),
      attendees: z.array(
        z.object({
          email: z.string(),
          name: z.string().nullable(),
          external: z.boolean(),
        }),
      ),
      conferenceLink: z.string().nullable(),
      meetCode: z.string().nullable(),
      htmlLink: z.string().nullable(),
    }),
    type: z.enum(TYPES),
    typeLabel: z.string(),
    typeConfidence: z.number(),
    typeReasons: z.array(z.string()),
    whyThisMatters: z.string(),
    sections: z.array(SectionSchema),
    sources: z.array(SourceSchema),
    talkingPoints: z.array(z.string()),
    gaps: z.array(z.string()),
    subject: z.string(),
    markdown: z.string(),
    emailHtml: z.string(),
    preparedAt: z.string(),
  }),
  requiredScopes: [
    {
      provider: 'google',
      scopes: ['https://www.googleapis.com/auth/calendar.readonly', MEET_READONLY_SCOPE],
    },
  ],
  rateLimit: { perMinute: 6 },
  handler: async (input, ctx) => {
    const preparedAt = new Date().toISOString();
    const resolved = await resolveMeeting(ctx, {
      ...(input.eventId ? { eventId: input.eventId } : {}),
      ...(input.title ? { title: input.title } : {}),
      ...(input.startTime ? { startTime: input.startTime } : {}),
      calendarId: input.calendarId ?? 'primary',
    });
    if (!resolved) {
      throw new Error(
        input.eventId
          ? 'That meeting is not on the calendar.'
          : `No meeting matching "${input.title}" was found on the calendar.`,
      );
    }

    const m = resolved.meeting;
    const type: MeetingType = m.guessedType;
    const sources = new Sources();
    const gaps: string[] = [];
    const sections: Array<z.infer<typeof SectionSchema>> = [];
    const talkingPoints: string[] = [];

    const guests = m.attendees.filter((a) => !a.self);
    const externals = guests.filter((a) => a.external);
    const primaryExternal = externals[0] ?? null;

    // ---- Section: the meeting itself (always) -----------------------------
    const calendarRef = sources.add(
      'Google Calendar',
      `Invitation for "${m.title}"`,
      'checked just now',
    );
    sections.push({
      key: 'meeting',
      title: 'The meeting',
      body: [
        `**When:** ${m.startHuman} – ${m.endHuman} (${m.durationMinutes} min, ${m.timeZone})`,
        `**Who:** ${
          guests.length
            ? guests.map((a) => `${a.name ?? a.email}${a.external ? ' — external' : ''}`).join(', ')
            : 'no other guests on the invitation'
        }`,
        m.organizer.email ? `**Organizer:** ${m.organizer.name ?? m.organizer.email}` : '',
        m.conferenceLink
          ? `**Join:** ${m.conferenceLink}`
          : m.location
            ? `**Where:** ${m.location}`
            : '',
        m.description ? `**From the invitation:** ${m.description}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      sourceRefs: [calendarRef],
    });

    // ---- Interview: the candidate ----------------------------------------
    if (type === 'interview') {
      const lookupKey = primaryExternal?.email ?? primaryExternal?.name ?? null;
      if (!lookupKey) {
        gaps.push(
          'No outside guest is listed on the invitation, so the candidate could not be looked up.',
        );
      } else {
        const search = await attempt(ctx, gaps, "The candidate's record in Workable", async () =>
          call<{ candidates: Array<Record<string, unknown>> }>(
            'workable.search_candidates',
            primaryExternal?.email
              ? { email: primaryExternal.email, limit: 5 }
              : { name: lookupKey, limit: 5 },
            ctx,
          ),
        );

        const hits = (search.value?.candidates ?? []) as Array<{
          id: string;
          name: string;
          stage: string | null;
          jobTitle: string | null;
          jobShortcode: string | null;
          email: string | null;
          updatedAt: string | null;
          disqualified: boolean;
          profileUrl: string | null;
        }>;

        if (search.ok && hits.length === 0) {
          gaps.push(
            `No candidate record was found for ${lookupKey}. Treat this as a first conversation unless the user knows otherwise.`,
          );
        }

        const top = hits[0];
        if (top) {
          const ref = sources.add(
            'Workable (applicant tracking)',
            `Candidate file for ${top.name}`,
            freshnessOf(top.updatedAt, 'last updated at an unknown date'),
          );

          // Fuller profile for the top match; best-effort enrichment.
          const detail = await attempt(
            ctx,
            gaps,
            "The candidate's full profile",
            async () =>
              call<{
                candidate: {
                  summary: string | null;
                  coverLetter: string | null;
                  source: string | null;
                  phone: string | null;
                };
              }>('workable.get_candidate', { candidateId: top.id }, ctx),
            { silent: true },
          );

          // The matcher may hold a richer scored profile under the same id.
          const scored = await attempt(
            ctx,
            gaps,
            'Scoring history',
            async () =>
              call<{ markdown: string }>('recruit.get_candidate', { candidateId: top.id }, ctx),
            { silent: true },
          );

          const otherApps = hits
            .slice(1)
            .map((h) => `${h.jobTitle ?? 'another role'} (${h.stage ?? 'stage unknown'})`)
            .slice(0, 4);

          const body = [
            `**${top.name}**${top.email ? ` · ${top.email}` : ''}`,
            `**Applied to:** ${top.jobTitle ?? 'role not recorded'}`,
            `**Current stage:** ${top.stage ?? 'not recorded'}${top.disqualified ? ' (marked disqualified)' : ''}`,
            top.updatedAt ? `**Last movement:** ${freshnessOf(top.updatedAt)}` : '',
            detail.value?.candidate.source
              ? `**Came in via:** ${detail.value.candidate.source}`
              : '',
            detail.value?.candidate.summary
              ? `**Profile:** ${detail.value.candidate.summary.slice(0, 600)}`
              : '',
            detail.value?.candidate.coverLetter
              ? `**In their own words:** ${detail.value.candidate.coverLetter.slice(0, 400)}…`
              : '',
            otherApps.length ? `**Also seen on:** ${otherApps.join('; ')}` : '',
            top.profileUrl ? `**Full file:** ${top.profileUrl}` : '',
          ]
            .filter(Boolean)
            .join('\n');

          const refs = [ref];
          if (scored.ok && scored.value?.markdown) {
            refs.push(
              sources.add(
                'Cortex talent matching',
                `Scoring and history for ${top.name}`,
                'checked just now',
              ),
            );
          }

          sections.push({
            key: 'candidate',
            title: 'The candidate',
            body,
            sourceRefs: refs,
          });

          talkingPoints.push(
            `Confirm where ${top.name.split(' ')[0] ?? top.name} stands on ${top.jobTitle ?? 'the role'} — the file says "${top.stage ?? 'stage not recorded'}".`,
          );
          if (!detail.value?.candidate.summary) {
            talkingPoints.push(
              'Their profile summary is thin in the system — ask about recent work and fill it in afterwards.',
            );
          }

          // The role they applied to, when it can be resolved.
          if (top.jobShortcode) {
            const job = await attempt(
              ctx,
              gaps,
              'The role they applied to',
              async () =>
                call<{
                  job: {
                    title: string;
                    state: string | null;
                    department: string | null;
                  };
                }>('workable.get_job', { shortcode: top.jobShortcode }, ctx),
              { silent: true },
            );
            if (job.value?.job) {
              const jobRef = sources.add(
                'Workable (job posting)',
                `Requisition "${job.value.job.title}"`,
                'checked just now',
              );
              sections.push({
                key: 'role',
                title: 'The role',
                body: [
                  `**${job.value.job.title}**`,
                  job.value.job.department ? `**Team:** ${job.value.job.department}` : '',
                  job.value.job.state ? `**Status:** ${job.value.job.state}` : '',
                ]
                  .filter(Boolean)
                  .join('\n'),
                sourceRefs: [jobRef],
              });
            }
          }
        }
      }
    }

    // ---- Client: the account ---------------------------------------------
    if (type === 'client') {
      const domain = m.externalDomains[0] ?? null;
      if (!domain) {
        gaps.push('No outside guest is listed, so the account could not be identified.');
      } else {
        const search = await attempt(ctx, gaps, 'The company record in HubSpot', async () =>
          call<{
            results: Array<{
              id: string;
              name: string | null;
              domain: string | null;
            }>;
          }>('hubspot.search_companies', { query: domain, limit: 3 }, ctx),
        );
        const company = search.value?.results?.[0] ?? null;

        if (search.ok && !company) {
          gaps.push(
            `${domain} is not in HubSpot. This may be a brand-new account — worth creating a record after the call.`,
          );
        }

        if (company) {
          const full = await attempt(ctx, gaps, 'The account detail and open deals', async () =>
            call<{
              name: string | null;
              domain: string | null;
              industry: string | null;
              country: string | null;
              numEmployees: number | null;
              recentDeals: Array<{
                name: string | null;
                amount: number | null;
                stage: string | null;
                closeDate: string | null;
              }>;
            }>('hubspot.get_company', { id: company.id }, ctx),
          );

          const c = full.value;
          const companyRef = sources.add(
            'HubSpot (CRM)',
            `Account record for ${c?.name ?? company.name ?? domain}`,
            'checked just now',
          );
          const deals = c?.recentDeals ?? [];
          sections.push({
            key: 'account',
            title: 'The account',
            body: [
              `**${c?.name ?? company.name ?? domain}**${c?.domain ? ` · ${c.domain}` : ''}`,
              c?.industry ? `**Industry:** ${c.industry}` : '',
              c?.country ? `**Country:** ${c.country}` : '',
              c?.numEmployees != null
                ? `**Size:** ${c.numEmployees.toLocaleString()} employees`
                : '',
              deals.length
                ? `**Open deals:**\n${deals
                    .map(
                      (d) =>
                        `- ${d.name ?? 'unnamed deal'} — ${
                          d.amount != null ? `$${d.amount.toLocaleString()}` : 'amount not set'
                        }, ${d.stage ?? 'stage not set'}${d.closeDate ? `, closing ${d.closeDate}` : ''}`,
                    )
                    .join('\n')}`
                : '**Open deals:** none recorded in HubSpot.',
            ]
              .filter(Boolean)
              .join('\n'),
            sourceRefs: [companyRef],
          });

          if (deals.length) {
            const lead = deals[0];
            talkingPoints.push(
              `Move "${lead?.name ?? 'the open deal'}" forward — it sits at ${lead?.stage ?? 'an unrecorded stage'}.`,
            );
          } else {
            talkingPoints.push(
              'No open deal is recorded for this account — find out what they need next and log it.',
            );
          }
        }

        // The person, and what has happened with them lately.
        if (primaryExternal?.email) {
          const contact = await attempt(ctx, gaps, 'The contact record', async () =>
            call<{
              results: Array<{
                id: string;
                firstName: string | null;
                lastName: string | null;
                jobTitle: string | null;
                lastContacted: string | null;
              }>;
            }>('hubspot.search_contacts', { query: primaryExternal.email, limit: 1 }, ctx),
          );
          const person = contact.value?.results?.[0] ?? null;

          if (contact.ok && !person) {
            gaps.push(`${primaryExternal.email} is not a HubSpot contact yet.`);
          }

          if (person) {
            const timeline = await attempt(
              ctx,
              gaps,
              'Recent activity with this contact',
              async () =>
                call<{
                  results: Array<{
                    type: string;
                    subject: string | null;
                    createdAt: string | null;
                  }>;
                }>(
                  'hubspot.get_contact_timeline',
                  { contactId: person.id, days: 90, limit: 10 },
                  ctx,
                ),
            );
            const events = timeline.value?.results ?? [];
            const newest = events[0]?.createdAt ?? person.lastContacted ?? null;
            const ref = sources.add(
              'HubSpot (contact history)',
              `Last 90 days with ${[person.firstName, person.lastName].filter(Boolean).join(' ') || primaryExternal.email}`,
              freshnessOf(newest, 'no dated activity on record'),
            );
            sections.push({
              key: 'history',
              title: 'Where we left off',
              body: events.length
                ? [
                    person.jobTitle ? `**Their role:** ${person.jobTitle}` : '',
                    ...events
                      .slice(0, 6)
                      .map(
                        (e) =>
                          `- ${e.type}${e.subject ? `: ${e.subject}` : ''}${
                            e.createdAt ? ` (${freshnessOf(e.createdAt)})` : ''
                          }`,
                      ),
                  ]
                    .filter(Boolean)
                    .join('\n')
                : 'Nothing has been logged with this contact in the last 90 days. Whatever happened lives outside the CRM — worth asking directly.',
              sourceRefs: [ref],
            });
            if (!events.length) {
              talkingPoints.push(
                'Nothing logged in the last 90 days — open by asking what has changed on their side.',
              );
            }
          }
        }
      }
    }

    // ---- Knowledge Base (always) -----------------------------------------
    const topicParts = [m.title, ...m.externalDomains].filter(Boolean);
    const kb = await attempt(ctx, gaps, "the company's Knowledge Base", async () =>
      call<{
        sources: Array<{
          ref: number;
          documentTitle: string;
          excerpts: string[];
        }>;
        contextBlock: string;
      }>(
        'kb.context',
        {
          topic: topicParts.join(' ').slice(0, 380) || m.title,
          angles:
            type === 'client'
              ? ['account history', 'pricing and rates']
              : type === 'interview'
                ? ['hiring process', 'role requirements']
                : [],
          perQueryLimit: 4,
          maxExcerptChars: 500,
        },
        ctx,
      ),
    );
    const kbSources = kb.value?.sources ?? [];
    if (kbSources.length) {
      const ref = sources.add(
        'Cortex Knowledge Base',
        `${kbSources.length} document(s) on "${m.title}"`,
        'checked just now',
      );
      sections.push({
        key: 'knowledge',
        title: 'What the company already knows',
        body: kbSources
          .slice(0, 4)
          .map(
            (s) =>
              `- **${s.documentTitle}** — ${(s.excerpts[0] ?? '').replace(/\s+/g, ' ').slice(0, 320)}…`,
          )
          .join('\n'),
        sourceRefs: [ref],
      });
    } else if (kb.ok) {
      gaps.push('The Knowledge Base has nothing on this topic.');
    }

    // ---- Last conversation with the same people (always) ------------------
    if (input.includeTranscript !== false) {
      const needle = primaryExternal?.email ?? guests[0]?.email ?? undefined;
      const transcripts = await attempt(
        ctx,
        gaps,
        'The transcript of the previous call',
        async () =>
          runTool(
            meetingsListTranscripts,
            {
              days: input.transcriptLookbackDays ?? 30,
              limit: 3,
              excerptChars: 900,
              ...(needle ? { attendee: needle } : {}),
            },
            ctx,
          ),
      );
      const last = transcripts.value?.meetings?.[0];
      if (last) {
        const ref = sources.add(
          'Google Meet (transcript)',
          `"${last.title ?? 'previous call'}"`,
          freshnessOf(last.startedAt),
        );
        sections.push({
          key: 'last-call',
          title: 'Last time you spoke',
          body: [
            `**${last.title ?? 'Previous call'}** — ${freshnessOf(last.startedAt)}${
              last.durationMinutes != null ? `, ${last.durationMinutes} min` : ''
            }`,
            last.participants.length ? `**Who was there:** ${last.participants.join(', ')}` : '',
            '',
            last.excerpt.replace(/\n/g, '\n'),
          ]
            .filter(Boolean)
            .join('\n'),
          sourceRefs: [ref],
        });
        talkingPoints.push('Pick up the thread from the last call before opening anything new.');
      } else if (transcripts.ok) {
        gaps.push(
          'No recorded call with these people in the lookback window — either it was never transcribed or this is the first conversation.',
        );
      }
    }

    // ---- Talking points ---------------------------------------------------
    if (type === 'interview') {
      talkingPoints.push(
        'Ask for one concrete example of shipped work, with their specific contribution.',
        'Confirm availability, notice period and expected rate before ending the call.',
      );
    } else if (type === 'client') {
      talkingPoints.push(
        'Ask what changed on their side since the last conversation.',
        'Close with one agreed next step, an owner and a date.',
      );
    } else if (type === 'internal') {
      talkingPoints.push(
        'Open with the decision this meeting needs to produce.',
        'Leave with owners and dates, not just discussion.',
      );
    } else {
      talkingPoints.push(
        'Confirm the purpose of the meeting at the top so the time is well spent.',
      );
    }
    if (gaps.length) {
      talkingPoints.push(
        'Some background is missing (see the notes at the end) — ask rather than assume.',
      );
    }

    // ---- Why this matters --------------------------------------------------
    const whyThisMatters =
      type === 'interview'
        ? `This is an interview${primaryExternal ? ` with ${primaryExternal.name ?? primaryExternal.email}` : ''}. Everything below is what the company already knows about them, so the call can go straight to what is not on paper.`
        : type === 'client'
          ? `This is a client conversation${m.externalDomains[0] ? ` with ${m.externalDomains[0]}` : ''}. The account context below is what they will expect you to remember.`
          : type === 'internal'
            ? 'An internal meeting. The agenda and the last conversation are below so the time goes to decisions, not recaps.'
            : 'The purpose of this meeting is not obvious from the invitation, so here is everything that could be found about it.';

    // ---- Render ------------------------------------------------------------
    const subject = `Briefing: ${m.title} — ${m.startHuman}`;
    const sourceList = sources.all();

    const markdown = [
      `# ${m.title}`,
      `${m.startHuman} – ${m.endHuman} · ${m.durationMinutes} min · ${meetingTypeLabel(type)}`,
      '',
      `**Why this matters:** ${whyThisMatters}`,
      '',
      ...sections.flatMap((s) => [
        `## ${s.title}`,
        s.body,
        s.sourceRefs.length ? `_Source: ${s.sourceRefs.map((r) => `[${r}]`).join(' ')}_` : '',
        '',
      ]),
      '## Suggested talking points',
      ...talkingPoints.map((t) => `- ${t}`),
      '',
      ...(gaps.length ? ['## What could not be found', ...gaps.map((g) => `- ${g}`), ''] : []),
      '## Sources',
      ...sourceList.map((s) => `[${s.ref}] ${s.label} — ${s.detail} · ${s.freshness}`),
    ]
      .filter((l) => l !== undefined)
      .join('\n');

    const emailHtml = [
      '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1f2328;max-width:640px;margin:0 auto;padding:24px;">',
      `<p style="margin:0 0 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;">${escapeHtml(meetingTypeLabel(type))}</p>`,
      `<h1 style="margin:0 0 4px;font-size:22px;line-height:1.3;color:#111827;">${escapeHtml(m.title)}</h1>`,
      `<p style="margin:0 0 18px;color:#6b7280;font-size:14px;">${escapeHtml(`${m.startHuman} – ${m.endHuman} · ${m.durationMinutes} min · ${m.timeZone}`)}</p>`,
      `<p style="margin:0 0 20px;padding:12px 14px;background:#f3f4f6;border-left:3px solid #2563eb;border-radius:4px;"><strong>Why this matters:</strong> ${escapeHtml(whyThisMatters)}</p>`,
      ...sections.map((s) =>
        [
          `<h2 style="margin:22px 0 8px;font-size:15px;text-transform:uppercase;letter-spacing:.05em;color:#374151;">${escapeHtml(s.title)}</h2>`,
          bodyHtml(s.body),
          s.sourceRefs.length
            ? `<p style="margin:-4px 0 0;font-size:12px;color:#9ca3af;">Source: ${s.sourceRefs.map((r) => `[${r}]`).join(' ')}</p>`
            : '',
        ].join(''),
      ),
      '<h2 style="margin:24px 0 8px;font-size:15px;text-transform:uppercase;letter-spacing:.05em;color:#374151;">Suggested talking points</h2>',
      `<ul style="margin:6px 0 10px;padding-left:20px;">${talkingPoints
        .map((t) => `<li style="margin:0 0 6px;">${escapeHtml(t)}</li>`)
        .join('')}</ul>`,
      gaps.length
        ? `<h2 style="margin:24px 0 8px;font-size:15px;text-transform:uppercase;letter-spacing:.05em;color:#b45309;">What could not be found</h2><ul style="margin:6px 0 10px;padding-left:20px;color:#92400e;">${gaps
            .map((g) => `<li style="margin:0 0 6px;">${escapeHtml(g)}</li>`)
            .join('')}</ul>`
        : '',
      '<hr style="border:0;border-top:1px solid #e5e7eb;margin:26px 0 12px;">',
      '<p style="margin:0 0 6px;font-size:12px;letter-spacing:.05em;text-transform:uppercase;color:#6b7280;">Sources</p>',
      `<ol style="margin:0;padding-left:18px;font-size:12px;color:#6b7280;">${sourceList
        .map(
          (s) =>
            `<li style="margin:0 0 4px;"><strong>${escapeHtml(s.label)}</strong> — ${escapeHtml(s.detail)} · ${escapeHtml(s.freshness)}</li>`,
        )
        .join('')}</ol>`,
      `<p style="margin:14px 0 0;font-size:11px;color:#9ca3af;">Prepared by Cortex${m.htmlLink ? ` · <a href="${escapeHtml(m.htmlLink)}" style="color:#2563eb;">open the invitation</a>` : ''}</p>`,
      '</div>',
    ]
      .filter(Boolean)
      .join('');

    return {
      event: {
        id: m.id,
        title: m.title,
        start: m.start,
        end: m.end,
        startHuman: m.startHuman,
        endHuman: m.endHuman,
        timeZone: m.timeZone,
        durationMinutes: m.durationMinutes,
        organizer: m.organizer,
        attendees: guests.map((a) => ({
          email: a.email,
          name: a.name,
          external: a.external,
        })),
        conferenceLink: m.conferenceLink,
        meetCode: m.meetCode,
        htmlLink: m.htmlLink,
      },
      type,
      typeLabel: meetingTypeLabel(type),
      typeConfidence: m.typeConfidence,
      typeReasons: m.typeReasons,
      whyThisMatters,
      sections,
      sources: sourceList,
      talkingPoints,
      gaps,
      subject,
      markdown,
      emailHtml,
      preparedAt,
    };
  },
});
