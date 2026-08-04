import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { clsx } from 'clsx';
import { AlarmClock } from 'lucide-react';
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
  const nextDueIn = nextDue ? (relative(nextDue.nextRunAt, Date.now()) ?? 'ya toca') : null;

  // Colour only where the figure means something: green for routines in force,
  // red for failures that need a look. A plain count stays in ink.
  const stats: Array<{ label: string; value: string; sub: string; tone?: 'emerald' | 'rose' }> = [
    {
      label: 'Rutinas activas',
      value: String(activeCount),
      sub: `${jobs.length} en total`,
      tone: activeCount > 0 ? 'emerald' : undefined,
    },
    { label: 'Rutinas globales', value: String(globalCount), sub: 'compartidas con el equipo' },
    {
      label: `Ejecuciones · ${WINDOW_DAYS}d`,
      value: String(recentRuns.length),
      sub: 'de las rutinas que ves',
    },
    {
      label: `Fallos · ${WINDOW_DAYS}d`,
      value: String(failures),
      sub: failures > 0 ? 'hay que mirarlos' : 'ninguno',
      tone: failures > 0 ? 'rose' : undefined,
    },
    {
      label: 'Próxima',
      value: nextDueIn ?? '—',
      sub: nextDue?.name ?? 'nada programado',
    },
  ];

  return (
    <>
      <PageHeader
        title="Rutinas"
        subtitle="Trabajos que Cortex ejecuta solo, a la hora que le digas. Los creas hablando en el chat. Las rutinas globales corren para todo el equipo y envían el resultado por correo."
        icon={<AlarmClock className="h-5 w-5" />}
        actions={<RefreshButton />}
      />

      <Panel className="mb-5 grid grid-cols-2 gap-px bg-border sm:grid-cols-3 lg:grid-cols-5">
        {stats.map((s) => (
          <div key={s.label} className="bg-surface px-4 py-3">
            <div className="field-label truncate" title={s.label}>
              {s.label}
            </div>
            <div
              className={clsx(
                'stat-num mt-1 truncate text-[20px] leading-none',
                s.tone === 'emerald' ? 'text-emerald' : s.tone === 'rose' ? 'text-rose' : 'text-ink',
              )}
              title={s.value}
            >
              {s.value}
            </div>
            <div className="mt-1 truncate text-[10.5px] text-ink-faint" title={s.sub}>
              {s.sub}
            </div>
          </div>
        ))}
      </Panel>

      <ScheduleList jobs={jobs} currentUserId={user.id} />
    </>
  );
}
