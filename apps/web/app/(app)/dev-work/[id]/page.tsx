import { Panel } from '@/components/ui/panel';
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
import { getSupabaseServiceClient } from '@/lib/supabase/service';
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

const SECTION = 'text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint';

/** Absolute stamp, spelled out — this page is read after the fact. */
function stamp(ts: string | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const CHECK_TONE = {
  passed: { chip: 'bg-emerald-soft text-emerald', word: 'passed' },
  failed: { chip: 'bg-rose-soft text-rose', word: 'failed' },
  pending: { chip: 'bg-primary-soft text-primary', word: 'still running' },
  skipped: { chip: 'bg-surface-2 text-ink-faint', word: 'skipped' },
} as const;

export default async function DevWorkDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireSession();
  const { id } = await params;
  const db = getSupabaseServiceClient();

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
          <ArrowLeft className="h-3.5 w-3.5" /> Dev Work
        </Link>
      </div>

      <div className="mb-6 flex flex-wrap items-start gap-4">
        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-[14px] bg-gradient-to-br from-primary to-primary-strong text-white shadow-pop">
          <Hammer className="h-5 w-5" />
        </span>

        <div className="min-w-0 flex-1 basis-[18rem]">
          <h1 className="flex flex-wrap items-center gap-2 text-xl font-extrabold tracking-tight text-ink">
            {task.title}
            <span
              className={`rounded-pill px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wide ${status.chip}`}
            >
              {status.label}
            </span>
          </h1>
          <p className="mt-1 text-[13px] text-ink-muted">{status.blurb}</p>

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-faint">
            {repository && (
              <span className="inline-flex items-center gap-1.5">
                <FolderGit2 className="h-3.5 w-3.5" />
                {repository}
              </span>
            )}
            {requestedBy && (
              <span className="inline-flex items-center gap-1.5">
                <UserRound className="h-3.5 w-3.5" />
                Asked by {requestedBy}
              </span>
            )}
            <span className="inline-flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5" />
              {task.startedAt
                ? `${task.finishedAt ? 'Took' : 'Running for'} ${formatDuration(elapsed)}`
                : 'Not started yet'}
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
              className="inline-flex items-center gap-1.5 rounded-[10px] bg-primary px-3 py-1.5 text-[12px] font-semibold text-white shadow-pop transition hover:bg-primary-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <GitPullRequest className="h-3.5 w-3.5" />
              {task.prNumber ? `Review #${task.prNumber}` : 'Review the change'}
            </a>
          )}
          {(isStoppable(task) || stopping) && (
            <StopButton taskId={task.id} title={task.title} stopping={stopping} />
          )}
        </div>
      </div>

      {overdue && (
        <Panel className="mb-4 flex items-start gap-3 border-rose/30 bg-rose-soft p-4">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-rose" />
          <div className="text-[12.5px] text-ink">
            <p className="font-semibold text-rose">This run has not stood down yet</p>
            <p className="mt-0.5 text-ink-muted">
              {stoppedBy} asked it to stop {stamp(task.cancelRequestedAt)} and it is still going.
              Nothing new will be merged, but it is worth telling whoever looks after Zippy.
            </p>
          </div>
        </Panel>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <Panel className="p-5">
            <div className={`mb-3 ${SECTION}`}>What was asked</div>
            {task.request ? (
              <RunMarkdown className="rounded-[12px] bg-surface-2 px-3.5 py-3">
                {task.request}
              </RunMarkdown>
            ) : (
              <p className="text-[12.5px] text-ink-faint">
                Only the headline came across — the full request lives on the Linear issue.
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
                Open {task.issueKey ?? 'the issue'} in Linear
              </a>
            )}
          </Panel>

          {task.status === 'failed' && (
            <Panel className="p-5">
              <div className={`mb-3 ${SECTION}`}>What went wrong</div>
              <p className="rounded-[12px] border border-rose/20 bg-rose-soft px-3.5 py-3 text-[13.5px] leading-relaxed text-ink">
                {task.failureReason ??
                  'Zippy stopped before the work was done and did not say why. Nothing was merged.'}
              </p>
              {/* The technical detail is real and sometimes needed — it is just
                  never the first thing a person reads. */}
              {task.errorDetail && (
                <details className="group mt-3">
                  <summary className="cursor-pointer list-none text-[12px] font-semibold text-ink-faint transition-colors hover:text-ink">
                    Show the technical detail
                  </summary>
                  <pre className="scroll-slim mt-2 overflow-x-auto rounded-[12px] bg-surface-2 px-3.5 py-3 text-[11.5px] leading-[1.6] text-ink-muted">
                    {task.errorDetail}
                  </pre>
                </details>
              )}
            </Panel>
          )}

          <Panel className="p-5">
            <div className={`mb-3 ${SECTION}`}>What changed</div>
            {task.summary ? (
              <RunMarkdown>{task.summary}</RunMarkdown>
            ) : (
              <p className="text-[12.5px] text-ink-faint">
                {task.status === 'queued' || task.status === 'running'
                  ? 'Zippy writes this up when it finishes.'
                  : 'No write-up was recorded for this run.'}
              </p>
            )}
          </Panel>

          <Panel className="p-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className={SECTION}>Checks</div>
              {task.checks.length > 0 && (
                <span className="text-[11px] text-ink-faint">
                  {failedChecks.length > 0
                    ? `${failedChecks.length} of ${task.checks.length} failed`
                    : `${task.checks.length} run`}
                </span>
              )}
            </div>
            {task.checks.length === 0 ? (
              <p className="text-[12.5px] text-ink-faint">
                No automated checks were reported for this run.
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
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">
                        {check.name}
                      </span>
                      {check.url && (
                        <a
                          href={check.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="shrink-0 text-[11.5px] font-semibold text-primary hover:text-primary-strong"
                        >
                          details
                        </a>
                      )}
                      <span
                        className={`shrink-0 rounded-pill px-2 py-0.5 text-[10.5px] font-bold ${tone.chip}`}
                      >
                        {tone.word}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel className="p-4">
            <div className={`mb-2.5 ${SECTION}`}>Where the work lives</div>
            <ul className="space-y-2 text-[12.5px]">
              <li className="flex items-start gap-2">
                <FolderGit2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint" />
                <span className="min-w-0 break-words text-ink-muted">
                  {repository ?? 'No repository recorded'}
                </span>
              </li>
              <li className="flex items-start gap-2">
                <GitBranch className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint" />
                <span className="min-w-0 break-words font-mono text-[11.5px] text-ink-muted">
                  {task.branch ?? 'No branch yet'}
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
                  <span className="text-ink-muted">No pull request opened</span>
                )}
              </li>
            </ul>
          </Panel>

          <Panel className="p-4">
            <div className={`mb-2.5 ${SECTION}`}>Timeline</div>
            <ul className="space-y-2 text-[12.5px]">
              <li className="flex items-center justify-between gap-3">
                <span className="text-ink-muted">Asked</span>
                <span className="text-right font-semibold text-ink">{stamp(task.createdAt)}</span>
              </li>
              <li className="flex items-center justify-between gap-3">
                <span className="text-ink-muted">Started</span>
                <span className="text-right font-semibold text-ink">{stamp(task.startedAt)}</span>
              </li>
              <li className="flex items-center justify-between gap-3">
                <span className="text-ink-muted">Finished</span>
                <span className="text-right font-semibold text-ink">{stamp(task.finishedAt)}</span>
              </li>
              <li className="flex items-center justify-between gap-3 border-t border-border pt-2">
                <span className="text-ink-muted">Took</span>
                <span className="font-semibold text-ink">{formatDuration(elapsed)}</span>
              </li>
              {cost && (
                <li className="flex items-center justify-between gap-3">
                  <span className="text-ink-muted">Cost</span>
                  <span className="font-semibold text-ink">{cost}</span>
                </li>
              )}
            </ul>
          </Panel>

          {task.cancelRequestedAt && (
            <Panel className="p-4">
              <div className={`mb-2 ${SECTION}`}>Stopped by a person</div>
              <p className="text-[12.5px] leading-relaxed text-ink-muted">
                {stoppedBy} pulled the brake on {stamp(task.cancelRequestedAt)}.{' '}
                {task.status === 'cancelled'
                  ? 'Zippy stood down; nothing further was merged.'
                  : 'Zippy stands down after the step it is on.'}
              </p>
            </Panel>
          )}
        </div>
      </div>
    </>
  );
}
