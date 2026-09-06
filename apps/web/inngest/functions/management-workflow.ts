import { inngest } from '@/lib/inngest';
import type { JobContext, JobHandler } from '@/lib/jobs';
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
  return { dispatched: runs.length, moreMayRemain: runs.length === 500 };
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
