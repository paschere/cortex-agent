import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { classify, decide } from '../../security/policy';
import type { ToolContext } from '../../types';
import { apolloEnrichCompany } from '../enrich-company';
import { apolloEnrichPeople, apolloEnrichPerson } from '../enrich-person';
import { apolloFindCompanies } from '../find-companies';
import { apolloFindPeople } from '../find-people';

const fakeCtx = (): ToolContext =>
  ({
    userId: '00000000-0000-0000-0000-000000000001',
    agentId: '00000000-0000-0000-0000-000000000002',
    db: {} as never,
    integrations: {
      getAccessToken: async () => ({ token: 't', scopes: [] }),
      hasScopes: async () => true,
    },
    logger: {
      info: () => {},
      error: () => {},
      warn: () => {},
      debug: () => {},
      trace: () => {},
      fatal: () => {},
    },
  }) as unknown as ToolContext;

const PEOPLE_SEARCH = 'https://api.apollo.io/api/v1/mixed_people/api_search';
const PEOPLE_MATCH = 'https://api.apollo.io/api/v1/people/match';
const PEOPLE_BULK = 'https://api.apollo.io/api/v1/people/bulk_match';
const COMPANY_SEARCH = 'https://api.apollo.io/api/v1/mixed_companies/search';
const COMPANY_ENRICH = 'https://api.apollo.io/api/v1/organizations/enrich';

const RAW_ORG = {
  id: 'org_1',
  name: 'Acme Robotics',
  website_url: 'https://acme.com',
  primary_domain: 'acme.com',
  linkedin_url: 'https://linkedin.com/company/acme',
  industry: 'industrial automation',
  estimated_num_employees: 240,
  founded_year: 2014,
  city: 'Austin',
  state: 'Texas',
  country: 'United States',
  short_description: 'Builds warehouse robots.',
  annual_revenue_printed: '45M',
  total_funding_printed: '120M',
  latest_funding_stage: 'Series C',
  latest_funding_round_date: '2025-11-04',
  // Deliberately longer than the cap, plus fields that must never survive into
  // the model-facing payload.
  technology_names: Array.from({ length: 40 }, (_, i) => `tech_${i}`),
  keywords: Array.from({ length: 30 }, (_, i) => `kw_${i}`),
  logo_url: 'https://cdn.apollo.io/logo.png',
  org_chart_root_people_ids: ['a', 'b'],
  suborganizations: [{ id: 'x', name: 'Acme EU' }],
};

const server = setupServer(
  http.post(PEOPLE_SEARCH, () =>
    HttpResponse.json({
      total_entries: 812,
      people: [
        {
          id: 'p_1',
          first_name: 'Ada',
          last_name_obfuscated: 'L.',
          title: 'VP of Engineering',
          last_refreshed_at: '2026-06-01T00:00:00Z',
          has_email: true,
          has_direct_phone: false,
          organization: { name: 'Acme Robotics' },
        },
        {
          id: 'p_2',
          first_name: 'Grace',
          last_name_obfuscated: 'H.',
          title: 'Head of Talent',
          has_email: false,
          has_direct_phone: 'true',
          organization: { name: 'Acme Robotics' },
        },
        // No id — Apollo occasionally returns placeholder rows; they are dropped.
        { first_name: 'Ghost' },
      ],
    }),
  ),
  http.post(PEOPLE_MATCH, () =>
    HttpResponse.json({
      request_id: 1,
      person: {
        id: 'p_1',
        name: 'Ada Lovelace',
        first_name: 'Ada',
        last_name: 'Lovelace',
        title: 'VP of Engineering',
        seniority: 'vp',
        departments: ['engineering'],
        email: 'ada@acme.com',
        email_status: 'verified',
        linkedin_url: 'https://linkedin.com/in/ada',
        city: 'Austin',
        state: 'Texas',
        country: 'United States',
        organization: RAW_ORG,
        photo_url: 'https://cdn.apollo.io/ada.png',
      },
    }),
  ),
  http.post(PEOPLE_BULK, () =>
    HttpResponse.json({
      matches: [
        { id: 'p_1', name: 'Ada Lovelace', email: 'ada@acme.com', email_status: 'verified' },
        null,
        { id: 'p_3', name: 'Alan Turing', email: 'alan@acme.com', email_status: 'verified' },
      ],
    }),
  ),
  http.post(COMPANY_SEARCH, () =>
    HttpResponse.json({
      pagination: { page: 1, per_page: 10, total_entries: 57, total_pages: 6 },
      organizations: [RAW_ORG],
      accounts: [],
    }),
  ),
  http.get(COMPANY_ENRICH, () => HttpResponse.json({ organization: RAW_ORG })),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());
