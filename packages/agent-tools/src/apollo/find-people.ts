import { z } from 'zod';
import { registerTool } from '../index';
import { apolloFetch } from './client';
import {
  DATASET,
  OK_STATUS,
  type RawSearchPerson,
  adaptPersonMatch,
  failureStatus,
  personMatchSchema,
  sourceOf,
  sourceSchema,
  statusShape,
} from './shape';

/**
 * Apollo people search — POST /api/v1/mixed_people/api_search.
 *
 * Free by design: Apollo charges nothing for this endpoint and, in exchange,
 * returns no email addresses and a masked surname. That split is exactly the
 * guardrail we want around a metered API — searching is unlimited, and the
 * model has to make a deliberate, separate call to spend a credit on the one
 * person worth contacting.
 */

const SENIORITIES = [
  'owner',
  'founder',
  'c_suite',
  'partner',
  'vp',
  'head',
  'director',
  'manager',
  'senior',
  'entry',
  'intern',
] as const;

// Apollo allows 100 per page; 50 keeps the payload small and, just as
// importantly, keeps an ordinary search from being scored as a bulk export.
const MAX_RESULTS = 50;

export const apolloFindPeople = registerTool({
  id: 'apollo.find_people',
  description:
    "Search Apollo's database of working professionals by job title, seniority, location, employer, employer size or keyword — the fastest way to build a shortlist of who to approach at a target company. Costs nothing to run. It returns names, job titles and employers, plus whether Apollo holds a work email for each person, but NOT the email itself: use the person-enrichment tool for the specific people worth contacting.",
  inputSchema: z.object({
    titles: z
      .array(z.string().min(1))
      .max(10)
      .optional()
      .describe('Job titles to match, e.g. ["VP of Engineering", "Head of Talent"]'),
    includeSimilarTitles: z
      .boolean()
      .default(true)
      .describe('Also match close variations of the titles given'),
    seniorities: z.array(z.enum(SENIORITIES)).max(6).optional(),
    personLocations: z
      .array(z.string().min(1))
      .max(10)
      .optional()
      .describe('Where the person is, e.g. ["California, US", "Mexico"]'),
    companyDomains: z
      .array(z.string().min(1))
      .max(25)
      .optional()
      .describe('Restrict to employees of these companies, by web domain, e.g. ["stripe.com"]'),
    companyLocations: z
      .array(z.string().min(1))
      .max(10)
      .optional()
      .describe('Where the employer is headquartered'),
    companySizes: z
      .array(z.string().regex(/^\d+,\d+$/))
      .max(6)
      .optional()
      .describe('Employer headcount bands as "min,max", e.g. ["51,200", "201,500"]'),
    keywords: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(MAX_RESULTS).default(10),
    page: z.number().int().min(1).max(50).default(1),
  }),
  outputSchema: z.object({
    ...statusShape,
    source: sourceSchema,
    people: z.array(personMatchSchema),
    totalFound: z.number(),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const empty = {
      source: sourceOf(DATASET.peopleSearch),
      people: [],
      totalFound: 0,
      guidance: '',
    };

    const res = await apolloFetch<{
      total_entries?: number;
      people?: RawSearchPerson[];
    }>(ctx, 'POST', '/mixed_people/api_search', {
      params: {
        person_titles: input.titles,
        include_similar_titles: input.includeSimilarTitles,
        person_seniorities: input.seniorities,
        person_locations: input.personLocations,
        q_organization_domains_list: input.companyDomains,
        organization_locations: input.companyLocations,
        organization_num_employees_ranges: input.companySizes,
        q_keywords: input.keywords,
        per_page: input.limit ?? 10,
        page: input.page ?? 1,
      },
    });

    if (!res.ok) return { ...empty, ...failureStatus(res) };

    const people = (res.data.people ?? [])
      .map(adaptPersonMatch)
      .filter((p): p is NonNullable<typeof p> => p !== null);

    const withEmail = people.filter((p) => p.hasWorkEmail).length;

    return {
      ...OK_STATUS,
      ...empty,
      people,
      totalFound: res.data.total_entries ?? people.length,
      guidance: people.length
        ? `Surnames are partly hidden and no email addresses are included — that is how Apollo's free search works. ${withEmail} of these ${people.length} have a work email on file. Pick the specific people worth contacting and enrich only those; each one costs the company an Apollo credit.`
        : 'Nothing matched. Broadening the job titles, dropping the location filter, or widening the company size band usually helps.',
    };
  },
});
