import { z } from 'zod';
import { registerTool } from '../index';
import { apolloFetch } from './client';
import {
  DATASET,
  OK_STATUS,
  type RawPerson,
  adaptPerson,
  failureStatus,
  personSchema,
  sourceOf,
  sourceSchema,
  statusShape,
} from './shape';

/**
 * Apollo person enrichment — POST /api/v1/people/match (one person) and
 * POST /api/v1/people/bulk_match (up to ten).
 *
 * THIS IS THE PART THAT COSTS MONEY. Apollo bills 1 credit per person for
 * demographics and a work email, and 8 more if a mobile number comes back.
 * Three deliberate limits keep that spend visible and bounded:
 *
 *  - phone and personal-email reveals are not exposed at all. They are the
 *    expensive fields, they need an async webhook Zippy has nowhere to put,
 *    and a work email is what a recruiting or sales conversation actually
 *    needs. Nothing here can silently spend 9 credits on one person.
 *  - nothing fans out over a search result. `find_people` returns candidates
 *    and stops; a human or the model has to name who is worth enriching.
 *  - the batch tool is capped at Apollo's own maximum of ten AND asks for
 *    confirmation first, so a ten-credit charge is always somebody's decision.
 */

const personInput = z.object({
  name: z.string().min(2).optional().describe('Full name, e.g. "Ada Lovelace"'),
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  email: z.string().email().optional().describe('A known address — the strongest match signal'),
  linkedinUrl: z.string().url().optional(),
  apolloId: z.string().min(1).optional().describe('An id returned by the people search tool'),
  company: z.string().min(1).optional().describe('Their employer, by name'),
  companyDomain: z
    .string()
    .min(3)
    .optional()
    .describe('Their employer, by web domain — e.g. "stripe.com"'),
});

type PersonInput = z.infer<typeof personInput>;

/** A name alone matches too many people to be worth a credit. */
function hasEnoughToMatch(p: PersonInput): boolean {
  if (p.email || p.linkedinUrl || p.apolloId) return true;
  const named = !!p.name || !!(p.firstName && p.lastName);
  return named && !!(p.company || p.companyDomain);
}

const NEEDS_MORE =
  'I need a bit more to go on before spending a lookup: either an email address, a LinkedIn profile, or a full name together with the company they work at.';

function toApolloParams(p: PersonInput): Record<string, string | undefined> {
  return {
    name: p.name,
    first_name: p.firstName,
    last_name: p.lastName,
    email: p.email,
    linkedin_url: p.linkedinUrl,
    id: p.apolloId,
    organization_name: p.company,
    domain: p.companyDomain,
  };
}

const NOT_FOUND =
  'Apollo has no record matching that person, so there is nothing to report and no credit was spent. A LinkedIn URL or their exact employer usually turns a miss into a hit.';

export const apolloEnrichPerson = registerTool({
  id: 'apollo.enrich_person',
  description:
    'Look one person up in Apollo and return their verified work email, job title, seniority, LinkedIn profile and current employer. Give an email address, a LinkedIn URL, or a full name plus the company they work at. USES ONE APOLLO CREDIT per person found (nothing is charged when there is no match), so run it on people who have actually been chosen — not across a whole search result.',
  inputSchema: personInput.refine(hasEnoughToMatch, { message: NEEDS_MORE }),
  outputSchema: z.object({
    ...statusShape,
    source: sourceSchema,
    found: z.boolean(),
    person: personSchema.nullable(),
  }),
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const base = { source: sourceOf(DATASET.personEnrichment), found: false, person: null };

    const res = await apolloFetch<{ person?: RawPerson | null }>(ctx, 'POST', '/people/match', {
      params: toApolloParams(input),
    });
    if (!res.ok) return { ...base, ...failureStatus(res) };

    const raw = res.data.person;
    if (!raw) return { ...base, configured: true, reason: NOT_FOUND };

    return { ...OK_STATUS, ...base, found: true, person: adaptPerson(raw) };
  },
});

// Apollo's own ceiling for one bulk_match request.
const MAX_BATCH = 10;

export const apolloEnrichPeople = registerTool({
  id: 'apollo.enrich_people',
  description:
    "Look up to ten people up in Apollo in one go and return each one's verified work email, title, LinkedIn profile and employer. USES ONE APOLLO CREDIT PER PERSON FOUND — a full batch of ten costs ten credits — so it asks for approval before it runs. For a single person, use the one-person lookup instead.",
  inputSchema: z.object({
    people: z
      .array(personInput)
      .min(1)
      .max(MAX_BATCH)
      .describe('Each entry needs an email, a LinkedIn URL, or a full name plus their employer'),
  }),
  outputSchema: z.object({
    ...statusShape,
    source: sourceSchema,
    people: z.array(personSchema),
    requested: z.number(),
    found: z.number(),
    skipped: z.number(),
    creditsUsed: z.number(),
  }),
  // Real money, ten people at a time: a human signs off every batch. The
  // security policy classifies this as a bulk read of personal data and would
  // gate it anyway; declaring it here means the gate does not depend on the
  // classifier's arithmetic.
  requiresConfirmation: true,
  rateLimit: { perMinute: 3 },
  handler: async (input, ctx) => {
    const base = {
      source: sourceOf(DATASET.personEnrichment),
      people: [],
      requested: input.people.length,
      found: 0,
      skipped: 0,
      creditsUsed: 0,
    };

    // Entries too vague to match would burn a request without ever returning a
    // person, so they are dropped before the call rather than after it.
    const usable = input.people.filter(hasEnoughToMatch);
    const skipped = input.people.length - usable.length;
    if (!usable.length) {
      return { ...base, skipped, configured: true, reason: NEEDS_MORE };
    }

    const res = await apolloFetch<{ matches?: Array<RawPerson | null> }>(
      ctx,
      'POST',
      '/people/bulk_match',
      { body: { details: usable.map(toApolloParams) } },
    );
    if (!res.ok) return { ...base, skipped, ...failureStatus(res) };

    const people = (res.data.matches ?? [])
      .filter((m): m is RawPerson => !!m && !!(m.id || m.email || m.name))
      .map(adaptPerson);

    return {
      ...OK_STATUS,
      ...base,
      skipped,
      people,
      found: people.length,
      // Apollo bills per person actually matched; misses are free.
      creditsUsed: people.length,
      reason:
        skipped > 0
          ? `${skipped} of the people given did not have enough detail to look up — each one needs an email, a LinkedIn profile, or a full name plus their employer.`
          : null,
    };
  },
});