beforeEach(() => {
  server.resetHandlers();
  process.env.APOLLO_API_KEY = 'test-key';
});
afterEach(() => {
  process.env.APOLLO_API_KEY = '';
});

describe('Apollo tools — not configured', () => {
  beforeEach(() => {
    process.env.APOLLO_API_KEY = '';
  });

  it('people search reports itself unconfigured instead of throwing', async () => {
    const out = await apolloFindPeople.handler(
      { titles: ['VP of Engineering'], includeSimilarTitles: true, limit: 10, page: 1 },
      fakeCtx(),
    );
    expect(out.configured).toBe(false);
    expect(out.people).toEqual([]);
    expect(out.reason).toMatch(/not connected/i);
  });

  it('every tool fails soft with a human sentence', async () => {
    const results = await Promise.all([
      apolloEnrichPerson.handler({ email: 'ada@acme.com' }, fakeCtx()),
      apolloEnrichPeople.handler({ people: [{ email: 'ada@acme.com' }] }, fakeCtx()),
      apolloFindCompanies.handler({ name: 'Acme', limit: 10, page: 1 }, fakeCtx()),
      apolloEnrichCompany.handler({ domain: 'acme.com' }, fakeCtx()),
    ]);
    for (const out of results) {
      expect(out.configured).toBe(false);
      expect(out.reason).toBeTruthy();
      // A sentence a non-technical person can read — no env var names, no codes.
      expect(out.reason).not.toMatch(/APOLLO_API_KEY|undefined|Error/);
    }
  });
});

