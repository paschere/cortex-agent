import { z } from 'zod';
import { registerTool } from '../index';
import { matcherFetch } from './client';

export const findMatches = registerTool({
  id: 'recruit.find_matches',
  description:
    "Kick off the AI matching engine to find and recommend candidates for a job (requisition). This is a fire-and-forget operation: it starts an async matching run that scores candidates by skills, embedding similarity, and cross-job signals, then writes the ranked results into the job's sync status. The candidate list is NOT returned immediately by this call — use recruit.job_insights or the job detail to read results once matching completes. Use this when a user asks to 'find candidates for', 'match candidates to', or 'run sourcing for' a job.",
  inputSchema: z.object({
    jobId: z.string().min(1),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  outputSchema: z.object({
    matches: z.array(z.any()),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 10 },
  handler: async (input) => {
    const data = await matcherFetch(`/api/jobs/${input.jobId}/find-matches`, {
      method: 'POST',
    });

    const ok = data?.success === true;
    const markdown = ok
      ? `**Matching started for job \`${input.jobId}\`.**\n\nThe AI matching engine is now scoring candidates (skills 50% + embedding 30% + cross-job boost 20%). This runs asynchronously and the ranked results are written to the job's sync status — they are not returned by this call.\n\nTo see the recommended candidates once matching finishes, fetch the job's insights (\`recruit.job_insights\`) or the job detail and check its sync steps.`
      : `Matching request for job \`${input.jobId}\` returned an unexpected response: ${JSON.stringify(data).slice(0, 200)}`;

    return { matches: [], markdown };
  },
});
