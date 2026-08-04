import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { DEFAULT_CONCURRENCY } from '@/lib/orchestrator/executor';
import { listRuns } from '@/lib/orchestrator/repository';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { CircleCheckBig, Clock, ListTree, Network, Radio } from 'lucide-react';
import Link from 'next/link';
import { LaunchForm } from './_components/LaunchForm';
import { RunStatusPill, elapsedMs, formatDuration } from './_components/status';

export const dynamic = 'force-dynamic';

/** Relative stamp for the history list — these are read minutes or days later. */
function when(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days < 7 ? `${days}d ago` : new Date(iso).toLocaleDateString();
}

export default async function OrchestratorPage() {
  const user = await requireSession();
  const runs = await listRuns(getSupabaseServiceClient(), user.organization.id);

  const now = Date.now();
  const live = runs.filter((r) => r.status === 'planning' || r.status === 'running').length;
  const completed = runs.filter((r) => r.status === 'completed');
  const durations = completed
    .map((r) => elapsedMs(r.startedAt ?? r.createdAt, r.finishedAt, now))
    .filter((d): d is number => d !== null);
  const median =
    durations.length > 0
      ? ([...durations].sort((a, b) => a - b)[Math.floor(durations.length / 2)] ?? null)
      : null;
  const subAgents = runs.reduce((sum, r) => sum + r.taskCount, 0);

  const stats = [
    {
      label: 'Runs',
      value: String(runs.length),
      icon: ListTree,
      tone: 'bg-primary-soft text-primary',
    },
    { label: 'Live now', value: String(live), icon: Radio, tone: 'bg-sky-soft text-sky' },
    {
      label: 'Sub-agents dispatched',
      value: String(subAgents),
      icon: Network,
      tone: 'bg-primary-soft text-primary',
    },
    {
      label: 'Median run',
      value: formatDuration(median),
      icon: Clock,
      tone: 'bg-emerald-soft text-emerald',
    },
  ];

  return (
    <>
      <PageHeader
        title="Orchestrator"
        subtitle="Give it one objective. It plans a team of sub-agents, runs the independent ones side by side, and shows you every tool call as it happens."
        icon={<Network className="h-5 w-5" />}
      />

      <div className="mb-5">
        <LaunchForm concurrency={DEFAULT_CONCURRENCY} />
      </div>

      {runs.length > 0 && (
        <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {stats.map((s) => (
            <Panel key={s.label} className="flex items-center gap-3 p-3.5">
              <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-[10px] ${s.tone}`}>
                <s.icon className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <div className="truncate text-[15px] font-extrabold leading-tight text-ink">
                  {s.value}
                </div>
                <div className="truncate text-[10.5px] text-ink-faint">{s.label}</div>
              </div>
            </Panel>
          ))}
        </div>
      )}

      {runs.length === 0 ? (
        <Panel className="px-6 py-12 text-center">
          <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-[14px] bg-primary-soft text-primary">
            <Network className="h-5 w-5" />
          </span>
          <h2 className="text-[15px] font-bold text-ink">No runs yet</h2>
          <p className="mx-auto mt-1.5 max-w-md text-[13px] leading-relaxed text-ink-muted">
            Describe an objective above. Cortex will split it into two to eight specialists, run
            everything that does not depend on anything else at the same time, and write you a
            single report at the end.
          </p>
        </Panel>
      ) : (
        <Panel className="overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div className="text-[13px] font-semibold text-ink">History</div>
            <div className="text-[11px] text-ink-faint">{runs.length} runs</div>
          </div>
          <ul>
            {runs.map((run) => {
              const done = run.taskStatuses.filter((s) => s === 'completed').length;
              const duration = elapsedMs(run.startedAt ?? run.createdAt, run.finishedAt, now);
              return (
                <li key={run.id} className="border-b border-border last:border-b-0">
                  <Link
                    href={`/orchestrator/${run.id}`}
                    className="flex flex-col gap-2 px-4 py-3.5 transition-colors hover:bg-surface-2 focus:outline-none focus-visible:bg-surface-2 sm:flex-row sm:items-center sm:gap-4"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="line-clamp-2 text-[13.5px] font-semibold leading-snug text-ink">
                        {run.objective}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-faint">
                        <span>{when(run.createdAt)}</span>
                        {run.taskCount > 0 && (
                          <span className="inline-flex items-center gap-1">
                            <CircleCheckBig className="h-3 w-3" />
                            {done}/{run.taskCount} tasks
                          </span>
                        )}
                        <span className="inline-flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {formatDuration(duration)}
                        </span>
                        {run.totalTokens > 0 && (
                          <span className="tabular-nums">
                            {run.totalTokens.toLocaleString()} tokens
                          </span>
                        )}
                      </div>
                    </div>
                    <RunStatusPill
                      status={run.status}
                      className="shrink-0 self-start sm:self-auto"
                    />
                  </Link>
                </li>
              );
            })}
          </ul>
        </Panel>
      )}
    </>
  );
}
