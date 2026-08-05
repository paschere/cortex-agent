import { inngest } from '@/lib/inngest';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { computeNextRun } from '@cortex/agent-tools';
import { logger } from '@cortex/core';

/**
 * Scheduled-jobs dispatcher. Runs every minute, claims due jobs, and emits one
 * `scheduled/job.run` event per claimed job (executed by schedule-run.ts).
 *
 * Claiming is optimistic: we UPDATE the row's next_run_at (advanced to the
 * following cron occurrence, or NULL for one-offs) guarded by
 * `eq(next_run_at, <the due value we read>)`. If a concurrent dispatcher
 * already advanced it, zero rows match and we skip — each due occurrence is
 * dispatched at most once.
 *
 * WHY THIS ONE HOLDS A RAW, UNSCOPED CLIENT. "Every routine due in the next
 * minute" is a question about the whole install; there is no workspace to scope
 * it to, and there is no session behind a cron. The isolation happens one step
 * later and is the reason `organization_id` is read here: each event carries the
 * workspace of the job it names, and schedule-run loads that job through a
 * client pinned to it. A job id from workspace A arriving with workspace B
 * therefore finds nothing, instead of running B's routine on A's data.
 *
 * The dispatcher itself writes only to `scheduled_jobs.next_run_at`, always
 * `.eq('id', …)`, so an unscoped handle here cannot move a row between tenants.
 */
export const scheduleDispatch = inngest.createFunction(
  { id: 'schedule-dispatch' },
  { cron: '* * * * *' },
  async ({ step }) => {
    const due = await step.run('claim-due-jobs', async () => {
      const db = getSupabaseServiceClient();
      const nowIso = new Date().toISOString();
      const { data, error } = await db
        .from('scheduled_jobs')
        .select('id, organization_id, schedule_kind, cron, timezone, next_run_at')
        .eq('status', 'active')
        .lte('next_run_at', nowIso)
        .not('next_run_at', 'is', null)
        .limit(100);
      if (error) throw new Error(`Failed to scan due jobs: ${error.message}`);

      const claimed: { jobId: string; organizationId: string; scheduledFor: string }[] = [];
      for (const job of data ?? []) {
        const jobId = job.id as string;
        const organizationId = job.organization_id as string;
        const dueAt = job.next_run_at as string;
        let next: string | null = null;
        if (job.schedule_kind === 'cron') {
          try {
            next = computeNextRun(job.cron as string, job.timezone as string).toISOString();
          } catch (err) {
            // Unparseable cron (shouldn't happen post-create-validation): park the
            // job as paused instead of hot-looping on it every minute.
            logger.error('schedule-dispatch: bad cron, pausing job', {
              jobId,
              error: (err as Error).message,
            });
            await db
              .from('scheduled_jobs')
              .update({ status: 'paused', updated_at: nowIso })
              .eq('id', jobId);
            continue;
          }
        }

        const { data: won, error: claimErr } = await db
          .from('scheduled_jobs')
          .update({ next_run_at: next, updated_at: nowIso })
          .eq('id', jobId)
          .eq('status', 'active')
          .eq('next_run_at', dueAt)
          .select('id');
        if (claimErr) {
          logger.error('schedule-dispatch: claim failed', {
            jobId,
            error: claimErr.message,
          });
          continue;
        }
        if (won && won.length > 0) claimed.push({ jobId, organizationId, scheduledFor: dueAt });
      }
      return claimed;
    });

    if (due.length > 0) {
      await step.sendEvent(
        'dispatch-runs',
        due.map((d) => ({ name: 'scheduled/job.run' as const, data: d })),
      );
    }

    return { dispatched: due.length };
  },
);
