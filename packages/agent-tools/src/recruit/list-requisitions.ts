import { z } from 'zod';
import { registerTool } from '../index';
import { matcherFetch } from './client';

export const listRequisitions = registerTool({
  id: 'recruit.list_requisitions',
  description:
    'List open jobs/requisitions from the zipdev-matcher recruitment system. Use to see what roles are open, their candidate counts and pipeline status. Optionally filter by status (e.g. "Active") or companyId, and cap the number returned with limit. Returns a list of requisitions plus a human-readable markdown summary.',
  inputSchema: z.object({
    status: z.string().optional(),
    companyId: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(25),
  }),
  outputSchema: z.object({
    requisitions: z.array(z.any()),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input) => {
    const data = await matcherFetch('/api/jobs');
    let jobs: any[] = Array.isArray(data) ? data : (data?.jobs ?? []);

    if (input.status) {
      const s = input.status.toLowerCase();
      jobs = jobs.filter((j) => String(j?.status ?? '').toLowerCase() === s);
    }
    if (input.companyId) {
      jobs = jobs.filter((j) => j?.companyId === input.companyId);
    }
    jobs = jobs.slice(0, input.limit);

    const markdown =
      jobs.length === 0
        ? 'No requisitions found.'
        : [
            `Found ${jobs.length} requisition(s):`,
            ...jobs.map((j) => {
              const company = j?.company ? ` @ ${j.company}` : '';
              const status = j?.status ? ` [${j.status}]` : '';
              const cands = typeof j?.candidates === 'number' ? ` — ${j.candidates} candidate(s)` : '';
              return `- ${j?.title ?? '(untitled)'}${company}${status}${cands} (id: ${j?.id ?? 'n/a'})`;
            }),
          ].join('\n');

    return { requisitions: jobs, markdown };
  },
});
