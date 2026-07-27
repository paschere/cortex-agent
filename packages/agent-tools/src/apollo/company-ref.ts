import { z } from 'zod';
import type { ToolContext } from '../types';
import { type ApolloResult, apolloFetch } from './client';
import type { RawOrganization } from './shape';

/**
 * Both company-signal tools (open roles, news) are keyed on Apollo's own id for
 * a company — something no human has to hand. Rather than make the model guess,
 * they take either that id, which the company search and company profile tools
 * already return for free, or a plain web domain.
 *
 * Resolving a domain COSTS ONE EXTRA CREDIT: company enrichment is the only
 * lookup that turns a domain into an id. That is real money, so it is stated in
 * both tool descriptions, and every call reports the total it spent rather than
 * letting the charge happen quietly.
 *
 * It resolves exactly one company per call and takes no lists. There is
 * deliberately no shape here that turns a batch of domains into a batch of
 * charges.
 */

export const companyRefFields = {
  companyApolloId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Apollo's own reference for the company, exactly as returned by the company search or company profile tools — using it costs nothing extra",
    ),
  domain: z
    .string()
    .min(3)
    .optional()
    .describe(
      'The company web domain instead, e.g. "stripe.com" — this costs one extra Apollo credit, because the company has to be found first',
    ),
};

export interface CompanyRef {
  companyApolloId?: string | undefined;
  domain?: string | undefined;
}

export function hasCompanyRef(v: CompanyRef): boolean {
  return !!(v.companyApolloId || v.domain);
}

export const NEEDS_COMPANY =
  'Tell me which company — either its web domain, or pick it out of a company search first.';

export const COMPANY_NOT_FOUND =
  'Apollo has nothing on file for that company, so there is nothing to report. The web domain rather than the trading name is usually what finds it.';

export interface ResolvedCompany {
  id: string;
  name: string | null;
  domain: string | null;
  /** 0 when the id was given, 1 when a domain had to be looked up first. */
  creditsUsed: number;
}

/** Resolves to `null` (not a failure) when Apollo simply has no such company. */
export async function resolveCompany(
  ctx: ToolContext,
  input: CompanyRef,
): Promise<ApolloResult<ResolvedCompany | null>> {
  if (input.companyApolloId) {
    return {
      ok: true,
      data: {
        id: input.companyApolloId,
        name: null,
        domain: input.domain ?? null,
        creditsUsed: 0,
      },
    };
  }

  const res = await apolloFetch<{ organization?: RawOrganization | null }>(
    ctx,
    'GET',
    '/organizations/enrich',
    { params: { domain: input.domain } },
  );
  if (!res.ok) return res;

  const org = res.data.organization;
  if (!org?.id) return { ok: true, data: null };

  return {
    ok: true,
    data: {
      id: org.id,
      name: org.name ?? null,
      domain: org.primary_domain ?? input.domain ?? null,
      creditsUsed: 1,
    },
  };
}
