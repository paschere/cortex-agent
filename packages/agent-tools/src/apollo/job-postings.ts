import { z } from 'zod';
import { registerTool } from '../index';
import { apolloFetch } from './client';
import {
  COMPANY_NOT_FOUND,
  NEEDS_COMPANY,
  companyRefFields,
  hasCompanyRef,
  resolveCompany,
} from './company-ref';
import {
  DATASET,
  OK_STATUS,
  type RawJobPosting,
  adaptJobPosting,
  failureStatus,
  jobPostingSchema,
  sourceOf,
  sourceSchema,
  statusShape,
} from './shape';

/**
 * Apollo job postings — GET /api/v1/organizations/{id}/job_postings.
 *
 * The strongest buying signal we have: a company advertising six engineering
 * roles is a company already spending on hiring and already failing to fill it.
 *
 * This does NOT overlap `growth.find_signals`, which sweeps five public job
 * boards with a web search and discovers companies it happens to trip over.
 * This answers the opposite question — "is THIS company, the one already in the
 * CRM or on today's call, hiring right now?" — and Apollo aggregates career
 * pages and boards those five sites never cover.
 *
 * One credit per page however many postings the page holds, so the page size is
 * generous and the page count is small: paging is where the money goes, not
 * result count. `titleKeywords` filters the page already paid for and is free.
 */

// Apollo permits 10,000 per page. The ceiling here is about payload size, not
// cost — and 100 open roles is already far more than anyone reads.
const MAX_RESULTS = 100;
const MAX_PAGE = 10;

export const apolloCompanyJobPostings = registerTool({
  id: 'apollo.company_job_postings',
  description:
    'See every role a company is advertising right now — job title, where it is based, and when it was posted. A company with several engineering roles open is actively spending on hiring, which is the clearest sign it is worth approaching. Costs one Apollo credit per page of results, plus one extra credit if you name the company by web domain instead of by the reference the company search tools return. ' +
    "Use this when you already have a company in mind — one on today's call, one in the CRM, one someone just named. It cannot discover companies. growth.find_signals does the opposite: it sweeps public job boards for a ROLE and turns up companies nobody had thought of, free of Apollo credits, and files them for review. Neither replaces the other.",
  inputSchema: z
    .object({
      ...companyRefFields,
      titleKeywords: z
        .array(z.string().min(2))
        .max(10)
        .optional()
        .describe(
          'Only keep postings whose title mentions one of these words, e.g. ["engineer", "developer", "QA"]. This narrows results already paid for and costs nothing extra',
        ),
      limit: z.number().int().min(1).max(MAX_RESULTS).default(25),
      page: z.number().int().min(1).max(MAX_PAGE).default(1),
    })
    .refine(hasCompanyRef, { message: NEEDS_COMPANY }),
  outputSchema: z.object({
    ...statusShape,
    source: sourceSchema,
    companyName: z.string().nullable(),
    companyDomain: z.string().nullable(),
    postings: z.array(jobPostingSchema),
    totalFound: z.number(),
    creditsUsed: z.number(),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const limit = input.limit ?? 25;
    const page = input.page ?? 1;
    const base = {
      source: sourceOf(DATASET.jobPostings),
      companyName: null as string | null,
      companyDomain: input.domain ?? null,
      postings: [],
      totalFound: 0,
      creditsUsed: 0,
      guidance: '',
    };

    const ref = await resolveCompany(ctx, input);
    if (!ref.ok) return { ...base, ...failureStatus(ref) };
    if (!ref.data) return { ...base, configured: true, reason: COMPANY_NOT_FOUND };

    const company = ref.data;
    const withCompany = {
      ...base,
      companyName: company.name,
      companyDomain: company.domain,
      creditsUsed: company.creditsUsed,
    };

    const res = await apolloFetch<{
      organization_job_postings?: RawJobPosting[];
      pagination?: { total_entries?: number; total_pages?: number };
    }>(ctx, 'GET', `/organizations/${encodeURIComponent(company.id)}/job_postings`, {
      params: { per_page: limit, page },
    });
    if (!res.ok) return { ...withCompany, ...failureStatus(res) };

    const all = (res.data.organization_job_postings ?? []).map(adaptJobPosting);

    const keywords = (input.titleKeywords ?? []).map((k) => k.toLowerCase());
    const matched = keywords.length
      ? all.filter((j) => {
          const title = (j.title ?? '').toLowerCase();
          return keywords.some((k) => title.includes(k));
        })
      : all;
    const postings = matched.slice(0, limit);

    const totalPages = res.data.pagination?.total_pages ?? 1;
    const filteredOut = all.length - matched.length;

    return {
      ...OK_STATUS,
      ...withCompany,
      postings,
      totalFound: res.data.pagination?.total_entries ?? all.length,
      // The page itself is the charge; the resolve, if it happened, is on top.
      creditsUsed: company.creditsUsed + 1,
      guidance: postings.length
        ? [
            `Showing ${postings.length} of the ${all.length} roles on page ${page} of ${totalPages}.`,
            filteredOut > 0
              ? `${filteredOut} more were on this page but did not match the words given.`
              : '',
            'Each extra page costs another Apollo credit, so ask before fetching more.',
          ]
            .filter(Boolean)
            .join(' ')
        : all.length
          ? 'None of the open roles matched those words — dropping the keyword filter shows everything this company is advertising.'
          : 'Apollo is not seeing any open roles at this company right now. That usually means they are not hiring publicly, so there is no hiring signal here.',
    };
  },
});
