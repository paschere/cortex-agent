import { inngest } from '@/lib/inngest';
import type { JobContext, JobHandler } from '@/lib/jobs';
import { notifyOperationAttention } from '@/lib/management/operation-attention';
import { notifyWorkflowAttention } from '@/lib/management/workflow-attention';
import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import { advanceCollectionWorkflow } from '@cortex/agent-tools';
import { z } from 'zod';

export const managementWorkflowDispatchJob: JobHandler = async ({ step }) => {
  // Install-wide discovery only. Every execution gets its own tenant-scoped handle.
  const runs = await step.run('due-workflows', async () => {
    const r = await getSupabaseServiceClient()
      .from('management_workflows')
      .select('id,organization_id')
      .in('state', ['ready', 'approval', 'waiting'])
      .lte('next_check_at', new Date().toISOString())
      .order('next_check_at')
      .limit(500);
    if (r.error) throw r.error;
    return r.data ?? [];
  });
  if (runs.length)
    await step.sendEvent(
      'advance-workflows',
      runs.map((r) => ({
        name: 'management/workflow.advance',
        data: { id: r.id, organizationId: r.organization_id },
      })),
    );
  // Discover IDs only; notice content is read with the company's scoped handle.
  let cycleCount = 0;
  let after = '';
  for (let page = 0; ; page++) {
    const cycles = await step.run(`active-cycles-${page}`, async () => {
      let query = getSupabaseServiceClient()
        .from('management_operations')
        .select('id,organization_id')
        .eq('state', 'active')
        .eq('data->>notifyInApp', 'true')
        .order('id')
        .limit(500);
      if (after) query = query.gt('id', after);
      const r = await query;
      if (r.error) throw r.error;
      return r.data ?? [];
    });
    if (cycles.length)
      await step.sendEvent(
        `review-cycles-${page}`,
        cycles.map((r) => ({
          name: 'management/operation.review',
          data: { id: r.id, organizationId: r.organization_id },
        })),
      );
    cycleCount += cycles.length;
    if (cycles.length < 500) break;
    const last = cycles.at(-1);
    if (!last) break;
    after = last.id;
  }
  return {
    dispatched: runs.length,
    cycles: cycleCount,
    moreMayRemain: runs.length === 500,
  };
};
export const managementWorkflowAdvanceJob: JobHandler = async ({ event, step }) => {
  const data = z
    .object({ id: z.string().uuid(), organizationId: z.string().min(1) })
    .parse(event.data);
  const run = await step.run('advance', () =>
    advanceCollectionWorkflow(getOrgScopedClient(data.organizationId), data.id),
  );
  await step.run('notify-attention', () =>
    notifyWorkflowAttention(getOrgScopedClient(data.organizationId), run),
  );
  return run;
};
export const managementWorkflowDispatch = inngest.createFunction(
  { id: 'management-workflow-dispatch' },
  { cron: '*/15 * * * *' },
  (ctx) => managementWorkflowDispatchJob(ctx as unknown as JobContext),
);
export const managementWorkflowAdvance = inngest.createFunction(
  { id: 'management-workflow-advance', concurrency: { limit: 5 } },
  { event: 'management/workflow.advance' },
  (ctx) => managementWorkflowAdvanceJob(ctx as unknown as JobContext),
);

export const managementOperationReviewJob: JobHandler = async ({ event, step }) => {
  const data = z
    .object({ id: z.string().uuid(), organizationId: z.string().min(1) })
    .parse(event.data);
  return step.run('notify-cycle', () =>
    notifyOperationAttention(getOrgScopedClient(data.organizationId), data.id),
  );
};
export const managementOperationReview = inngest.createFunction(
  { id: 'management-operation-review', concurrency: { limit: 5 } },
  { event: 'management/operation.review' },
  (ctx) => managementOperationReviewJob(ctx as unknown as JobContext),
);
