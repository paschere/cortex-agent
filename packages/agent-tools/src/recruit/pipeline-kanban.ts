import { z } from 'zod';
import { registerTool } from '../index';
import { internalFetch, matcherFetch, qs } from './client';
import {
  SOURCE,
  type ToolMeta,
  buildMeta,
  metaFromServer,
  metaSchema,
  provenanceFooter,
} from './shape';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderMarkdown(stages: any[], jobLabel: string, totals: any, meta: ToolMeta): string {
  if (stages.length === 0) {
    return [`No client pipeline stages for ${jobLabel}.`, '', provenanceFooter(meta)].join('\n');
  }
  const lines: string[] = [];
  lines.push(`**Client pipeline — ${jobLabel}**`);
  if (totals) {
    lines.push(
      `${totals.presented ?? 0} presented · ${totals.accepted ?? 0} accepted · ${totals.rejected ?? 0} rejected · ${totals.awaitingClientFeedback ?? 0} awaiting client feedback`,
    );
  }
  for (const s of stages) {
    lines.push('');
    lines.push(`### ${s.name} (${s.count ?? s.candidates?.length ?? 0})`);
    for (const c of s.candidates ?? []) {
      const bits = [c.decision, c.sentiment ? `sentiment ${c.sentiment}` : null, c.billRate]
        .filter(Boolean)
        .join(' · ');
      lines.push(
        `- ${c.name}${bits ? ` — ${bits}` : ''}${c.awaitingClientFeedback ? ' _(no client feedback yet)_' : ''}`,
      );
    }
  }
  lines.push('');
  lines.push(provenanceFooter(meta));
  return lines.join('\n');
}

export const pipelineKanban = registerTool({
  id: 'recruit.pipeline_kanban',
  description:
    "Get a requisition's CLIENT-facing pipeline board: the client's stages and the candidates presented into each, with the client's decision, their sentiment, the bill rate quoted, and whether a card is still waiting on client feedback. Use it for \"where are we with the client on this role\" — recruit.list_candidates covers the internal pipeline instead. " +
    'Requires jobId. A requisition with no client linked has no board at all — the tool says so rather than returning an empty list you might misread as "nothing presented". ' +
    'PROVENANCE: stages and decisions come from the matcher service DB, recorded from the client\'s own review in the client portal — they are client feedback, never AI output. Cite the freshness from meta.fetchedAt, and relay meta.dataQuality: "no sentiment recorded" means no feedback yet, not negative feedback.',
  inputSchema: z.object({
    jobId: z.string().min(1),
  }),
  outputSchema: z.object({
    stages: z.array(z.any()),
    totals: z.any(),
    meta: metaSchema,
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input) => {
    const lean = await internalFetch<{
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      job: any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stages: any[];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      totals: any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      meta: any;
    }>(`/api/internal/recruit/kanban${qs({ jobId: input.jobId })}`);

    if (lean.available) {
      const meta = metaFromServer(lean.data.meta, '/api/internal/recruit/kanban');
      const label = lean.data.job?.title ? `"${lean.data.job.title}"` : `job ${input.jobId}`;
      return {
        stages: lean.data.stages,
        totals: lean.data.totals ?? null,
        meta,
        markdown: renderMarkdown(lean.data.stages, label, lean.data.totals, meta),
      };
    }

    // Fallback: the UI endpoint, which is gated on a browser session — a service
    // caller gets 401 there. Surfaced as a clear message instead of a raw error.
    const data = await matcherFetch(`/api/jobs/${encodeURIComponent(input.jobId)}/kanban`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawStages: any[] = Array.isArray(data?.kanban) ? data.kanban : [];
    const stages = rawStages.map((s) => ({
      id: s?.stage?.id ?? null,
      name: s?.stage?.name ?? '(stage)',
      position: s?.stage?.position ?? null,
      isTerminal: s?.stage?.isTerminal ?? null,
      count: Array.isArray(s?.presentations) ? s.presentations.length : 0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      candidates: (s?.presentations ?? []).map((p: any) => ({
        presentationId: p?.id ?? null,
        candidateId: p?.candidateId ?? null,
        name:
          [p?.candidateFirstName, p?.candidateLastName].filter(Boolean).join(' ') || '(candidate)',
        experienceYears: p?.totalExperienceYears ?? null,
        presentedAt: p?.presentedAt ?? null,
        decision: p?.companyDecision ?? null,
        sentiment: p?.sentimentAtStage ?? p?.clientSentiment ?? null,
        awaitingClientFeedback: !!p?.needsReview,
        billRate: p?.billRate ?? null,
      })),
    }));

    const meta = buildMeta({
      endpoint: `/api/jobs/${input.jobId}/kanban`,
      degraded: true,
      degradedReason: lean.reason,
      returned: stages.reduce((n, s) => n + s.count, 0),
      truncated: false,
      provenance: {
        'stages.*, decision, sentiment, billRate': `${SOURCE.matcher} — recorded from the client's own review in the client portal`,
      },
      dataQuality: [
        'Served from the session-gated UI endpoint; if it returned 401 the matcher requires a browser session and the lean service endpoint is not deployed yet.',
      ],
    });

    return {
      stages,
      totals: null,
      meta,
      markdown: renderMarkdown(stages, `job ${input.jobId}`, null, meta),
    };
  },
});
