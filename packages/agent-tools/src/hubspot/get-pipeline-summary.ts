import { z } from 'zod';
import { registerTool } from '../index';
import { hsFetch } from './client';

const StageOut = z.object({
  label: z.string(),
  stageId: z.string(),
  dealCount: z.number(),
  totalAmount: z.number(),
  probability: z.number(),
});

const Output = z.object({
  stages: z.array(StageOut),
  markdown: z.string(),
});

const MAX_PAGES = 10; // 200 deals/page → up to 2000 deals aggregated.

function renderPipelineSummary(stages: z.infer<typeof StageOut>[]): string {
  const header = '| Stage | Deals | Total USD | Probability |';
  const divider = '|---|---|---|---|';
  const rows = stages.map(
    (s) =>
      `| ${s.label} | ${s.dealCount} | $${s.totalAmount.toLocaleString()} | ${Math.round(s.probability * 100)}% |`,
  );
  return [header, divider, ...rows].join('\n');
}

export const getPipelineSummary = registerTool({
  id: 'hubspot.get_pipeline_summary',
  description:
    'Get a full pipeline health overview: per-stage deal count and total amount, plus stage labels and win probabilities. Aggregates up to 2000 deals.',
  inputSchema: z.object({ pipelineId: z.string().default('default') }),
  outputSchema: Output,
  requiredScopes: [
    { provider: 'hubspot', scopes: ['crm.objects.deals.read', 'crm.schemas.deals.read'] },
  ],
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    type Pipeline = {
      stages: Array<{ id: string; label: string; metadata?: { probability?: string } }>;
    };
    const pipeline = await hsFetch<Pipeline>(ctx, `/crm/v3/pipelines/deals/${input.pipelineId}`);

    // Aggregate deals across the pipeline, paging up to MAX_PAGES (2000 deals).
    type SearchR = {
      results: Array<{ id: string; properties: Record<string, string | null> }>;
      paging?: { next?: { after?: string } };
    };
    const counts = new Map<string, { dealCount: number; totalAmount: number }>();
    let after: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body: Record<string, unknown> = {
        filterGroups: [
          { filters: [{ propertyName: 'pipeline', operator: 'EQ', value: input.pipelineId }] },
        ],
        properties: ['dealstage', 'amount'],
        limit: 200,
      };
      if (after) body.after = after;
      const data = await hsFetch<SearchR>(ctx, '/crm/v3/objects/deals/search', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      for (const d of data.results) {
        const stage = d.properties.dealstage ?? 'unknown';
        const amount = d.properties.amount ? Number(d.properties.amount) : 0;
        const entry = counts.get(stage) ?? { dealCount: 0, totalAmount: 0 };
        entry.dealCount += 1;
        entry.totalAmount += Number.isFinite(amount) ? amount : 0;
        counts.set(stage, entry);
      }
      after = data.paging?.next?.after;
      if (!after) break;
    }

    const stages = pipeline.stages.map((s) => {
      const agg = counts.get(s.id) ?? { dealCount: 0, totalAmount: 0 };
      const probRaw = s.metadata?.probability;
      const probability = probRaw != null && probRaw !== '' ? Number(probRaw) : 0;
      return {
        label: s.label,
        stageId: s.id,
        dealCount: agg.dealCount,
        totalAmount: agg.totalAmount,
        probability: Number.isFinite(probability) ? probability : 0,
      };
    });

    return { stages, markdown: renderPipelineSummary(stages) };
  },
});
