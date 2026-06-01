import { z } from 'zod';
import { registerTool } from '../index';
import { hsFetch } from './client';

const Output = z.object({
  id: z.string(),
  email: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  phone: z.string().nullable(),
  jobTitle: z.string().nullable(),
  companyId: z.string().nullable(),
});

export const createContact = registerTool({
  id: 'hubspot.create_contact',
  description:
    'Create a HubSpot contact. Optionally associate it with a company. Call hubspot_search_contacts first to avoid duplicates — HubSpot throws 409 if the email already exists.',
  inputSchema: z.object({
    email: z.string().email(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    phone: z.string().optional(),
    jobTitle: z.string().optional(),
    companyId: z.string().optional(),
    ownerId: z.string().optional(),
  }),
  outputSchema: Output,
  requiresConfirmation: true,
  requiredScopes: [{ provider: 'hubspot', scopes: ['crm.objects.contacts.write'] }],
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const properties: Record<string, string> = { email: input.email };
    if (input.firstName !== undefined) properties.firstname = input.firstName;
    if (input.lastName !== undefined) properties.lastname = input.lastName;
    if (input.phone !== undefined) properties.phone = input.phone;
    if (input.jobTitle !== undefined) properties.jobtitle = input.jobTitle;
    if (input.ownerId !== undefined) properties.hubspot_owner_id = input.ownerId;

    type C = { id: string; properties: Record<string, string | null> };
    const contact = await hsFetch<C>(ctx, '/crm/v3/objects/contacts', {
      method: 'POST',
      body: JSON.stringify({ properties }),
    });

    if (input.companyId) {
      await hsFetch(ctx, `/crm/v4/associations/contacts/${contact.id}/companies/batch/create`, {
        method: 'POST',
        body: JSON.stringify({
          inputs: [
            {
              _from: { id: contact.id },
              to: { id: input.companyId },
              types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 279 }],
            },
          ],
        }),
      });
    }

    return {
      id: contact.id,
      email: contact.properties.email ?? null,
      firstName: contact.properties.firstname ?? null,
      lastName: contact.properties.lastname ?? null,
      phone: contact.properties.phone ?? null,
      jobTitle: contact.properties.jobtitle ?? null,
      companyId: input.companyId ?? null,
    };
  },
});