describe('Apollo tools — successful parses', () => {
  it('find_people returns compact matches and withholds contact details', async () => {
    const out = await apolloFindPeople.handler(
      { titles: ['VP of Engineering'], includeSimilarTitles: true, limit: 10, page: 1 },
      fakeCtx(),
    );
    expect(out.configured).toBe(true);
    expect(out.reason).toBeNull();
    expect(out.totalFound).toBe(812);
    expect(out.people).toHaveLength(2);
    expect(out.people[0]).toEqual({
      apolloId: 'p_1',
      firstName: 'Ada',
      lastNameMasked: 'L.',
      title: 'VP of Engineering',
      company: 'Acme Robotics',
      hasWorkEmail: true,
      hasDirectPhone: false,
      lastVerifiedAt: '2026-06-01T00:00:00Z',
    });
    // Apollo ships has_direct_phone as a boolean or a string.
    expect(out.people[1]?.hasDirectPhone).toBe(true);
    expect(out.source.provider).toBe('Apollo.io');
    expect(out.source.retrievedAt).toBeTruthy();
    // The free search must never leak an address; that is what credits buy.
    expect(JSON.stringify(out)).not.toContain('@');
  });

  it('find_people sends the filters as repeated query parameters', async () => {
    let seen = '';
    server.use(
      http.post(PEOPLE_SEARCH, ({ request }) => {
        seen = new URL(request.url).search;
        return HttpResponse.json({ total_entries: 0, people: [] });
      }),
    );
    await apolloFindPeople.handler(
      {
        titles: ['VP of Engineering', 'CTO'],
        seniorities: ['vp', 'c_suite'],
        companyDomains: ['acme.com'],
        includeSimilarTitles: true,
        limit: 5,
        page: 2,
      },
      fakeCtx(),
    );
    expect(seen).toContain('person_titles%5B%5D=VP+of+Engineering');
    expect(seen).toContain('person_titles%5B%5D=CTO');
    expect(seen).toContain('person_seniorities%5B%5D=vp');
    expect(seen).toContain('q_organization_domains_list%5B%5D=acme.com');
    expect(seen).toContain('per_page=5');
    expect(seen).toContain('page=2');
  });

  it('enrich_person returns the work email with its confidence and provenance', async () => {
    const out = await apolloEnrichPerson.handler({ email: 'ada@acme.com' }, fakeCtx());
    expect(out.found).toBe(true);
    expect(out.person?.workEmail).toBe('ada@acme.com');
    expect(out.person?.emailConfidence).toBe('verified');
    expect(out.person?.company).toBe('Acme Robotics');
    expect(out.person?.companyDomain).toBe('acme.com');
    expect(out.person?.location).toBe('Austin, Texas, United States');
    expect(out.source.dataset).toMatch(/enrichment/i);
    // The raw person carries a photo and a ~200-field organization; neither
    // belongs in a model-facing payload.
    expect(JSON.stringify(out)).not.toContain('photo_url');
    expect(JSON.stringify(out).length).toBeLessThan(1500);
  });

  it('enrich_person never asks Apollo for phone numbers or personal emails', async () => {
    let seen = '';
    server.use(
      http.post(PEOPLE_MATCH, ({ request }) => {
        seen = new URL(request.url).search;
        return HttpResponse.json({ person: null });
      }),
    );
    await apolloEnrichPerson.handler({ email: 'ada@acme.com' }, fakeCtx());
    expect(seen).not.toContain('reveal_phone_number');
    expect(seen).not.toContain('reveal_personal_emails');
    expect(seen).not.toContain('run_waterfall');
  });

  it('enrich_person reports a miss without pretending it cost anything', async () => {
    server.use(http.post(PEOPLE_MATCH, () => HttpResponse.json({ person: null })));
    const out = await apolloEnrichPerson.handler({ email: 'nobody@acme.com' }, fakeCtx());
    expect(out.found).toBe(false);
    expect(out.person).toBeNull();
    expect(out.reason).toMatch(/no credit was spent/i);
  });

  it('enrich_people counts credits against matches only and drops vague entries', async () => {
    const out = await apolloEnrichPeople.handler(
      {
        people: [
          { email: 'ada@acme.com' },
          { name: 'Alan Turing', companyDomain: 'acme.com' },
          // Only a first name: too vague to be worth a request.
          { firstName: 'Someone' },
        ],
      },
      fakeCtx(),
    );
    expect(out.requested).toBe(3);
    expect(out.skipped).toBe(1);
    expect(out.found).toBe(2);
    expect(out.creditsUsed).toBe(2);
    expect(out.people.map((p) => p.workEmail)).toEqual(['ada@acme.com', 'alan@acme.com']);
    expect(out.reason).toMatch(/not have enough detail/i);
  });

  it('enrich_people sends the batch in the body and spends nothing when all entries are vague', async () => {
    let body: unknown;
    server.use(
      http.post(PEOPLE_BULK, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ matches: [] });
      }),
    );
    const vague = await apolloEnrichPeople.handler({ people: [{ firstName: 'X' }] }, fakeCtx());
    expect(vague.creditsUsed).toBe(0);
    expect(body).toBeUndefined();

    await apolloEnrichPeople.handler({ people: [{ email: 'ada@acme.com' }] }, fakeCtx());
    expect(body).toEqual({ details: [{ email: 'ada@acme.com' }] });
  });

  it('find_companies projects firmographics and caps the long list fields', async () => {
    const out = await apolloFindCompanies.handler({ name: 'Acme', limit: 10, page: 1 }, fakeCtx());
    expect(out.totalFound).toBe(57);
    expect(out.companies).toHaveLength(1);
    const c = out.companies[0];
    expect(c?.domain).toBe('acme.com');
    expect(c?.employees).toBe(240);
    expect(c?.location).toBe('Austin, Texas, United States');
    expect(c?.latestFundingStage).toBe('Series C');
    expect(c?.technologies).toHaveLength(15);
    expect(c?.keywords).toHaveLength(10);
    expect(out.guidance).toMatch(/credit/i);
    expect(JSON.stringify(out)).not.toContain('suborganizations');
  });

  it('find_companies treats saved accounts as results too', async () => {
    server.use(
      http.post(COMPANY_SEARCH, () =>
        HttpResponse.json({
          pagination: { total_entries: 1, total_pages: 1 },
          organizations: [],
          accounts: [RAW_ORG],
        }),
      ),
    );
    const out = await apolloFindCompanies.handler({ name: 'Acme', limit: 10, page: 1 }, fakeCtx());
    expect(out.companies).toHaveLength(1);
  });

  it('enrich_company returns the firmographic profile', async () => {
    const out = await apolloEnrichCompany.handler({ domain: 'acme.com' }, fakeCtx());
    expect(out.found).toBe(true);
    expect(out.company?.name).toBe('Acme Robotics');
    expect(out.company?.totalFunding).toBe('120M');
    expect(out.source.provider).toBe('Apollo.io');
  });
});

