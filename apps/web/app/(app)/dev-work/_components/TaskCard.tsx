import { Panel } from '@/components/ui/panel';
import {
  type DevTask,
  describeStatus,
  formatCost,
  formatDuration,
  isStoppable,
  isStopping,
  taskElapsedMs,
} from '@/lib/dev-work';
import { relativeTime } from '@/lib/relative-time';
import { CircleDollarSign, Clock, FolderGit2, GitPullRequest, UserRound } from 'lucide-react';
import Link from 'next/link';
import { StopButton } from './StopButton';

/**
 * One autonomous run, as a row in the list.
 *
 * Reads top to bottom as a sentence: what was asked, where, who asked, how it
 * is going. The branch name and the issue id are supporting detail, not the
 * headline — plenty of people watching this page have never opened a terminal.
 */
export function TaskCard({
  task,
  repository,
  requester,
}: {
  task: DevTask;
  repository: string | null;
  requester: string | null;
}) {
  const status = describeStatus(task);
  const elapsed = taskElapsedMs(task);
  const cost = formatCost(task.costUsd);
  const stopping = isStopping(task);

  return (
    <Panel className="p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1 basis-[20rem]">
          <div className="flex flex-wrap items-center gap-2">
            <span className={status.chip}>{status.label}</span>
            {task.issueKey && (
              <span className="rounded-pill border border-border bg-surface-2 px-2 py-0.5 font-mono text-micro font-semibold text-ink-muted">
                {task.issueKey}
              </span>
            )}
          </div>

          <Link
            href={`/dev-work/${task.id}`}
            className="mt-1.5 block text-base font-bold leading-snug text-ink transition-colors hover:text-primary"
          >
            {task.title}
          </Link>

          {task.status === 'failed' && task.failureReason && (
            <p className="mt-1.5 text-xs leading-snug text-rose">{task.failureReason}</p>
          )}

          <div className="tabular mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-micro text-ink-faint">
            {repository && (
              <span className="inline-flex items-center gap-1.5">
                <FolderGit2 className="h-3.5 w-3.5" />
                {repository}
              </span>
            )}
            {requester && (
              <span className="inline-flex items-center gap-1.5">
                <UserRound className="h-3.5 w-3.5" />
                {requester}
              </span>
            )}
            <span className="inline-flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5" />
              {task.startedAt
                ? `${task.finishedAt ? 'tomó' : 'lleva'} ${formatDuration(elapsed)} · empezó ${relativeTime(task.startedAt)}`
                : `pedido ${relativeTime(task.createdAt)}`}
            </span>
            {cost && (
              <span className="inline-flex items-center gap-1.5">
                <CircleDollarSign className="h-3.5 w-3.5" />
                {cost}
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {task.prUrl && (
            <a
              href={task.prUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1.5 rounded-pill border border-border-strong bg-surface px-2.5 py-1.5 text-xs font-semibold text-primary transition-colors hover:bg-primary-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <GitPullRequest className="h-3.5 w-3.5" />
              {task.prNumber ? `Revisar #${task.prNumber}` : 'Revisar el cambio'}
            </a>
          )}
          {(isStoppable(task) || stopping) && (
            <StopButton taskId={task.id} title={task.title} stopping={stopping} size="sm" />
          )}
        </div>
      </div>
    </Panel>
  );
}
