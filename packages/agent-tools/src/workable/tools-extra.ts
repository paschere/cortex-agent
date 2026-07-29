import { z } from 'zod';
import { registerTool } from '../index';
import { workableFetch } from './client';

/**
 * Extended Workable tools (SPI v3) for evaluation-style questions:
 * "summarize the state of req X", "what happened in recruiting this week",
 * "which jobs has this person applied to". Read-only; they complement the
 * primitives in ./tools.ts and follow zipdev-matcher's proven access
 * patterns (candidates listed via ?shortcode=, `paging.next` pagination,
 * questions from /jobs/{shortcode}/questions).
 *
 * Note: workable.get_candidate_offer was intentionally NOT added — the
 * matcher never consumes /candidates/{id}/offer, so there is no known-good
 * response shape to mirror and no product flow that needs it.
 */

const CandidateHit = z.object({
  id: z.string(),
  name: z.string(),
  stage: z.string().nullable(),
  jobShortcode: z.string().nullable(),
  jobTitle: z.string().nullable(),
  email: z.string().nullable(),
  updatedAt: z.string().nullable(),
  disqualified: z.boolean(),
  profileUrl: z.string().nullable(),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toCandidateHit(c: any): z.infer<typeof CandidateHit> {
  return {
    id: String(c.id ?? ''),
    name: c.name ?? [c.firstname, c.lastname].filter(Boolean).join(' '),
    stage: c.stage ?? null,
    jobShortcode: c.job?.shortcode ?? null,
    jobTitle: c.job?.title ?? null,
    email: c.email ?? null,
    updatedAt: c.updated_at ?? null,
    disqualified: Boolean(c.disqualified),
    profileUrl: c.profile_url ?? null,
  };
}

/**
 * Workable paginates with a full `paging.next` URL. Convert it back to a
 * path relative to /spi/v3 so it can be replayed through workableFetch.
 */
export function nextPagePath(nextUrl: string | undefined | null): string | null {
  if (!nextUrl) return null;
  const marker = '/spi/v3';
  const i = nextUrl.indexOf(marker);
  return i >= 0 ? nextUrl.slice(i + marker.length) : null;
}

/** Fetch /candidates pages following paging.next, capped at maxPages. */
export async function fetchCandidatePages(
  firstPath: string,
  maxPages: number,
  signal?: AbortSignal,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all: any[] = [];
  let path: string | null = firstPath;
  let pages = 0;
  while (path && pages < maxPages) {
    pages++;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: { candidates?: any[]; paging?: { next?: string } } = await workableFetch(path, {
      signal,
    });
    all.push(...(data.candidates ?? []));
    path = nextPagePath(data.paging?.next);
  }
  return all;
}

export const workableSearchCandidates = registerTool({
  id: 'workable.search_candidates',
  description:
    'Find candidates across ALL Workable jobs by email and/or name. Use when someone asks "have we seen this person before?", "which roles did Jane apply to?", or to locate a candidate id when only a name/email is known. Returns each match with current stage, job, and last-activity date. Email matching is exact (server-side); name matching scans recent candidates (up to 3 pages) and filters, so very old candidates may not appear — prefer email when available.',
  inputSchema: z
    .object({
      email: z.string().email().optional().describe('Exact candidate email'),
      name: z.string().min(2).optional().describe('Full or partial candidate name'),
      limit: z.number().int().min(1).max(50).default(20),
    })
    .refine((v) => Boolean(v.email || v.name), {
      message: 'Provide email and/or name',
    }),
  outputSchema: z.object({ candidates: z.array(CandidateHit), truncated: z.boolean() }),
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const limit = input.limit ?? 20;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let raw: any[];
    if (input.email) {
      // Server-side exact-email lookup — single call, no pagination needed.
      const params = new URLSearchParams({ email: input.email, limit: '100' });
      raw = await fetchCandidatePages(`/candidates?${params}`, 1, ctx.signal);
    } else {
      // No name param in SPI v3 (the matcher also filters client-side after
      // paging /candidates) — scan up to 3 pages and match locally.
      raw = await fetchCandidatePages('/candidates?limit=100', 3, ctx.signal);
    }
    if (input.name) {
      const needle = input.name.toLowerCase();
      raw = raw.filter((c) => {
        const name = (c.name ?? [c.firstname, c.lastname].filter(Boolean).join(' ')) as string;
        return name.toLowerCase().includes(needle);
      });
    }
    return {
      candidates: raw.slice(0, limit).map(toCandidateHit),
      truncated: raw.length > limit,
    };
  },
});

const StageSummary = z.object({
  stage: z.string(),
  count: z.number(),
  disqualified: z.number(),
  lastActivityAt: z.string().nullable(),
  recentCandidates: z.array(z.string()),
});

export const workableJobCandidatesSummary = registerTool({
  id: 'workable.job_candidates_summary',
  description:
    'One-call pipeline snapshot for a Workable job (req) by shortcode: candidates grouped per stage with counts, disqualification counts, the newest activity date per stage, and the most recently active names. Best first tool for "summarize the state of req X", "how is hiring going for this role", or "where are candidates getting stuck". Returns a structured object plus a ready-to-show markdown table.',
  inputSchema: z.object({
    shortcode: z.string().min(1).describe('Job shortcode from workable.list_jobs'),
  }),
  outputSchema: z.object({
    summary: z.object({
      jobShortcode: z.string(),
      jobTitle: z.string().nullable(),
      totalCandidates: z.number(),
      active: z.number(),
      disqualified: z.number(),
      stages: z.array(StageSummary),
      scannedAll: z.boolean(),
    }),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const params = new URLSearchParams({ shortcode: input.shortcode, limit: '100' });
    const raw = await fetchCandidatePages(`/candidates?${params}`, 3, ctx.signal);
    // 3 pages x 100: if we hit exactly the cap there may be more.
    const scannedAll = raw.length < 300;

    const jobTitle: string | null =
      raw.find((c) => c.job?.title)?.job?.title ?? null;

    const byStage = new Map<
      string,
      { count: number; disqualified: number; last: string | null; recent: { name: string; at: string | null }[] }
    >();
    let disqualifiedTotal = 0;
    for (const c of raw) {
      const stage = (c.stage as string | null) ?? 'Unknown';
      const entry =
        byStage.get(stage) ?? { count: 0, disqualified: 0, last: null, recent: [] };
      entry.count++;
      if (c.disqualified) {
        entry.disqualified++;
        disqualifiedTotal++;
      }
      const at = (c.updated_at as string | null) ?? null;
      if (at && (!entry.last || at > entry.last)) entry.last = at;
      const name = ((c.name ??
        [c.firstname, c.lastname].filter(Boolean).join(' ')) as string).slice(0, 80);
      entry.recent.push({ name, at });
      byStage.set(stage, entry);
    }

    const stages = [...byStage.entries()]
      .map(([stage, v]) => ({
        stage,
        count: v.count,
        disqualified: v.disqualified,
        lastActivityAt: v.last,
        recentCandidates: v.recent
          .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
          .slice(0, 3)
          .map((r) => r.name),
      }))
      .sort((a, b) => b.count - a.count);

    const day = (iso: string | null) => (iso ? iso.slice(0, 10) : 'N/A');
    const lines: string[] = [];
    lines.push(`**Pipeline for req \`${input.shortcode}\`${jobTitle ? ` — ${jobTitle}` : ''}**`);
    lines.push('');
    lines.push(
      `- Candidates: **${raw.length}** total | active: ${raw.length - disqualifiedTotal} | disqualified: ${disqualifiedTotal}` +
        (scannedAll ? '' : ' (first 300 shown — pipeline is larger)'),
    );
    lines.push('');
    lines.push('| Stage | Candidates | Disqualified | Last activity | Most recent |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const s of stages) {
      lines.push(
        `| ${s.stage} | ${s.count} | ${s.disqualified} | ${day(s.lastActivityAt)} | ${s.recentCandidates.join(', ') || 'N/A'} |`,
      );
    }

    return {
      summary: {
        jobShortcode: input.shortcode,
        jobTitle,
        totalCandidates: raw.length,
        active: raw.length - disqualifiedTotal,
        disqualified: disqualifiedTotal,
        stages,
        scannedAll,
      },
      markdown: lines.join('\n'),
    };
  },
});

export const workableListJobQuestions = registerTool({
  id: 'workable.list_job_questions',
  description:
    'List the screening/application questions configured for a Workable job (by shortcode): question text, type (free text, multiple choice, boolean, etc.), whether it is required, and the answer choices. Use when evaluating whether a req screens for the right things, or before reviewing how candidates answered.',
  inputSchema: z.object({
    shortcode: z.string().min(1).describe('Job shortcode from workable.list_jobs'),
  }),
  outputSchema: z.object({
    questions: z.array(
      z.object({
        id: z.string(),
        body: z.string(),
        type: z.string().nullable(),
        required: z.boolean(),
        singleAnswer: z.boolean(),
        choices: z.array(z.string()),
      }),
    ),
  }),
  rateLimit: { perMinute: 15 },
  handler: async (input, ctx) => {
    // Same endpoint the matcher syncs into jobs.workableQuestions:
    // GET /jobs/{shortcode}/questions -> { questions: [...] }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await workableFetch<{ questions?: any[] }>(
      `/jobs/${encodeURIComponent(input.shortcode)}/questions`,
      { signal: ctx.signal },
    );
    return {
      questions: (data.questions ?? []).map((q) => ({
        id: String(q.id ?? ''),
        body: String(q.body ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500),
        type: q.type ?? null,
        required: Boolean(q.required),
        singleAnswer: Boolean(q.single_answer),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        choices: Array.isArray(q.choices)
          ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
            q.choices.map((ch: any) => String(ch.body ?? ch).slice(0, 200))
          : [],
      })),
    };
  },
});

export const workableListRecentActivity = registerTool({
  id: 'workable.list_recent_activity',
  description:
    'Recently updated candidates across the whole Workable pipeline (all jobs): who moved stage, was added, or otherwise changed in the last N days (default 7), newest first, with their current stage and job. The go-to tool for "what happened in recruiting this week", "any movement since Monday?", or a weekly hiring digest. Capped at 50 entries.',
  inputSchema: z.object({
    days: z.number().int().min(1).max(90).default(7).describe('Look-back window in days'),
  }),
  outputSchema: z.object({
    since: z.string(),
    total: z.number(),
    candidates: z.array(CandidateHit),
  }),
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const days = input.days ?? 7;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const params = new URLSearchParams({ updated_after: since, limit: '100' });
    const raw = await fetchCandidatePages(`/candidates?${params}`, 3, ctx.signal);
    const sorted = raw
      .map(toCandidateHit)
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    return { since, total: sorted.length, candidates: sorted.slice(0, 50) };
  },
});
