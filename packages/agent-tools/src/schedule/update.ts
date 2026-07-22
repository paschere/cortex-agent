import { NotFoundError, ValidationError } from '@zipdev/core';
import { z } from 'zod';
import { registerTool } from '../index';
import { computeNextRun } from './recurrence';

/**
 * Pause, resume, or cancel one of the user's scheduled jobs. Resuming a cron
 * job recomputes next_run_at (the stored one may be in the past); resuming a
 * one-off requires its run_at to still be in the future.
 */
export const scheduleUpdate = registerTool({
  id: 'schedule.update',
  description:
    'Pause, resume, or cancel a scheduled job by id (find ids with schedule.list). Cancelling is permanent; pausing can be undone with resume.',
  inputSchema: z.object({
    jobId: z.string().uuid(),
    action: z.enum(['pause', 'resume', 'cancel']),
  }),
  outputSchema: z.object({
    jobId: z.string(),
    status: z.string(),
    nextRunAt: z.string().nullable(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const { data: job, error } = await ctx.db
      .from('scheduled_jobs')
      .select('id, status, schedule_kind, cron, timezone, run_at')
      .eq('id', input.jobId)
      .eq('user_id', ctx.userId)
      .maybeSingle();
    if (error) throw new Error(`Failed to load job: ${error.message}`);
    if (!job) throw new NotFoundError(`Scheduled job ${input.jobId} not found`);

    const status = job.status as string;
    let patch: Record<string, unknown>;

    if (input.action === 'cancel') {
      if (status === 'completed' || status === 'cancelled') {
        throw new ValidationError(`Job is already ${status}`);
      }
      patch = { status: 'cancelled', next_run_at: null };
    } else if (input.action === 'pause') {
      if (status !== 'active')
        throw new ValidationError(`Only active jobs can be paused (job is ${status})`);
      patch = { status: 'paused' };
    } else {
      // resume
      if (status !== 'paused')
        throw new ValidationError(`Only paused jobs can be resumed (job is ${status})`);
      if (job.schedule_kind === 'cron') {
        patch = {
          status: 'active',
          next_run_at: computeNextRun(job.cron as string, job.timezone as string).toISOString(),
        };
      } else {
        const runAt = new Date(job.run_at as string);
        if (runAt.getTime() <= Date.now()) {
          throw new ValidationError(
            "This one-off job's run time is already in the past; create a new job instead.",
          );
        }
        patch = { status: 'active', next_run_at: runAt.toISOString() };
      }
    }

    const { data: updated, error: updErr } = await ctx.db
      .from('scheduled_jobs')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', input.jobId)
      .eq('user_id', ctx.userId)
      .select('id, status, next_run_at')
      .single();
    if (updErr || !updated) throw new Error(`Failed to update job: ${updErr?.message}`);

    return {
      jobId: updated.id as string,
      status: updated.status as string,
      nextRunAt: (updated.next_run_at as string | null) ?? null,
    };
  },
});
