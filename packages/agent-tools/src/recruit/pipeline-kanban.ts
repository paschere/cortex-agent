import { z } from 'zod';
import { registerTool } from '../index';
import { matcherFetch } from './client';

export const pipelineKanban = registerTool({
  id: 'recruit.pipeline_kanban',
  description:
    "Get a job's client pipeline/kanban board from the zipdev-matcher recruitment system, grouped by pipeline stage. Requires jobId. Returns the stages (each with its presentations: candidate name, decision, sentiment, bill rate) plus a human-readable markdown summary. Note: this endpoint is session-gated in the matcher; if access is denied the error will surface the HTTP status.",
  inputSchema: z.object({
    jobId: z.string().min(1),
  }),
  outputSchema: z.object({
    stages: z.array(z.any()),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input) => {
    const data = await matcherFetch(`/api/jobs/${encodeURIComponent(input.jobId)}/kanban`);
    const stages: any[] = Array.isArray(data?.kanban) ? data.kanban : [];

    const markdown =
      stages.length === 0
        ? `No pipeline stages found for job ${input.jobId}.`
        : [
            `Pipeline for job ${input.jobId}:`,
            ...stages.map((s) => {
              const stage = s?.stage ?? {};
              const presentations: any[] = Array.isArray(s?.presentations) ? s.presentations : [];
              const header = `## ${stage?.name ?? '(stage)'} (${presentations.length})`;
              const items = presentations.map((p) => {
                const name =
                  [p?.candidateFirstName, p?.candidateLastName].filter(Boolean).join(' ') || '(candidate)';
                const decision = p?.companyDecision ? ` [${p.companyDecision}]` : '';
                const sentiment = p?.clientSentiment ? ` sentiment: ${p.clientSentiment}` : '';
                return `  - ${name}${decision}${sentiment}`;
              });
              return [header, ...items].join('\n');
            }),
          ].join('\n');

    return { stages, markdown };
  },
});
