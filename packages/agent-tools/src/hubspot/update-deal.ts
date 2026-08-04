import { z } from 'zod';
import { renderDealCard } from '../format/index';
import { registerTool } from '../index';
import { hsFetch } from './client';

const Output = z.object({
  id: z.string(),
  name: z.string().nullable(),
  amount: z.number().nullable(),
  stage: z.string().nullable(),
  pipeline: z.string().nullable(),
  closeDate: z.string().nullable(),
  description: z.string().nullable(),
  ownerId: z.string().nullable(),
  markdown: z.string(),
});

export const updateDeal = registerTool({
  id: 'hubspot.update_deal',
  description:
    'Update properties on an existing HubSpot deal. At least one field must be provided.',
  inputSchema: z
    .object({
      id: z.string(),
      dealstage: z.string().optional(),
      amount: z.number().optional(),
      closedate: z.string().optional().describe('ISO date string YYYY-MM-DD'),
      ownerId: z.string().optional(),
      description: z.string().optional(),
    })
    .refine(
      (data) =>
        data.dealstage !== undefined ||
        data.amount !== undefined ||
        data.closedate !== undefined ||
        data.ownerId !== undefined ||
        data.description !== undefined,
      { message: 'At least one field to update must be provided' },
    ),
  outputSchema: Output,
  requiresConfirmation: true,
  requiredScopes: [{ provider: 'hubspot', scopes: ['crm.objects.deals.write'] }],
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const properties: Record<string, string> = {};
    if (input.dealstage !== undefined) properties.dealstage = input.dealstage;
    if (input.amount !== undefined) properties.amount = String(input.amount);
    if (input.closedate !== undefined) properties.closedate = input.closedate;
    if (input.ownerId !== undefined) properties.hubspot_owner_id = input.ownerId;
    if (input.description !== undefined) properties.description = input.description;

    type D = { id: string; properties: Record<string, string | null> };
    const deal = await hsFetch<D>(ctx, `/crm/v3/objects/deals/${input.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties }),
    });

    const out = {
      id: deal.id,
      name: deal.properties.dealname ?? null,
      amount: deal.properties.amount ? Number(deal.properties.amount) : null,
      stage: deal.properties.dealstage ?? null,
      pipeline: deal.properties.pipeline ?? null,
      closeDate: deal.properties.closedate ?? null,
      description: deal.properties.description ?? null,
      ownerId: deal.properties.hubspot_owner_id ?? null,
    };
    return { ...out, markdown: renderDealCard(out) };
  },
});
