import { z } from 'zod';
import { registerTool } from '../index';
import { hsFetch } from './client';

const ContactOut = z.object({
  id: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  company: z.string().nullable(),
  jobTitle: z.string().nullable(),
  ownerId: z.string().nullable(),
  lastContacted: z.string().nullable(),
});

const Output = z.object({
  results: z.array(ContactOut),
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
];

function adaptContact(c: { id: string; properties: Record<string, string | null> }): z.infer<
  typeof ContactOut
> {
  return {
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
}

function renderContactCard(c: z.infer<typeof ContactOut>): string {
  return [
    `**${[c.firstName, c.lastName].filter(Boolean).join(' ') || 'Unknown contact'}**`,
    c.email ? `Email: ${c.email}` : '',
    c.jobTitle && c.company ? `${c.jobTitle} at ${c.company}` : '',
    c.lastContacted ? `Last contacted: ${c.lastContacted}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export const searchContacts = registerTool({
  id: 'hubspot.search_contacts',
  description:
    'Search HubSpot contacts by name or email. Use before create_contact to avoid duplicates. Returns up to `limit` matches.',
  inputSchema: z.object({
    query: z.string().min(1),
    companyId: z.string().optional(),
    limit: z.number().int().min(1).max(20).default(10),
  }),
  outputSchema: Output,
  requiredScopes: [{ provider: 'hubspot', scopes: ['crm.objects.contacts.read'] }],
  rateLimit: { perMinute: 30 },
  requiresConfirmation: false,
  handler: async (input, ctx) => {
    type R = { results: Array<{ id: string; properties: Record<string, string | null> }> };
    // Email queries: single exact-match group. Name queries: OR across firstname/lastname.
    const baseGroups = input.query.includes('@')
      ? [{ filters: [{ propertyName: 'email', operator: 'EQ', value: input.query }] }]
      : [
          {
            filters: [
              { propertyName: 'firstname', operator: 'CONTAINS_TOKEN', value: input.query },
            ],
          },
          {
            filters: [{ propertyName: 'lastname', operator: 'CONTAINS_TOKEN', value: input.query }],
          },
        ];
    // filterGroups OR together; filters within a group AND. Scope each group by companyId when provided.
    const filterGroups = input.companyId
      ? baseGroups.map((g) => ({
          filters: [
            ...g.filters,
            {
              propertyName: 'associatedcompanyid',
              operator: 'EQ',
              value: input.companyId as string,
            },
          ],
        }))
      : baseGroups;
    const data = await hsFetch<R>(ctx, '/crm/v3/objects/contacts/search', {
      method: 'POST',
      body: JSON.stringify({ filterGroups, properties: PROPERTIES, limit: input.limit }),
    });
    const results = data.results.map(adaptContact);
    return { results, markdown: results.map(renderContactCard).join('\n\n') };
  },
});
