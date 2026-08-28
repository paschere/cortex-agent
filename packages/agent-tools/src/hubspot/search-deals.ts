import { z } from 'zod';
import { registerTool } from '../index';
import { hsFetch } from './client';

const DealOut = z.object({
  id: z.string(),
  name: z.string().nullable(),
  amount: z.number().nullable(),
  stage: z.string().nullable(),
  closeDate: z.string().nullable(),
  companyId: z.string().nullable(),
});

export const searchDeals = registerTool({
  id: 'hubspot.search_deals',
  description: 'Search HubSpot deals with optional filters: stage, ownerId, minAmount, maxAmount.',
  inputSchema: z.object({
    stage: z.string().optional(),
    ownerId: z.string().optional(),
    minAmount: z.number().optional(),
    maxAmount: z.number().optional(),
    limit: z.number().int().min(1).max(50).default(20),
  }),
  outputSchema: z.object({ results: z.array(DealOut) }),
  requiredScopes: [{ provider: 'hubspot', scopes: ['crm.objects.deals.read'] }],
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const filters: Array<{ propertyName: string; operator: string; value?: string }> = [];
    if (input.stage)
      filters.push({ propertyName: 'dealstage', operator: 'EQ', value: input.stage });
    if (input.ownerId)
      filters.push({ propertyName: 'hubspot_owner_id', operator: 'EQ', value: input.ownerId });
    if (input.minAmount != null)
      filters.push({ propertyName: 'amount', operator: 'GTE', value: String(input.minAmount) });
    if (input.maxAmount != null)
      filters.push({ propertyName: 'amount', operator: 'LTE', value: String(input.maxAmount) });
    type R = {
      results: Array<{
        id: string;
        properties: Record<string, string | null>;
        associations?: { companies?: { results: Array<{ id: string }> } };
      }>;
    };
    const data = await hsFetch<R>(ctx, '/crm/v3/objects/deals/search', {
      method: 'POST',
      body: JSON.stringify({
        filterGroups: filters.length ? [{ filters }] : [],
        properties: ['dealname', 'amount', 'dealstage', 'closedate'],
        sorts: [{ propertyName: 'hs_lastmodifieddate', direction: 'DESCENDING' }],
        limit: input.limit,
      }),
    });
    return {
      results: data.results.map((d) => ({
        id: d.id,
        name: d.properties.dealname ?? null,
        amount: d.properties.amount ? Number(d.properties.amount) : null,
        stage: d.properties.dealstage ?? null,
        closeDate: d.properties.closedate ?? null,
        companyId: d.associations?.companies?.results?.[0]?.id ?? null,
      })),
    };
  },
});
