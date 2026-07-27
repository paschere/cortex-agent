import { z } from 'zod';
import { registerTool } from '../index';
import { matcherFetch } from './client';
import { SOURCE, buildMeta, matcherLink, metaSchema, provenanceFooter } from './shape';

export const findMatches = registerTool({
  id: 'recruit.find_matches',
  description:
    "Kick off candidate matching for a requisition: starts an async run that scores the talent pool by skills, embedding similarity and cross-job signals. Results are NOT returned by this call — immediately follow up with recruit.wait_for_matches, which polls the run's real status server-side and returns the pool when it is genuinely finished. Use when a user asks to 'find candidates for' or 'match candidates to' a role. " +
    'PROVENANCE: everything this run produces is Zipdev AI scoring — derived signal, not Workable ATS data or client feedback. Say so when you present the shortlist. ' +
    "HOW TO PHRASE IT TO THE USER: plain human language only — say you're preparing the shortlist and it takes a couple of minutes, then OFFER to fetch results ('¿Quieres que revise si ya están listos?'). Never mention tool names, 'fire-and-forget', 'engines', or ids.",
  inputSchema: z.object({
    jobId: z.string().min(1),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  outputSchema: z.object({
    started: z.boolean(),
    matches: z.array(z.any()),
    meta: metaSchema,
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 10 },
  handler: async (input) => {
    const data = await matcherFetch(`/api/jobs/${encodeURIComponent(input.jobId)}/find-matches`, {
      method: 'POST',
    });
    const started = data?.success === true;

    const meta = buildMeta({
      endpoint: `/api/jobs/${input.jobId}/find-matches`,
      returned: 0,
      truncated: false,
      startedAt: new Date().toISOString(),
      links: { matcher: matcherLink(`/jobs/${input.jobId}`) },
      provenance: {
        'matching run + every score it writes': `${SOURCE.aiScoring} — derived, never an ATS field or client feedback`,
        'run status': `${SOURCE.matcher} — the run writes its own progress onto the job record`,
      },
      dataQuality: [
        'This call only STARTS the run; it returns no candidates. Anything you say about results before recruit.wait_for_matches reports state="completed" would be invented.',
      ],
    });

    const markdown = started
      ? [
          `**Matching started** for requisition \`${input.jobId}\`.`,
          '',
          'Scoring runs asynchronously (skills 50% + embedding similarity 30% + cross-job boost 20%). Call `recruit.wait_for_matches` next — it watches the run itself and tells you when it is really done.',
          '',
          provenanceFooter(meta),
        ].join('\n')
      : [
          `Matching request for requisition \`${input.jobId}\` returned an unexpected response: ${JSON.stringify(data).slice(0, 200)}`,
          '',
          provenanceFooter(meta),
        ].join('\n');

    return { started, matches: [], meta, markdown };
  },
});
