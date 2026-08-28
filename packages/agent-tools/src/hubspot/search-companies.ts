import { z } from 'zod';
import { registerTool } from '../index';
import { hsFetch } from './client';

const CompanyOut = z.object({
  id: z.string(),
  name: z.string().nullable(),
  domain: z.string().nullable(),
  industry: z.string().nullable(),
  numEmployees: z.number().nullable(),
  country: z.string().nullable(),
});
const Output = z.object({ results: z.array(CompanyOut), markdown: z.string().optional() });

function renderCompanyCard(c: z.infer<typeof CompanyOut>): string {
  return [
    `**${c.name ?? 'Unknown company'}**`,
    c.domain ? `Domain: ${c.domain}` : '',
    c.industry ? `Industry: ${c.industry}` : '',
    c.numEmployees != null ? `Employees: ${c.numEmployees.toLocaleString()}` : '',
    c.country ? `Country: ${c.country}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export const searchCompanies = registerTool({
  id: 'hubspot.search_companies',
  description:
    'Search HubSpot companies by name or domain. Returns up to `limit` matches with key properties.',
  inputSchema: z.object({
    query: z.string().min(1),
    limit: z.number().int().min(1).max(20).default(10),
  }),
  outputSchema: Output,
  requiredScopes: [{ provider: 'hubspot', scopes: ['crm.objects.companies.read'] }],
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    type R = { results: Array<{ id: string; properties: Record<string, string | null> }> };
    // When the query looks like a domain (contains '.'), search name OR domain.
    // Separate filterGroups are OR'd together by HubSpot.
    const filterGroups = input.query.includes('.')
      ? [
          { filters: [{ propertyName: 'name', operator: 'CONTAINS_TOKEN', value: input.query }] },
          { filters: [{ propertyName: 'domain', operator: 'EQ', value: input.query }] },
        ]
      : [{ filters: [{ propertyName: 'name', operator: 'CONTAINS_TOKEN', value: input.query }] }];
    const body = {
      filterGroups,
      properties: ['name', 'domain', 'industry', 'numberofemployees', 'country'],
      limit: input.limit,
    };
    const data = await hsFetch<R>(ctx, '/crm/v3/objects/companies/search', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const results = data.results.map((c) => ({
      id: c.id,
      name: c.properties.name ?? null,
      domain: c.properties.domain ?? null,
      industry: c.properties.industry ?? null,
      numEmployees: c.properties.numberofemployees ? Number(c.properties.numberofemployees) : null,
      country: c.properties.country ?? null,
    }));
    return { results, markdown: results.map(renderCompanyCard).join('\n\n') };
  },
});