describe('Apollo tools — rate limits and exhausted credits', () => {
  it('a 429 comes back as a sentence, not an exception', async () => {
    server.use(
      http.post(PEOPLE_SEARCH, () =>
        HttpResponse.json({ error: 'too many requests' }, { status: 429 }),
      ),
    );
    const out = await apolloFindPeople.handler(
      { titles: ['CTO'], includeSimilarTitles: true, limit: 10, page: 1 },
      fakeCtx(),
    );
    expect(out.configured).toBe(true);
    expect(out.people).toEqual([]);
    expect(out.reason).toMatch(/rate-limiting/i);
    expect(out.reason).not.toMatch(/429|stack|Error/);
  });

  it('an exhausted credit balance is explained in plain language', async () => {
    server.use(
      http.post(PEOPLE_MATCH, () =>
        HttpResponse.json({ error: 'insufficient credits' }, { status: 422 }),
      ),
    );
    const out = await apolloEnrichPerson.handler({ email: 'ada@acme.com' }, fakeCtx());
    expect(out.found).toBe(false);
    expect(out.reason).toMatch(/credit balance/i);
  });

  it('a 402 on company enrichment reads as a billing problem', async () => {
    server.use(http.get(COMPANY_ENRICH, () => new HttpResponse(null, { status: 402 })));
    const out = await apolloEnrichCompany.handler({ domain: 'acme.com' }, fakeCtx());
    expect(out.company).toBeNull();
    expect(out.reason).toMatch(/credit balance/i);
  });

  it('a rejected key blames the key, not the user', async () => {
    server.use(http.post(COMPANY_SEARCH, () => new HttpResponse(null, { status: 401 })));
    const out = await apolloFindCompanies.handler({ name: 'Acme', limit: 10, page: 1 }, fakeCtx());
    expect(out.configured).toBe(true);
    expect(out.reason).toMatch(/rejected our key/i);
  });

  it('a bulk lookup that is rate-limited reports zero credits used', async () => {
    server.use(http.post(PEOPLE_BULK, () => new HttpResponse(null, { status: 429 })));
    const out = await apolloEnrichPeople.handler(
      { people: [{ email: 'ada@acme.com' }] },
      fakeCtx(),
    );
    expect(out.creditsUsed).toBe(0);
    expect(out.found).toBe(0);
    expect(out.reason).toMatch(/rate-limiting/i);
  });
});

describe('Apollo tools — security classification', () => {
  const at = (id: string, input: unknown, surface: 'web' | 'schedule' = 'web') =>
    classify({
      tool: { id },
      input,
      ctx: { now: new Date(Date.UTC(2026, 0, 1, 17, 0, 0)) },
      surface,
    });

  it('treats Apollo as personal data', () => {
    const c = at('apollo.find_people', { titles: ['CTO'] });
    expect(c.sensitivity).toBe('pii');
    expect(c.blastRadius).toBe('read');
    expect(decide(c)).toBe('allow');
  });

  it('gates a batch contact export behind a human', () => {
    const c = at('apollo.enrich_people', { people: [{ email: 'ada@acme.com' }] });
    expect(c.blastRadius).toBe('bulk');
    expect(c.riskLevel).toBe('high');
    expect(decide(c)).toBe('confirm');
  });

  it('refuses a batch contact export running unattended', () => {
    const c = at('apollo.enrich_people', { people: [{ email: 'ada@acme.com' }] }, 'schedule');
    expect(c.riskLevel).toBe('critical');
    expect(decide(c)).toBe('block');
  });
});
