import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { IntegrationError } from '@cortex/core';
import { searchCompanies } from '../search-companies';
import { getCompany } from '../get-company';
import { searchDeals } from '../search-deals';
import { listRecentActivities } from '../list-recent-activities';
import type { ToolContext } from '../../types';

// biome-ignore lint/suspicious/noExplicitAny: test stub
const fakeCtx = (): ToolContext => ({
  userId: '00000000-0000-0000-0000-000000000001',
  agentId: '00000000-0000-0000-0000-000000000002',
  db: {} as never,
  integrations: { getAccessToken: async () => ({ token: 't', scopes: [] }), hasScopes: async () => true } as any,
  logger: { info: () => {}, error: () => {}, warn: () => {}, debug: () => {}, trace: () => {}, fatal: () => {} } as any,
});

const server = setupServer(
  http.post('https://api.hubapi.com/crm/v3/objects/companies/search', () =>
    HttpResponse.json({
      results: [
        {
          id: '101',
          properties: { name: 'Acme', domain: 'acme.com', industry: 'Tech', numberofemployees: '120', country: 'US' },
        },
      ],
    }),
  ),
  http.get('https://api.hubapi.com/crm/v3/objects/companies/:id', () =>
    HttpResponse.json({
      id: '101',
      properties: {
        name: 'Acme',
        domain: 'acme.com',
        industry: 'Tech',
        numberofemployees: '120',
        country: 'US',
        hubspot_owner_id: '7',
      },
      associations: { deals: { results: [{ id: '500' }] } },
    }),
  ),
  http.post('https://api.hubapi.com/crm/v3/objects/deals/batch/read', () =>
    HttpResponse.json({
      results: [
        {
          id: '500',
          properties: { dealname: 'Acme Q1', amount: '50000', dealstage: 'qualified', closedate: '2026-06-30' },
        },
      ],
    }),
  ),
  http.post('https://api.hubapi.com/crm/v3/objects/deals/search', () =>
    HttpResponse.json({
      results: [
        {
          id: '500',
          properties: { dealname: 'Acme Q1', amount: '50000', dealstage: 'qualified', closedate: '2026-06-30' },
          associations: { companies: { results: [{ id: '101' }] } },
        },
      ],
    }),
  ),
  // catch-all for activity type searches (emails, calls, notes, meetings, tasks)
  http.post('https://api.hubapi.com/crm/v3/objects/:type/search', () =>
    HttpResponse.json({ results: [] }),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());
beforeEach(() => server.resetHandlers());

describe('HubSpot tools', () => {
  it('search_companies parses results correctly', async () => {
    const out = await searchCompanies.handler({ query: 'Acme', limit: 5 }, fakeCtx());
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toEqual({
      id: '101',
      name: 'Acme',
      domain: 'acme.com',
      industry: 'Tech',
      numEmployees: 120,
      country: 'US',
    });
  });

  it('search_companies returns empty results', async () => {
    server.use(
      http.post('https://api.hubapi.com/crm/v3/objects/companies/search', () =>
        HttpResponse.json({ results: [] }),
      ),
    );
    const out = await searchCompanies.handler({ query: 'nonexistent', limit: 5 }, fakeCtx());
    expect(out.results).toHaveLength(0);
  });

  it('search_companies throws IntegrationError on network error', async () => {
    server.use(
      http.post('https://api.hubapi.com/crm/v3/objects/companies/search', () =>
        HttpResponse.json({ message: 'Server Error' }, { status: 500 }),
      ),
    );
    await expect(searchCompanies.handler({ query: 'Acme', limit: 5 }, fakeCtx())).rejects.toBeInstanceOf(
      IntegrationError,
    );
  });

  it('get_company returns recentDeals with correct amount', async () => {
    const out = await getCompany.handler({ id: '101' }, fakeCtx());
    expect(out.recentDeals).toHaveLength(1);
    expect(out.recentDeals[0]?.amount).toBe(50000);
    expect(out.ownerId).toBe('7');
  });

  it('search_deals applies filters and returns companyId association', async () => {
    const out = await searchDeals.handler({ stage: 'qualified', limit: 10 }, fakeCtx());
    expect(out.results).toHaveLength(1);
    expect(out.results[0]?.companyId).toBe('101');
    expect(out.results[0]?.amount).toBe(50000);
  });

  it('search_deals throws IntegrationError on 401', async () => {
    server.use(
      http.post('https://api.hubapi.com/crm/v3/objects/deals/search', () =>
        new HttpResponse(null, { status: 401 }),
      ),
    );
    await expect(searchDeals.handler({ limit: 10 }, fakeCtx())).rejects.toBeInstanceOf(IntegrationError);
  });

  it('list_recent_activities returns an array (empty from mock)', async () => {
    const out = await listRecentActivities.handler({ companyId: '101', days: 30, limit: 20 }, fakeCtx());
    expect(Array.isArray(out.results)).toBe(true);
  });
});
