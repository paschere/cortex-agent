import { z } from 'zod';
import { registerTool } from '../index';
import { hsFetch } from './client';

const Output = z.object({
  id: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  company: z.string().nullable(),
  jobTitle: z.string().nullable(),
  ownerId: z.string().nullable(),
  lastContacted: z.string().nullable(),
  lifecycleStage: z.string().nullable(),
  companyIds: z.array(z.string()),
  dealIds: z.array(z.string()),
  markdown: z.string(),
});

const PROPERTIES = [
  'firstname',
  'lastname',
  'email',
  'phone',
  'company',
  'jobtitle',
  'hubspot_owner_id',
  'hs_lastcontacted',
  'lifecyclestage',
];

function renderContactCard(c: {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  jobTitle: string | null;
  company: string | null;
  lastContacted: string | null;
}): string {
  return [
    `**${[c.firstName, c.lastName].filter(Boolean).join(' ') || 'Unknown contact'}**`,
    c.email ? `Email: ${c.email}` : '',
    c.jobTitle && c.company ? `${c.jobTitle} at ${c.company}` : '',
    c.lastContacted ? `Last contacted: ${c.lastContacted}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export const getContact = registerTool({
  id: 'hubspot.get_contact',
  description: 'Get a HubSpot contact by id, including associated companies and deals.',
  inputSchema: z.object({ id: z.string() }),
  outputSchema: Output,
  requiredScopes: [{ provider: 'hubspot', scopes: ['crm.objects.contacts.read', 'crm.objects.companies.read'] }],
  rateLimit: { perMinute: 60 },
  handler: async (input, ctx) => {
    type C = {
      id: string;
      properties: Record<string, string | null>;
      associations?: {
        companies?: { results: Array<{ id: string }> };
        deals?: { results: Array<{ id: string }> };
      };
    };
    const c = await hsFetch<C>(
      ctx,
      `/crm/v3/objects/contacts/${input.id}?properties=${PROPERTIES.join(',')}&associations=companies,deals`,
    );
    const contact = {
      id: c.id,
      firstName: c.properties.firstname ?? null,
      lastName: c.properties.lastname ?? null,
      email: c.properties.email ?? null,
      phone: c.properties.phone ?? null,
      company: c.properties.company ?? null,
      jobTitle: c.properties.jobtitle ?? null,
      ownerId: c.properties.hubspot_owner_id ?? null,
      lastContacted: c.properties.hs_lastcontacted ?? null,
    };
    return {
      ...contact,
      lifecycleStage: c.properties.lifecyclestage ?? null,
      companyIds: (c.associations?.companies?.results ?? []).map((r) => r.id),
      dealIds: (c.associations?.deals?.results ?? []).map((r) => r.id),
      markdown: renderContactCard(contact),
    };
  },
});
