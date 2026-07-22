import { z } from 'zod';
import { registerTool } from '../index';

const JobSummary = z.object({
  jobId: z.string(),
  name: z.string(),
  kind: z.string(),
  toolId: z.string().nullable(),
  instruction: z.string().nullable(),
  scheduleKind: z.string(),
  cron: z.string().nullable(),
  timezone: z.string(),
  status: z.string(),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  allowUnattendedWrites: z.boolean(),
});

export const scheduleList = registerTool({
  id: 'schedule.list',
  description:
    "List the user's scheduled jobs with their status, schedule, and next/last run times. Use before pausing, resuming, or cancelling to find the jobId.",
  inputSchema: z.object({
    includeFinished: z
      .boolean()
      .default(false)
      .describe('Also include completed and cancelled jobs'),
  }),
  outputSchema: z.object({ jobs: z.array(JobSummary) }),
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    let q = ctx.db
      .from('scheduled_jobs')
      .select(
        'id, name, kind, tool_id, instruction, schedule_kind, cron, timezone, status, next_run_at, last_run_at, allow_unattended_writes',
      )
      .eq('user_id', ctx.userId)
      .order('created_at', { ascending: false })
      .limit(50);
    if (!input.includeFinished) q = q.in('status', ['active', 'paused']);

    const { data, error } = await q;
    if (error) throw new Error(`Failed to list scheduled jobs: ${error.message}`);

    return {
      jobs: (data ?? []).map((r) => ({
        jobId: r.id as string,
        name: r.name as string,
        kind: r.kind as string,
        toolId: (r.tool_id as string | null) ?? null,
        instruction: (r.instruction as string | null) ?? null,
        scheduleKind: r.schedule_kind as string,
        cron: (r.cron as string | null) ?? null,
        timezone: r.timezone as string,
        status: r.status as string,
        nextRunAt: (r.next_run_at as string | null) ?? null,
        lastRunAt: (r.last_run_at as string | null) ?? null,
        allowUnattendedWrites: r.allow_unattended_writes as boolean,
      })),
    };
  },
});
