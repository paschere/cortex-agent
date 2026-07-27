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
 * Apollo company enrichment — GET /api/v1/organizations/enrich.
 *
 * One credit per company matched, nothing when there is no match. Cheap enough
 * to run on a single target before a call, expensive enough that nothing here
 * loops over a list: the search tool returns firmographics of its own, and this
 * is for the one company being worked.
 */

const NOT_FOUND =
  'Apollo has nothing on file for that company, so no credit was spent. The web domain (rather than the trading name) is usually what finds it.';

export const apolloEnrichCompany = registerTool({
  id: 'apollo.enrich_company',
  description:
    "Get Apollo's full profile of one company — headcount, industry, headquarters, year founded, revenue band, funding raised and the technologies they run — from its web domain, name or LinkedIn page. Good preparation before a first call or when qualifying an inbound lead. USES ONE APOLLO CREDIT per company found (nothing when there is no match).",
  inputSchema: z
    .object({
      domain: z
        .string()
        .min(3)
        .optional()
        .describe('Web domain without www or @, e.g. "stripe.com" — the most reliable input'),
      name: z.string().min(2).optional().describe('Company name, if the domain is unknown'),
      linkedinUrl: z.string().url().optional().describe("The company's LinkedIn page"),
    })
    .refine((v) => !!(v.domain || v.name || v.linkedinUrl), {
      message: 'Tell me the company web domain, its name, or its LinkedIn page.',
    }),
  outputSchema: z.object({
    ...statusShape,
    source: sourceSchema,
    found: z.boolean(),
    company: companySchema.nullable(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const base = { source: sourceOf(DATASET.companyEnrichment), found: false, company: null };

    const res = await apolloFetch<{ organization?: RawOrganization | null }>(
      ctx,
      'GET',
      '/organizations/enrich',
      {
        params: { domain: input.domain, name: input.name, linkedin_url: input.linkedinUrl },
      },
    );
    if (!res.ok) return { ...base, ...failureStatus(res) };

    const org = res.data.organization;
    if (!org) return { ...base, configured: true, reason: NOT_FOUND };

    return { ...OK_STATUS, ...base, found: true, company: adaptCompany(org) };
  },
});
