import { inngest } from '@/lib/inngest';
import type { JobContext, JobHandler } from '@/lib/jobs';
import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import { runLearningPass } from '@cortex/agent-tools';
import { logger } from '@cortex/core';

/**
 * Overnight, Cortex reads back how it was used and decides what to change.
 *
 * WHAT IT IS ALLOWED TO DECIDE. Only orderings: within a relevance band, this
 * fragment goes first, or last. It cannot move anything across the band, cannot
 * edit a document, and cannot make the system assert anything — those live in
 * `learning_proposals`, which this job also fills and which nothing on the
 * answering path reads. Migration 0083 has the reasoning; `learning/apply.ts`
 * has the fence.
 *
 * DISPATCHER PLUS PER-WORKSPACE EVENT, mirroring memory-derive.ts and
 * schedule-dispatch.ts. Two reasons, and the second is the one that matters
 * here more than anywhere else in the product. A failure is isolated to one
 * workspace and Inngest retries only that one. And the work itself never holds
 * a handle that can see two companies at once: `runLearningPass` takes a single
 * scoped client and no list of workspaces, so the module that generalises from
 * usage is structurally incapable of generalising across customers.
 *
 * The dispatcher's own scan is unscoped, as every cron dispatcher's is — it
 * reads `turn_contexts` for the workspace id and nothing else, and hands that
 * id to a scoped handle. There is no session behind a cron to scope it to.
 *
 * 04:20 in Bogotá: after the memory derivation at 02:00 and the turn-context
 * retention sweep at 03:40, so it reads the freshest history that has already
 * been tidied, and off the hour so it does not pile onto everything else.
 */
const LEARNING_CRON = '20 9 * * *';

/** How far back the dispatcher looks for a workspace that did anything. */
const ACTIVITY_WINDOW_MS = 36 * 60 * 60 * 1000;

/** El cuerpo, extraído a la firma de la cola nueva; `event` no se usa. */
export const learningPassDispatchJob: JobHandler = async ({ step }) => {
  const workspaces = await step.run('find-active-workspaces', async (): Promise<string[]> => {
    const db = getSupabaseServiceClient();
    const since = new Date(Date.now() - ACTIVITY_WINDOW_MS).toISOString();
    // A workspace where nobody asked anything has nothing new to learn from,
    // and skipping it costs nothing. `turn_contexts` rather than `messages`
    // because a turn with no retrieval is not evidence about any fragment.
    const { data, error } = await db
      .from('turn_contexts')
      .select('organization_id')
      .gte('created_at', since)
      .limit(20000);
    if (error) throw new Error(`Failed to scan recent turns: ${error.message}`);
    const seen = new Set<string>();
    for (const row of (data ?? []) as Array<{ organization_id: string }>) {
      if (row.organization_id) seen.add(row.organization_id);
    }
    return [...seen];
  });

  if (workspaces.length > 0) {
    await step.sendEvent(
      'learn-per-workspace',
      workspaces.map((organizationId) => ({
        name: 'learning/pass.workspace' as const,
        data: { organizationId },
      })),
    );
  }
  return { dispatched: workspaces.length };
};

export const learningPassDispatch = inngest.createFunction(
  { id: 'learning-pass-dispatch' },
  [{ event: 'learning/pass.dispatch' }, { cron: LEARNING_CRON }],
  async (ctx) => learningPassDispatchJob(ctx as unknown as JobContext),
);

export const learningPassWorkspaceJob: JobHandler = async ({ event, step }) => {
  const organizationId = event.data.organizationId as string;
  return await step.run('learn', async () => {
    const db = getOrgScopedClient(organizationId);
    const result = await runLearningPass(db, { organizationId });
    logger.info({ organizationId, ...result }, 'learning pass');
    return result;
  });
};

export const learningPassWorkspace = inngest.createFunction(
  // One at a time per workspace. Two concurrent passes would both read the same
  // window and both try to apply the same verdict; the unique index in 0083
  // would stop the damage, but one of them would fail loudly for no reason.
  { id: 'learning-pass-workspace', concurrency: { key: 'event.data.organizationId', limit: 1 } },
  { event: 'learning/pass.workspace' },
  async (ctx) => learningPassWorkspaceJob(ctx as unknown as JobContext),
);
