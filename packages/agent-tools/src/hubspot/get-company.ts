import { z } from 'zod';
import { registerTool } from '../index';
import { hsFetch } from './client';

const RecentDeal = z.object({
  id: z.string(),
  name: z.string().nullable(),
  amount: z.number().nullable(),
  stage: z.string().nullable(),
  closeDate: z.string().nullable(),
});

const Output = z.object({
  id: z.string(),
  name: z.string().nullable(),
  domain: z.string().nullable(),
  industry: z.string().nullable(),
  numEmployees: z.number().nullable(),
  country: z.string().nullable(),
  ownerId: z.string().nullable(),
  recentDeals: z.array(RecentDeal),
});

export const getCompany = registerTool({
  id: 'hubspot.get_company',
  description: 'Get full HubSpot company by id including recent deals associated.',
  inputSchema: z.object({ id: z.string() }),
  outputSchema: Output,
  requiredScopes: [
    { provider: 'hubspot', scopes: ['crm.objects.companies.read', 'crm.objects.deals.read'] },
  ],
  rateLimit: { perMinute: 60 },
  handler: async (input, ctx) => {
    type C = {
      id: string;
      properties: Record<string, string | null>;
      associations?: { deals?: { results: Array<{ id: string }> } };
    };
    const company = await hsFetch<C>(
      ctx,
      `/crm/v3/objects/companies/${input.id}?properties=name,domain,industry,numberofemployees,country,hubspot_owner_id&associations=deals`,
    );
    const dealIds = (company.associations?.deals?.results ?? []).slice(0, 5).map((d) => d.id);
    type D = { results: Array<{ id: string; properties: Record<string, string | null> }> };
    let recentDeals: Array<z.infer<typeof RecentDeal>> = [];
    if (dealIds.length) {
      const data = await hsFetch<D>(ctx, '/crm/v3/objects/deals/batch/read', {
        method: 'POST',
        body: JSON.stringify({
          properties: ['dealname', 'amount', 'dealstage', 'closedate'],
          inputs: dealIds.map((id) => ({ id })),
        }),
      });
      recentDeals = data.results.map((d) => ({
        id: d.id,
        name: d.properties.dealname ?? null,
        amount: d.properties.amount ? Number(d.properties.amount) : null,
        stage: d.properties.dealstage ?? null,
        closeDate: d.properties.closedate ?? null,
      }));
    }
    return {
      id: company.id,
      name: company.properties.name ?? null,
      domain: company.properties.domain ?? null,
      industry: company.properties.industry ?? null,
      numEmployees: company.properties.numberofemployees
        ? Number(company.properties.numberofemployees)
        : null,
      country: company.properties.country ?? null,
      ownerId: company.properties.hubspot_owner_id ?? null,
      recentDeals,
    };
  },
});
