import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { ScheduleList, type ScheduledJob } from './_components/ScheduleList';

export default async function SchedulesPage() {
  const user = await requireSession();
  const db = getSupabaseServiceClient();

  const { data: rows } = await db
    .from('scheduled_jobs')
    .select(
      'id, name, kind, tool_id, instruction, schedule_kind, cron, timezone, run_at, status, next_run_at, last_run_at, allow_unattended_writes, notify_email, conversation_id, scheduled_job_runs(id, status, started_at, finished_at, output, error)',
    )
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .order('started_at', { referencedTable: 'scheduled_job_runs', ascending: false })
    .limit(10, { foreignTable: 'scheduled_job_runs' });

  const jobs: ScheduledJob[] = (rows ?? []).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    kind: r.kind as ScheduledJob['kind'],
    toolId: (r.tool_id as string | null) ?? null,
    instruction: (r.instruction as string | null) ?? null,
    scheduleKind: r.schedule_kind as ScheduledJob['scheduleKind'],
    cron: (r.cron as string | null) ?? null,
    timezone: r.timezone as string,
    runAt: (r.run_at as string | null) ?? null,
    status: r.status as ScheduledJob['status'],
    nextRunAt: (r.next_run_at as string | null) ?? null,
    lastRunAt: (r.last_run_at as string | null) ?? null,
    allowUnattendedWrites: r.allow_unattended_writes as boolean,
    notifyEmail: r.notify_email as boolean,
    conversationId: (r.conversation_id as string | null) ?? null,
    runs: ((r.scheduled_job_runs as unknown as ScheduledJob['runs']) ?? []).slice(0, 10),
  }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Scheduled Jobs</h1>
        <p className="text-sm text-neutral-500 mt-1">
          Jobs created from chat (&ldquo;every day at 9am, …&rdquo;) run unattended and post their
          results to a conversation. Ask an agent to create one with{' '}
          <code className="text-xs">schedule.create</code>.
        </p>
      </div>
      <ScheduleList jobs={jobs} />
    </div>
  );
}
