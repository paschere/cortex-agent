import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { AlarmClock, CircleAlert, Globe, Hourglass, Play, Zap } from 'lucide-react';
import { RefreshButton } from './_components/RefreshButton';
import { ScheduleList } from './_components/ScheduleList';
import { relative } from './_components/format';
import type { ScheduledJob } from './_components/types';

export const dynamic = 'force-dynamic';

const WINDOW_DAYS = 7;

export default async function SchedulesPage() {
  const user = await requireSession();
  const db = getSupabaseServiceClient();

  const { data: rows } = await db
    .from('scheduled_jobs')
    .select(
      'id, user_id, name, kind, tool_id, instruction, schedule_kind, cron, timezone, run_at, status, next_run_at, last_run_at, allow_unattended_writes, notify_email, conversation_id, recipients, is_global, scheduled_job_runs(id, status, started_at, finished_at, output, error)',
    )
    // Own routines + every global (team-wide) routine.
    .or(`user_id.eq.${user.id},is_global.eq.true`)
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
    recipients: ((r.recipients as string[] | null) ?? []).filter(Boolean),
    isGlobal: (r.is_global as boolean | null) ?? false,
    ownerId: r.user_id as string,
    runs: ((r.scheduled_job_runs as unknown as ScheduledJob['runs']) ?? []).slice(0, 10),
  }));

  // Run volume over the window, scoped to the routines this user can see.
  const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
  let recentRuns: Array<{ status: string }> = [];
  if (jobs.length > 0) {
    const { data } = await db
      .from('scheduled_job_runs')
      .select('status')
      .in(
        'job_id',
        jobs.map((j) => j.id),
      )
      .gte('started_at', since)
      .limit(5000);
    recentRuns = (data ?? []) as Array<{ status: string }>;
  }

  const activeCount = jobs.filter((j) => j.status === 'active').length;
  const globalCount = jobs.filter((j) => j.isGlobal).length;
  const failures = recentRuns.filter((r) => r.status === 'error').length;

  const nextDue = jobs
    .filter((j) => j.status === 'active' && j.nextRunAt)
    .sort(
      (a, b) =>
        new Date(a.nextRunAt as string).getTime() - new Date(b.nextRunAt as string).getTime(),
    )[0];
  const nextDueIn = nextDue ? (relative(nextDue.nextRunAt, Date.now()) ?? 'due now') : null;

  const stats = [
    {
      label: 'Active routines',
      value: String(activeCount),
      sub: `${jobs.length} total`,
      icon: Play,
      tone: 'primary' as const,
    },
    {
      label: 'Global routines',
      value: String(globalCount),
      sub: 'shared with the team',
      icon: Globe,
      tone: 'primary' as const,
    },
    {
      label: `Runs · ${WINDOW_DAYS}d`,
      value: String(recentRuns.length),
      sub: 'across visible routines',
      icon: Zap,
      tone: 'emerald' as const,
    },
    {
      label: `Failures · ${WINDOW_DAYS}d`,
      value: String(failures),
      sub: failures > 0 ? 'needs a look' : 'all clean',
      icon: CircleAlert,
      tone: failures > 0 ? ('rose' as const) : ('emerald' as const),
    },
    {
      label: 'Next due',
      value: nextDueIn ?? '—',
      sub: nextDue?.name ?? 'nothing scheduled',
      icon: Hourglass,
      tone: 'amber' as const,
    },
  ];

  const TONE: Record<'primary' | 'emerald' | 'amber' | 'rose', string> = {
    primary: 'bg-primary-soft text-primary',
    emerald: 'bg-emerald-soft text-emerald',
    amber: 'bg-amber-soft text-amber',
    rose: 'bg-rose-soft text-rose',
  };

  return (
    <>
      <PageHeader
        title="Routines"
        subtitle="Unattended jobs Zippy runs on schedule — created from any chat in plain words. Global routines run for the whole team and email their results."
        icon={<AlarmClock className="h-5 w-5" />}
        actions={<RefreshButton />}
      />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
        {stats.map((s) => (
          <Panel key={s.label} className="flex items-center gap-3 p-3.5">
            <span
              className={`grid h-9 w-9 shrink-0 place-items-center rounded-[10px] ${TONE[s.tone]}`}
            >
              <s.icon className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div
                className="truncate text-[15px] font-extrabold leading-tight text-ink"
                title={s.value}
              >
                {s.value}
              </div>
              <div className="truncate text-[10.5px] text-ink-faint" title={s.label}>
                {s.label}
              </div>
              <div className="truncate text-[10.5px] text-ink-faint" title={s.sub}>
                {s.sub}
              </div>
            </div>
          </Panel>
        ))}
      </div>

      <ScheduleList jobs={jobs} currentUserId={user.id} />
    </>
  );
}
