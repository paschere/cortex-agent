import { z } from 'zod';
import { registerTool } from '../index';
import { matcherFetch } from './client';

export const listCompanies = registerTool({
  id: 'recruit.list_companies',
  description:
    'List active companies/clients from the zipdev-matcher recruitment system. Optionally cap the number returned with limit. Returns the company list plus a human-readable markdown summary.',
  inputSchema: z.object({
    limit: z.number().int().min(1).max(200).default(50),
  }),
  outputSchema: z.object({
    companies: z.array(z.any()),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input) => {
    const data = await matcherFetch('/api/companies');
    let companies: any[] = Array.isArray(data) ? data : (data?.companies ?? []);
    companies = companies.slice(0, input.limit);

    const markdown =
      companies.length === 0
        ? 'No companies found.'
        : [
            `Found ${companies.length} company/companies:`,
            ...companies.map((c) => {
              const industry = c?.industry ? ` (${c.industry})` : '';
              return `- ${c?.name ?? '(unnamed)'}${industry} (id: ${c?.id ?? 'n/a'})`;
            }),
          ].join('\n');

    return { companies, markdown };
  },
});
