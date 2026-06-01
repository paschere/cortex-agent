import { z } from 'zod';
import { registerTool } from '../index';
import { hsFetch } from './client';

const Output = z.object({
  id: z.string(),
  name: z.string().nullable(),
  amount: z.number().nullable(),
  stage: z.string().nullable(),
  pipeline: z.string().nullable(),
  closeDate: z.string().nullable(),
  companyId: z.string().nullable(),
  contactId: z.string().nullable(),
});

export const createDeal = registerTool({
  id: 'hubspot.create_deal',
  description:
    'Create a HubSpot deal. Optionally associate it with a company and/or contact. Use hubspot_get_pipeline_summary to get valid stage IDs before calling.',
  inputSchema: z.object({
    dealname: z.string().min(1),
    pipeline: z.string().default('default'),
    dealstage: z.string().describe('Use hubspot_get_pipeline_summary to get valid stage IDs'),
    amount: z.number().optional(),
    closedate: z.string().optional().describe('ISO date string YYYY-MM-DD'),
    companyId: z.string().optional(),
    contactId: z.string().optional(),
    ownerId: z.string().optional(),
  }),
  outputSchema: Output,
  requiresConfirmation: true,
  requiredScopes: [{ provider: 'hubspot', scopes: ['crm.objects.deals.write'] }],
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const properties: Record<string, string> = {
      dealname: input.dealname,
      pipeline: input.pipeline ?? 'default',
      dealstage: input.dealstage,
    };
    if (input.amount !== undefined) properties.amount = String(input.amount);
    if (input.closedate !== undefined) properties.closedate = input.closedate;
    if (input.ownerId !== undefined) properties.hubspot_owner_id = input.ownerId;

    type D = { id: string; properties: Record<string, string | null> };
    const deal = await hsFetch<D>(ctx, '/crm/v3/objects/deals', {
      method: 'POST',
      body: JSON.stringify({ properties }),
    });

    if (input.companyId) {
      await hsFetch(ctx, `/crm/v4/associations/deals/${deal.id}/companies/batch/create`, {
        method: 'POST',
        body: JSON.stringify({
          inputs: [
            {
              _from: { id: deal.id },
              to: { id: input.companyId },
              types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 5 }],
            },
          ],
        }),
      });
    }
    if (input.contactId) {
      await hsFetch(ctx, `/crm/v4/associations/deals/${deal.id}/contacts/batch/create`, {
        method: 'POST',
        body: JSON.stringify({
          inputs: [
            {
              _from: { id: deal.id },
              to: { id: input.contactId },
              types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }],
            },
          ],
        }),
      });
    }

    return {
      id: deal.id,
      name: deal.properties.dealname ?? null,
      amount: deal.properties.amount ? Number(deal.properties.amount) : null,
      stage: deal.properties.dealstage ?? null,
      pipeline: deal.properties.pipeline ?? null,
      closeDate: deal.properties.closedate ?? null,
      companyId: input.companyId ?? null,
      contactId: input.contactId ?? null,
    };
  },
});
