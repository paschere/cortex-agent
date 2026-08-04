import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { DEFAULT_CONCURRENCY } from '@/lib/orchestrator/executor';
import { listRuns } from '@/lib/orchestrator/repository';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { Network } from 'lucide-react';
import Link from 'next/link';
import { LaunchForm } from './_components/LaunchForm';
import { RunStatusPill, elapsedMs, formatDuration } from './_components/status';

export const dynamic = 'force-dynamic';

/** Relative stamp for the history list — these are read minutes or days later. */
function when(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'ahora';
  if (minutes < 60) return `hace ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours}h`;
  const days = Math.round(hours / 24);
  return days < 7 ? `hace ${days}d` : new Date(iso).toLocaleDateString('es-CO');
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

  const stats: Array<{ label: string; value: string; live?: boolean }> = [
    { label: 'Ejecuciones', value: String(runs.length) },
    { label: 'En vivo', value: String(live), live: live > 0 },
    { label: 'Subagentes lanzados', value: String(subAgents) },
    { label: 'Duración mediana', value: formatDuration(median) },
  ];

  return (
    <>
      <PageHeader
        title="Orquestador"
        subtitle="Dale un solo objetivo. Arma un equipo de subagentes, corre en paralelo los que no dependen de nadie y te muestra cada herramienta que ejecuta, en vivo."
        icon={<Network className="h-5 w-5" />}
      />

      <div className="mb-5">
        <LaunchForm concurrency={DEFAULT_CONCURRENCY} />
      </div>

      {runs.length > 0 && (
        <Panel className="mb-5 grid grid-cols-2 gap-px bg-border lg:grid-cols-4">
          {stats.map((s) => (
            <div key={s.label} className="bg-surface px-4 py-3">
              <div className="field-label flex items-center gap-1.5">
                {s.live && (
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary motion-reduce:animate-none" />
                )}
                {s.label}
              </div>
              <div className="stat-num mt-1 truncate text-[20px] leading-none text-ink">
                {s.value}
              </div>
            </div>
          ))}
        </Panel>
      )}

      {runs.length === 0 ? (
        <Panel className="px-6 py-12 text-center">
          <Network className="mx-auto mb-3 h-7 w-7 text-primary" />
          <h2 className="text-[15px] font-bold text-ink">Todavía no hay ejecuciones</h2>
          <p className="mx-auto mt-1.5 max-w-md text-[13px] leading-relaxed text-ink-muted">
            Describe un objetivo en el cuadro de arriba. Cortex lo reparte entre dos y ocho
            especialistas, corre al tiempo todo lo que no dependa de nada más y al final te escribe
            un solo informe.
          </p>
        </Panel>
      ) : (
        <Panel className="overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-border-strong px-4 py-3">
            <div className="field-label">Historial</div>
            <div className="tabular text-[11px] text-ink-faint">
              {runs.length} {runs.length === 1 ? 'ejecución' : 'ejecuciones'}
            </div>
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
                      <div className="tabular mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-faint">
                        <span>{when(run.createdAt)}</span>
                        {run.taskCount > 0 && (
                          <span>
                            {done}/{run.taskCount} tareas
                          </span>
                        )}
                        <span>{formatDuration(duration)}</span>
                        {run.totalTokens > 0 && (
                          <span>{run.totalTokens.toLocaleString()} tokens</span>
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
