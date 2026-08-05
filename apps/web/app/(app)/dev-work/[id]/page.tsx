import { Panel } from '@/components/ui/panel';
import { Field } from '@/components/ui/provenance';
import { chipClass } from '@/lib/status-chip';
import {
  DEV_TASK_COLUMNS,
  describeStatus,
  formatCost,
  formatDuration,
  isStoppable,
  isStopping,
  stopIsOverdue,
  taskElapsedMs,
  toDevTask,
} from '@/lib/dev-work';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  ArrowLeft,
  CircleCheckBig,
  CircleDollarSign,
  CircleX,
  Clock,
  ExternalLink,
  FolderGit2,
  GitBranch,
  GitPullRequest,
  Hammer,
  Hourglass,
  TriangleAlert,
  UserRound,
} from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { RunMarkdown } from '../../schedules/_components/RunMarkdown';
import { StopButton } from '../_components/StopButton';

export const dynamic = 'force-dynamic';

const SECTION = 'field-label';

/** Absolute stamp, spelled out — this page is read after the fact. */
function stamp(ts: string | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('es-CO', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const CHECK_TONE = {
  passed: { tone: 'emerald', word: 'pasó' },
  failed: { tone: 'rose', word: 'falló' },
  pending: { tone: 'primary', word: 'corriendo' },
  skipped: { tone: 'neutral', word: 'omitida' },
} as const;

export default async function DevWorkDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireSession();
  const { id } = await params;
  const db = getOrgScopedClient(user.organization.id);

  const { data: row } = await db
    .from('dev_tasks')
    .select(DEV_TASK_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (!row) notFound();

  const task = toDevTask(row as unknown as Record<string, unknown>);
  const status = describeStatus(task);
  const stopping = isStopping(task);
  const overdue = stopIsOverdue(task);
  const elapsed = taskElapsedMs(task);
  const cost = formatCost(task.costUsd);

  const [{ data: repo }, { data: requester }, { data: stopper }] = await Promise.all([
    task.repositoryId
      ? db
          .from('dev_repositories')
          .select('name, full_name')
          .eq('id', task.repositoryId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    task.requestedBy
      ? db.from('users').select('name, email').eq('id', task.requestedBy).maybeSingle()
      : Promise.resolve({ data: null }),
    task.cancelRequestedBy
      ? db.from('users').select('name, email').eq('id', task.cancelRequestedBy).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const repository =
    ((repo?.full_name as string | null) ?? (repo?.name as string | null) ?? null) || null;
  const requestedBy =
    ((requester?.name as string | null) ?? (requester?.email as string | null) ?? null) ||
    task.requestedByName;
  const stoppedBy =
    ((stopper?.name as string | null) ?? (stopper?.email as string | null) ?? null) || 'a teammate';

  const failedChecks = task.checks.filter((c) => c.status === 'failed');

  return (
    <>
      <div className="mb-4">
        <Link
          href="/dev-work"
          className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-faint transition-colors hover:text-ink"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Trabajo de desarrollo
        </Link>
      </div>

      <div className="rule-double mb-6 flex flex-wrap items-start gap-4 pt-4">
        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-card border border-border bg-surface-2 text-primary">
          <Hammer className="h-5 w-5" />
        </span>

        <div className="min-w-0 flex-1 basis-[18rem]">
          <h1 className="flex flex-wrap items-center gap-2 text-xl font-extrabold tracking-tight text-ink">
            {task.title}
            <span className={status.chip}>{status.label}</span>
          </h1>
          <p className="mt-1 text-[13px] text-ink-muted">{status.blurb}</p>

          <div className="tabular mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-ink-faint">
            {repository && (
              <span className="inline-flex items-center gap-1.5">
                <FolderGit2 className="h-3.5 w-3.5" />
                {repository}
              </span>
            )}
            {requestedBy && (
              <span className="inline-flex items-center gap-1.5">
                <UserRound className="h-3.5 w-3.5" />
                Lo pidió {requestedBy}
              </span>
            )}
            <span className="inline-flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5" />
              {task.startedAt
                ? `${task.finishedAt ? 'Tomó' : 'Lleva'} ${formatDuration(elapsed)}`
                : 'Sin empezar'}
            </span>
            {cost && (
              <span className="inline-flex items-center gap-1.5">
                <CircleDollarSign className="h-3.5 w-3.5" />
                {cost}
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {task.prUrl && (
            <a
              href={task.prUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1.5 rounded-pill bg-primary px-3 py-1.5 text-[12px] font-semibold text-white transition-colors hover:bg-primary-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <GitPullRequest className="h-3.5 w-3.5" />
              {task.prNumber ? `Revisar #${task.prNumber}` : 'Revisar el cambio'}
            </a>
          )}
          {(isStoppable(task) || stopping) && (
            <StopButton taskId={task.id} title={task.title} stopping={stopping} />
          )}
        </div>
      </div>

      {overdue && (
        <Panel className="mb-4 flex items-start gap-3 border-rose/40 bg-rose-soft p-4">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-rose" />
          <div className="text-[12.5px] text-ink">
            <p className="font-semibold text-rose">Esta ejecución todavía no se detiene</p>
            <p className="mt-0.5 text-ink-muted">
              {stoppedBy} pidió detenerla el <span className="tabular">{stamp(task.cancelRequestedAt)}</span>{' '}
              y sigue corriendo. No se va a integrar nada nuevo, pero avísale a quien administra
              Cortex.
            </p>
          </div>
        </Panel>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <Panel className="p-5">
            <div className={`mb-3 ${SECTION}`}>Lo que se pidió</div>
            {task.request ? (
              <RunMarkdown className="rounded-sm border border-border bg-surface-2 px-3.5 py-3">
                {task.request}
              </RunMarkdown>
            ) : (
              <p className="text-[12.5px] text-ink-muted">
                Solo llegó el título. La petición completa está en el issue de Linear.
              </p>
            )}
            {task.issueUrl && (
              <a
                href={task.issueUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="mt-3 inline-flex items-center gap-1.5 text-[12px] font-semibold text-primary transition-colors hover:text-primary-strong"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Abrir {task.issueKey ?? 'el issue'} en Linear
              </a>
            )}
          </Panel>

          {task.status === 'failed' && (
            <Panel className="p-5">
              <div className={`mb-3 ${SECTION}`}>Qué salió mal</div>
              <p className="rounded-sm border border-rose/30 bg-rose-soft px-3.5 py-3 text-[13.5px] leading-relaxed text-ink">
                {task.failureReason ??
                  'Cortex se detuvo antes de terminar y no dijo por qué. No se integró nada.'}
              </p>
              {/* The technical detail is real and sometimes needed — it is just
                  never the first thing a person reads. */}
              {task.errorDetail && (
                <details className="group mt-3">
                  <summary className="cursor-pointer list-none text-[12px] font-semibold text-ink-muted transition-colors hover:text-ink">
                    Ver el detalle técnico
                  </summary>
                  <pre className="scroll-slim mt-2 overflow-x-auto rounded-sm border border-border bg-surface-2 px-3.5 py-3 font-mono text-[11px] leading-[1.6] text-ink-muted">
                    {task.errorDetail}
                  </pre>
                </details>
              )}
            </Panel>
          )}

          <Panel className="p-5">
            <div className={`mb-3 ${SECTION}`}>Qué cambió</div>
            {task.summary ? (
              <RunMarkdown>{task.summary}</RunMarkdown>
            ) : (
              <p className="text-[12.5px] text-ink-muted">
                {task.status === 'queued' || task.status === 'running'
                  ? 'Cortex escribe este resumen cuando termina.'
                  : 'No quedó ningún resumen de esta ejecución.'}
              </p>
            )}
          </Panel>

          <Panel className="p-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className={SECTION}>Pruebas automáticas</div>
              {task.checks.length > 0 && (
                <span className="tabular text-[11px] text-ink-faint">
                  {failedChecks.length > 0
                    ? `${failedChecks.length} de ${task.checks.length} fallaron`
                    : `${task.checks.length} corrieron`}
                </span>
              )}
            </div>
            {task.checks.length === 0 ? (
              <p className="text-[12.5px] text-ink-muted">
                No se reportó ninguna prueba automática para esta ejecución.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {task.checks.map((check) => {
                  const tone = CHECK_TONE[check.status];
                  return (
                    <li key={check.name} className="flex items-center gap-3 py-2">
                      {check.status === 'passed' ? (
                        <CircleCheckBig className="h-3.5 w-3.5 shrink-0 text-emerald" />
                      ) : check.status === 'failed' ? (
                        <CircleX className="h-3.5 w-3.5 shrink-0 text-rose" />
                      ) : (
                        <Hourglass className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                      )}
                      <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">
                        {check.name}
                      </span>
                      {check.url && (
                        <a
                          href={check.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="shrink-0 text-[11.5px] font-semibold text-primary hover:text-primary-strong"
                        >
                          detalle
                        </a>
                      )}
                      <span className={chipClass(tone.tone)}>{tone.word}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel className="p-4">
            <div className={`mb-2.5 ${SECTION}`}>Dónde vive el trabajo</div>
            <ul className="space-y-2 text-[12.5px]">
              <li className="flex items-start gap-2">
                <FolderGit2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint" />
                <span className="min-w-0 break-words font-mono text-[11.5px] text-ink-muted">
                  {repository ?? 'Sin repositorio registrado'}
                </span>
              </li>
              <li className="flex items-start gap-2">
                <GitBranch className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint" />
                <span className="min-w-0 break-words font-mono text-[11.5px] text-ink-muted">
                  {task.branch ?? 'Todavía sin rama'}
                </span>
              </li>
              <li className="flex items-start gap-2">
                <GitPullRequest className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint" />
                {task.prUrl ? (
                  <a
                    href={task.prUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="min-w-0 break-all font-semibold text-primary hover:text-primary-strong"
                  >
                    {task.prNumber ? `Pull request #${task.prNumber}` : 'Pull request'}
                  </a>
                ) : (
                  <span className="text-ink-muted">Sin pull request abierto</span>
                )}
              </li>
            </ul>
          </Panel>

          <Panel className="p-4">
            <div className={`mb-2.5 ${SECTION}`}>Línea de tiempo</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-3">
              <Field label="Pedido">{stamp(task.createdAt)}</Field>
              <Field label="Empezó">{stamp(task.startedAt)}</Field>
              <Field label="Terminó">{stamp(task.finishedAt)}</Field>
              <Field label="Duración">{formatDuration(elapsed)}</Field>
              {cost && <Field label="Costo">{cost}</Field>}
            </div>
          </Panel>

          {task.cancelRequestedAt && (
            <Panel className="p-4">
              <div className={`mb-2 ${SECTION}`}>Detenido por una persona</div>
              <p className="text-[12.5px] leading-relaxed text-ink-muted">
                {stoppedBy} pisó el freno el{' '}
                <span className="tabular">{stamp(task.cancelRequestedAt)}</span>.{' '}
                {task.status === 'cancelled'
                  ? 'Cortex se detuvo y no se integró nada más.'
                  : 'Cortex para después del paso en el que va.'}
              </p>
            </Panel>
          )}
        </div>
      </div>
    </>
  );
}
