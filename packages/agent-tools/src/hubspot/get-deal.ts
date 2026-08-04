import { z } from 'zod';
import { registerTool } from '../index';
import { hsFetch } from './client';

export const getDeal = registerTool({
  id: 'hubspot.get_deal',
  description: 'Get a HubSpot deal by id with full properties and associations (company, contacts).',
  inputSchema: z.object({ id: z.string() }),
  outputSchema: z.object({
    id: z.string(),
    name: z.string().nullable(),
    amount: z.number().nullable(),
    stage: z.string().nullable(),
    closeDate: z.string().nullable(),
    pipeline: z.string().nullable(),
    description: z.string().nullable(),
    companyIds: z.array(z.string()),
    contactIds: z.array(z.string()),
  }),
  requiredScopes: [{ provider: 'hubspot', scopes: ['crm.objects.deals.read'] }],
  rateLimit: { perMinute: 60 },
  handler: async (input, ctx) => {
    type D = {
      id: string;
      properties: Record<string, string | null>;
      associations?: {
        companies?: { results: Array<{ id: string }> };
        contacts?: { results: Array<{ id: string }> };
      };
    };
    const d = await hsFetch<D>(
      ctx,
      `/crm/v3/objects/deals/${input.id}?properties=dealname,amount,dealstage,closedate,pipeline,description&associations=companies,contacts`,
    );
    return {
      id: d.id,
      name: d.properties.dealname ?? null,
      amount: d.properties.amount ? Number(d.properties.amount) : null,
      stage: d.properties.dealstage ?? null,
      closeDate: d.properties.closedate ?? null,
      pipeline: d.properties.pipeline ?? null,
      description: d.properties.description ?? null,
      companyIds: (d.associations?.companies?.results ?? []).map((c) => c.id),
      contactIds: (d.associations?.contacts?.results ?? []).map((c) => c.id),
    };
  },
});
