import { z } from 'zod';
import type { ApolloFailure } from './client';

/**
 * Shared response shaping for the Apollo tools.
 *
 * Two jobs, the same two the recruit tools have:
 *
 * 1. PROVENANCE. Every Apollo tool returns `source` — which Apollo dataset the
 *    facts came from and when they were read. Zippy quotes contact details to
 *    people who will act on them, so "this email is verified" has to be
 *    traceable to a system and a timestamp rather than sounding like Zippy's
 *    own knowledge.
 *
 * 2. SIZE. A single raw Apollo organization is ~200 fields (org charts, intent
 *    scores, alexa rankings, logo URLs, sub-organizations) and a person carries
 *    a nested contact record with its full CRM history. Nothing here passes a
 *    raw record through: every tool projects into the lean shapes below, so the
 *    model sees a few hundred bytes per record instead of tens of kilobytes.
 */

/** Stamped on every result so Zippy can cite where a fact came from. */
export const sourceSchema = z.object({
  provider: z.literal('Apollo.io'),
  dataset: z.string(),
  retrievedAt: z.string(),
});

/** Human names for the Apollo datasets — never an endpoint path or a tool id. */
export const DATASET = {
  peopleSearch: 'Apollo people search',
  personEnrichment: 'Apollo person enrichment',
  companySearch: 'Apollo company search',
  companyEnrichment: 'Apollo company enrichment',
} as const;

export function sourceOf(dataset: string): z.infer<typeof sourceSchema> {
  return { provider: 'Apollo.io', dataset, retrievedAt: new Date().toISOString() };
}

/**
 * Present on every Apollo tool's output. `reason` is null on success and a
 * complete human sentence on any soft failure, so the model always has
 * something to say instead of an empty result it cannot explain.
 */
export const statusShape = {
  configured: z.boolean(),
  reason: z.string().nullable(),
};

export const OK_STATUS = { configured: true, reason: null };

export function failureStatus(f: ApolloFailure): { configured: boolean; reason: string } {
  return { configured: f.configured, reason: f.reason };
}

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------

const MAX_TECHNOLOGIES = 15;
const MAX_KEYWORDS = 10;
const MAX_DESCRIPTION = 400;

export const companySchema = z.object({
  apolloId: z.string().nullable(),
  name: z.string().nullable(),
  domain: z.string().nullable(),
  website: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  industry: z.string().nullable(),
  employees: z.number().nullable(),
  location: z.string().nullable(),
  foundedYear: z.number().nullable(),
  description: z.string().nullable(),
  annualRevenue: z.string().nullable(),
  totalFunding: z.string().nullable(),
  latestFundingStage: z.string().nullable(),
  latestFundingDate: z.string().nullable(),
  technologies: z.array(z.string()),
  keywords: z.array(z.string()),
});

export type Company = z.infer<typeof companySchema>;

export interface RawOrganization {
  id?: string | null;
  name?: string | null;
  website_url?: string | null;
  primary_domain?: string | null;
  linkedin_url?: string | null;
  industry?: string | null;
  keywords?: string[] | null;
  estimated_num_employees?: number | null;
  founded_year?: number | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  short_description?: string | null;
  annual_revenue_printed?: string | null;
  total_funding_printed?: string | null;
  latest_funding_stage?: string | null;
  latest_funding_round_date?: string | null;
  technology_names?: string[] | null;
}

