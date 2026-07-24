import { z } from 'zod';
import { registerTool } from '../index';
import { workableFetch } from './client';

/**
 * Direct Workable tools (SPI v3). These complement the recruit.* tools (which
 * go through zipdev-matcher's enriched data): Workable is the ground-truth
 * ATS, so req-status and stage moves come straight from here.
 */

const JobSummary = z.object({
  shortcode: z.string(),
  title: z.string(),
  state: z.string(),
  department: z.string().nullable(),
  location: z.string().nullable(),
  createdAt: z.string().nullable(),
  url: z.string().nullable(),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toJobSummary(j: any): z.infer<typeof JobSummary> {
  return {
    shortcode: j.shortcode ?? '',
    title: j.title ?? '',
    state: j.state ?? '',
    department: j.department ?? null,
    location: j.location?.location_str ?? j.location?.city ?? null,
    createdAt: j.created_at ?? null,
    url: j.url ?? null,
  };
}

export const workableListJobs = registerTool({
  id: 'workable.list_jobs',
  description:
    'List jobs (reqs) in Workable, the ground-truth ATS. Filter by state: published (open), draft, closed, or archived. Returns shortcodes used by the other workable.* tools.',
  inputSchema: z.object({
    state: z.enum(['published', 'draft', 'closed', 'archived']).optional(),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  outputSchema: z.object({ jobs: z.array(JobSummary) }),
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const params = new URLSearchParams({ limit: String(input.limit ?? 50) });
    if (input.state) params.set('state', input.state);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await workableFetch<{ jobs: any[] }>(`/jobs?${params}`, { signal: ctx.signal });
    return { jobs: (data.jobs ?? []).map(toJobSummary) };
  },
});

export const workableGetJob = registerTool({
  id: 'workable.get_job',
  description:
    'Get full details for one Workable job by shortcode: description, requirements, benefits, hiring team, and creation date. Use for req-status synthesis alongside workable.list_candidates.',
  inputSchema: z.object({ shortcode: z.string().min(1) }),
  outputSchema: z.object({
    job: z.object({
      shortcode: z.string(),
      title: z.string(),
      state: z.string(),
      department: z.string().nullable(),
      location: z.string().nullable(),
      createdAt: z.string().nullable(),
      fullDescription: z.string().nullable(),
      requirements: z.string().nullable(),
      benefits: z.string().nullable(),
      url: z.string().nullable(),
    }),
  }),
  rateLimit: { perMinute: 15 },
  handler: async (input, ctx) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const j = await workableFetch<any>(
      `/jobs/${encodeURIComponent(input.shortcode)}?include_fields=description,full_description,requirements,benefits`,
      { signal: ctx.signal },
    );
    const strip = (s: string | null | undefined) =>
      s ? s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 6000) : null;
    return {
      job: {
        ...toJobSummary(j),
        fullDescription: strip(j.full_description ?? j.description),
        requirements: strip(j.requirements),
        benefits: strip(j.benefits),
      },
    };
  },
});

const CandidateSummary = z.object({
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
function toCandidate(c: any): z.infer<typeof CandidateSummary> {
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

export const workableListCandidates = registerTool({
  id: 'workable.list_candidates',
  description:
    'List candidates in Workable, optionally filtered by job shortcode and/or stage name. Use to synthesize req status: counts per stage, who is where, and how fresh the activity is (updatedAt).',
  inputSchema: z.object({
    shortcode: z.string().optional().describe('Job shortcode from workable.list_jobs'),
    stage: z.string().optional().describe('Stage slug/name, e.g. "phone screen"'),
    limit: z.number().int().min(1).max(100).default(100),
  }),
  outputSchema: z.object({ candidates: z.array(CandidateSummary) }),
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const params = new URLSearchParams({ limit: String(input.limit ?? 100) });
    if (input.shortcode) params.set('shortcode', input.shortcode);
    if (input.stage) params.set('stage', input.stage);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await workableFetch<{ candidates: any[] }>(`/candidates?${params}`, {
      signal: ctx.signal,
    });
    return { candidates: (data.candidates ?? []).map(toCandidate) };
  },
});

export const workableGetCandidate = registerTool({
  id: 'workable.get_candidate',
  description:
    'Get one Workable candidate by id: profile, current stage, job, contact info, and source. Ground answers about a candidate in this data.',
  inputSchema: z.object({ candidateId: z.string().min(1) }),
  outputSchema: z.object({
    candidate: CandidateSummary.extend({
      phone: z.string().nullable(),
      source: z.string().nullable(),
      coverLetter: z.string().nullable(),
      summary: z.string().nullable(),
    }),
  }),
  rateLimit: { perMinute: 15 },
  handler: async (input, ctx) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await workableFetch<{ candidate: any }>(
      `/candidates/${encodeURIComponent(input.candidateId)}`,
      { signal: ctx.signal },
    );
    const c = data.candidate ?? data;
    return {
      candidate: {
        ...toCandidate(c),
        phone: c.phone ?? null,
        source: c.source ?? null,
        coverLetter: (c.cover_letter ?? '').slice(0, 4000) || null,
        summary: (c.summary ?? '').slice(0, 4000) || null,
      },
    };
  },
});

export const workableMoveCandidate = registerTool({
  id: 'workable.move_candidate',
  description:
    'Move a Workable candidate to another stage of their job pipeline (e.g. from "Applied" to "Phone screen"). Confirmation-gated: show the candidate, current stage, and target stage before executing.',
  inputSchema: z.object({
    candidateId: z.string().min(1),
    targetStage: z.string().min(1).describe('Target stage slug/name as shown in Workable'),
    memberId: z.string().optional().describe('Workable member id performing the move'),
  }),
  outputSchema: z.object({ ok: z.boolean(), candidateId: z.string(), targetStage: z.string() }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    await workableFetch(`/candidates/${encodeURIComponent(input.candidateId)}/move`, {
      method: 'POST',
      body: JSON.stringify({
        target_stage: input.targetStage,
        ...(input.memberId ? { member_id: input.memberId } : {}),
      }),
      signal: ctx.signal,
    });
    return { ok: true, candidateId: input.candidateId, targetStage: input.targetStage };
  },
});

export const workableCreateComment = registerTool({
  id: 'workable.create_comment',
  description:
    'Leave a comment/note on a Workable candidate profile (visible to the hiring team). Confirmation-gated: show the exact note text before executing.',
  inputSchema: z.object({
    candidateId: z.string().min(1),
    body: z.string().min(1).max(4000),
    memberId: z.string().optional().describe('Workable member id authoring the note'),
  }),
  outputSchema: z.object({ ok: z.boolean(), candidateId: z.string() }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    await workableFetch(`/candidates/${encodeURIComponent(input.candidateId)}/comments`, {
      method: 'POST',
      body: JSON.stringify({
        comment: { body: input.body },
        ...(input.memberId ? { member_id: input.memberId } : {}),
      }),
      signal: ctx.signal,
    });
    return { ok: true, candidateId: input.candidateId };
  },
});
