import { z } from 'zod';
import { registerTool } from '../index';
import { matcherFetch } from './client';

export const listCandidates = registerTool({
  id: 'recruit.list_candidates',
  description:
    'List candidates matched/applied to a specific job in the zipdev-matcher recruitment system. Requires the jobId. Optionally cap the number returned with limit. Returns the candidate list plus a human-readable markdown summary.',
  inputSchema: z.object({
    jobId: z.string().min(1),
    limit: z.number().int().min(1).max(100).default(25),
  }),
  outputSchema: z.object({
    candidates: z.array(z.any()),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input) => {
    const data = await matcherFetch(`/api/candidates?jobId=${encodeURIComponent(input.jobId)}`);
    let candidates: any[] = Array.isArray(data) ? data : (data?.candidates ?? []);
    candidates = candidates.slice(0, input.limit);

    const markdown =
      candidates.length === 0
        ? `No candidates found for job ${input.jobId}.`
        : [
            `Found ${candidates.length} candidate(s) for job ${input.jobId}:`,
            ...candidates.map((c) => {
              const name =
                c?.name ??
                [c?.firstName, c?.lastName].filter(Boolean).join(' ') ??
                '(unnamed)';
              const score =
                typeof c?.combinedScore === 'number'
                  ? ` — score ${c.combinedScore}`
                  : typeof c?.matchScore === 'number'
                    ? ` — score ${c.matchScore}`
                    : '';
              const status = c?.status ? ` [${c.status}]` : '';
              return `- ${name || '(unnamed)'}${status}${score} (id: ${c?.id ?? 'n/a'})`;
            }),
          ].join('\n');

    return { candidates, markdown };
  },
});