export function joinLocation(
  city?: string | null,
  state?: string | null,
  country?: string | null,
): string | null {
  const parts = [city, state, country].filter((p): p is string => !!p);
  return parts.length ? parts.join(', ') : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function adaptCompany(o: RawOrganization): Company {
  return {
    apolloId: o.id ?? null,
    name: o.name ?? null,
    domain: o.primary_domain ?? null,
    website: o.website_url ?? null,
    linkedinUrl: o.linkedin_url ?? null,
    industry: o.industry ?? null,
    employees: num(o.estimated_num_employees),
    location: joinLocation(o.city, o.state, o.country),
    foundedYear: num(o.founded_year),
    description: o.short_description ? o.short_description.slice(0, MAX_DESCRIPTION) : null,
    annualRevenue: o.annual_revenue_printed ?? null,
    totalFunding: o.total_funding_printed ?? null,
    latestFundingStage: o.latest_funding_stage ?? null,
    latestFundingDate: o.latest_funding_round_date ?? null,
    technologies: (o.technology_names ?? []).slice(0, MAX_TECHNOLOGIES),
    keywords: (o.keywords ?? []).slice(0, MAX_KEYWORDS),
  };
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/**
 * A search hit. Apollo's search endpoint deliberately withholds contact
 * details — surnames come back partly masked and emails not at all — so this
 * shape reports what IS on file (`hasWorkEmail`, `hasDirectPhone`) rather than
 * pretending to have it. Enrichment is the only way to get the address, and it
 * is the only thing that costs money.
 */
export const personMatchSchema = z.object({
  apolloId: z.string(),
  firstName: z.string().nullable(),
  /** Apollo masks the surname in search results; enrichment returns it in full. */
  lastNameMasked: z.string().nullable(),
  title: z.string().nullable(),
  company: z.string().nullable(),
  hasWorkEmail: z.boolean(),
  hasDirectPhone: z.boolean(),
  lastVerifiedAt: z.string().nullable(),
});

export type PersonMatch = z.infer<typeof personMatchSchema>;

export interface RawSearchPerson {
  id?: string | null;
  first_name?: string | null;
  last_name_obfuscated?: string | null;
  last_name?: string | null;
  title?: string | null;
  last_refreshed_at?: string | null;
  has_email?: boolean | null;
  has_direct_phone?: boolean | string | null;
  organization?: { name?: string | null } | null;
}

export function adaptPersonMatch(p: RawSearchPerson): PersonMatch | null {
  if (!p.id) return null;
  return {
    apolloId: p.id,
    firstName: p.first_name ?? null,
    lastNameMasked: p.last_name_obfuscated ?? p.last_name ?? null,
    title: p.title ?? null,
    company: p.organization?.name ?? null,
    hasWorkEmail: p.has_email === true,
    // Apollo has shipped this as both a boolean and a string; treat anything
    // that is not an explicit "no" as a yes.
    hasDirectPhone: p.has_direct_phone === true || p.has_direct_phone === 'true',
    lastVerifiedAt: p.last_refreshed_at ?? null,
  };
}

/** A fully enriched person — the shape a credit actually buys. */
export const personSchema = z.object({
  apolloId: z.string().nullable(),
  name: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  title: z.string().nullable(),
  seniority: z.string().nullable(),
  departments: z.array(z.string()),
  workEmail: z.string().nullable(),
  /** Apollo's own verdict on the address: 'verified', 'guessed', 'unavailable'. */
  emailConfidence: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  location: z.string().nullable(),
  company: z.string().nullable(),
  companyDomain: z.string().nullable(),
  companyWebsite: z.string().nullable(),
});

export type Person = z.infer<typeof personSchema>;

export interface RawPerson {
  id?: string | null;
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  title?: string | null;
  seniority?: string | null;
  departments?: string[] | null;
  email?: string | null;
  email_status?: string | null;
  linkedin_url?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  organization?: RawOrganization | null;
  organization_name?: string | null;
}

const MAX_DEPARTMENTS = 5;

export function adaptPerson(p: RawPerson): Person {
  return {
    apolloId: p.id ?? null,
    name: p.name ?? ([p.first_name, p.last_name].filter(Boolean).join(' ') || null),
    firstName: p.first_name ?? null,
    lastName: p.last_name ?? null,
    title: p.title ?? null,
    seniority: p.seniority ?? null,
    departments: (p.departments ?? []).slice(0, MAX_DEPARTMENTS),
    workEmail: p.email ?? null,
    emailConfidence: p.email_status ?? null,
    linkedinUrl: p.linkedin_url ?? null,
    location: joinLocation(p.city, p.state, p.country),
    company: p.organization?.name ?? p.organization_name ?? null,
    companyDomain: p.organization?.primary_domain ?? null,
    companyWebsite: p.organization?.website_url ?? null,
  };
}
