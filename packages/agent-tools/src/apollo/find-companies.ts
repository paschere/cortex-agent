import { z } from 'zod';
import { registerTool } from '../index';
import { apolloFetch } from './client';
import {
  DATASET,
  OK_STATUS,
  type RawOrganization,
  adaptCompany,
  companySchema,
  failureStatus,
  sourceOf,
  sourceSchema,
  statusShape,
} from './shape';

/**
 * Apollo company search — POST /api/v1/mixed_companies/search.
 *
 * Apollo bills a credit per PAGE of results here, not per company, so the
 * paging is exposed but bounded and the tool never walks pages on its own.
 */

const MAX_RESULTS = 25;

export const apolloFindCompanies = registerTool({
  id: 'apollo.find_companies',
  description:
    'Build a list of target companies from Apollo by headcount, location, industry keyword, technology they run, funding raised or name. Returns each company with its domain, size, location and firmographics — the starting point for an outbound list. Costs one Apollo credit per page of results.',
  inputSchema: z.object({
    name: z.string().min(2).optional().describe('Company name, partial matches accepted'),
    domains: z
      .array(z.string().min(3))
      .max(25)
      .optional()
      .describe('Look these specific companies up by web domain'),
    keywords: z
      .array(z.string().min(2))
      .max(10)
      .optional()
      .describe('Industry or business keywords, e.g. ["fintech", "logistics software"]'),
    locations: z
      .array(z.string().min(2))
      .max(10)
      .optional()
      .describe('Where the company is headquartered, e.g. ["United States", "Texas, US"]'),
    excludeLocations: z.array(z.string().min(2)).max(10).optional(),
    sizes: z
      .array(z.string().regex(/^\d+,\d+$/))
      .max(6)
      .optional()
      .describe('Headcount bands as "min,max", e.g. ["51,200", "201,500"]'),
    technologies: z
      .array(z.string().min(2))
      .max(10)
      .optional()
      .describe('Technologies the company uses, e.g. ["react", "salesforce"]'),
    minRevenue: z.number().int().min(0).optional(),
    maxRevenue: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(MAX_RESULTS).default(10),
    page: z.number().int().min(1).max(50).default(1),
  }),
  outputSchema: z.object({
    ...statusShape,
    source: sourceSchema,
    companies: z.array(companySchema),
    totalFound: z.number(),
    page: z.number(),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const limit = input.limit ?? 10;
    const page = input.page ?? 1;
    const base = {
      source: sourceOf(DATASET.companySearch),
      companies: [],
      totalFound: 0,
      page,
      guidance: '',
    };

    const res = await apolloFetch<{
      organizations?: RawOrganization[];
      accounts?: RawOrganization[];
      pagination?: { total_entries?: number; total_pages?: number };
    }>(ctx, 'POST', '/mixed_companies/search', {
      params: {
        q_organization_name: input.name,
        q_organization_domains_list: input.domains,
        q_organization_keyword_tags: input.keywords,
        organization_locations: input.locations,
        organization_not_locations: input.excludeLocations,
        organization_num_employees_ranges: input.sizes,
        currently_using_any_of_technology_uids: input.technologies,
        'revenue_range[min]': input.minRevenue,
        'revenue_range[max]': input.maxRevenue,
        per_page: limit,
        page,
      },
    });

    if (!res.ok) return { ...base, ...failureStatus(res) };

    // Companies already saved as accounts in the Apollo workspace come back
    // under `accounts`; prospects that are not come back under `organizations`.
    // Both are the same shape and both are results.
    const raw = [...(res.data.organizations ?? []), ...(res.data.accounts ?? [])];
    const companies = raw.map(adaptCompany).slice(0, limit);
    const totalPages = res.data.pagination?.total_pages ?? 1;

    return {
      ...OK_STATUS,
      ...base,
      companies,
      totalFound: res.data.pagination?.total_entries ?? companies.length,
      guidance: companies.length
        ? `Showing page ${page} of ${totalPages}. Every extra page costs another Apollo credit, so ask before fetching more.`
        : 'Nothing matched those filters. Fewer keywords, a wider headcount band, or dropping the technology filter usually opens it up.',
    };
  },
});
