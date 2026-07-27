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
  type RawNewsArticle,
  adaptNewsArticle,
  failureStatus,
  newsArticleSchema,
  sourceOf,
  sourceSchema,
  statusShape,
} from './shape';

/**
 * Apollo company news — POST /api/v1/news_articles/search.
 *
 * A company that just closed a funding round is a company about to hire, and a
 * company that just announced a big contract is a company that needs delivery
 * capacity. Both are the opening line of a Zipdev outbound email.
 *
 * `web.search` can surface the same articles, but as unranked prose with no
 * date bound and no notion of what KIND of event happened. Apollo labels each
 * article and lets the search be bounded to a window, which is the difference
 * between "news about Acme" and "Acme raised money in the last 90 days".
 *
 * One credit per page, same shape as company search. Twenty-five articles is
 * already more than anyone reads about one company, so the page ceiling is low.
 */

// Only the categories Apollo's own reference documents. Apollo says more exist
// but does not name them, and an invented value is just a rejected request.
const CATEGORIES = ['investment', 'hires', 'contract'] as const;

const MAX_RESULTS = 25;
const MAX_PAGE = 5;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const apolloCompanyNews = registerTool({
  id: 'apollo.company_news',
  description:
    'Recent press coverage of one company — funding rounds, hiring announcements and new contracts — each with its date, headline and a link. A company that just raised or just won a big contract is one that is about to need people, so this is the reason to reach out and the line to open with. Costs one Apollo credit per page of results, plus one extra credit if you name the company by web domain instead of by the reference the company search tools return.',
  inputSchema: z
    .object({
      ...companyRefFields,
      categories: z
        .array(z.enum(CATEGORIES))
        .max(3)
        .optional()
        .describe(
          'Limit to certain kinds of announcement: "investment" for funding rounds, "hires" for people news, "contract" for new deals won',
        ),
      since: z
        .string()
        .regex(DATE_RE)
        .optional()
        .describe('Only news published on or after this date, as YYYY-MM-DD'),
      until: z
        .string()
        .regex(DATE_RE)
        .optional()
        .describe('Only news published on or before this date, as YYYY-MM-DD'),
      limit: z.number().int().min(1).max(MAX_RESULTS).default(10),
      page: z.number().int().min(1).max(MAX_PAGE).default(1),
    })
    .refine(hasCompanyRef, { message: NEEDS_COMPANY }),
  outputSchema: z.object({
    ...statusShape,
    source: sourceSchema,
    companyName: z.string().nullable(),
    companyDomain: z.string().nullable(),
    articles: z.array(newsArticleSchema),
    totalFound: z.number(),
    creditsUsed: z.number(),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const limit = input.limit ?? 10;
    const page = input.page ?? 1;
    const base = {
      source: sourceOf(DATASET.companyNews),
      companyName: null as string | null,
      companyDomain: input.domain ?? null,
      articles: [],
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
      news_articles?: RawNewsArticle[];
      pagination?: { total_entries?: number; total_pages?: number };
    }>(ctx, 'POST', '/news_articles/search', {
      params: {
        organization_ids: [company.id],
        categories: input.categories ? [...input.categories] : undefined,
        'published_at[min]': input.since,
        'published_at[max]': input.until,
        per_page: limit,
        page,
      },
    });
    if (!res.ok) return { ...withCompany, ...failureStatus(res) };

    const articles = (res.data.news_articles ?? []).map(adaptNewsArticle).slice(0, limit);
    const totalPages = res.data.pagination?.total_pages ?? 1;

    return {
      ...OK_STATUS,
      ...withCompany,
      articles,
      totalFound: res.data.pagination?.total_entries ?? articles.length,
      creditsUsed: company.creditsUsed + 1,
      guidance: articles.length
        ? `Showing page ${page} of ${totalPages}. Every extra page costs another Apollo credit, so ask before fetching more. Quote the headline and its date if you use any of this in an email — it is press coverage, so it is fair to mention.`
        : 'Apollo has no news on file for that company in this window. Widening the dates or dropping the category filter is the next thing to try; if it stays empty, they simply are not being written about.',
    };
  },
});
