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
            <span
              className={`rounded-pill px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wide ${status.chip}`}
            >
              {status.label}
            </span>
            {task.issueKey && (
              <span className="rounded-pill bg-surface-2 px-2 py-0.5 text-[10.5px] font-semibold text-ink-faint">
                {task.issueKey}
              </span>
            )}
          </div>

          <Link
            href={`/dev-work/${task.id}`}
            className="mt-1.5 block text-[14px] font-bold leading-snug text-ink transition-colors hover:text-primary"
          >
            {task.title}
          </Link>

          {task.status === 'failed' && task.failureReason && (
            <p className="mt-1.5 text-[12.5px] leading-snug text-rose">{task.failureReason}</p>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-ink-faint">
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
                ? `${task.finishedAt ? 'took' : 'running for'} ${formatDuration(elapsed)} · started ${relativeTime(task.startedAt)}`
                : `asked ${relativeTime(task.createdAt)}`}
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
              className="inline-flex items-center gap-1.5 rounded-[10px] border border-border bg-surface px-2.5 py-1.5 text-[12px] font-semibold text-primary shadow-card transition hover:bg-primary-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <GitPullRequest className="h-3.5 w-3.5" />
              {task.prNumber ? `Review #${task.prNumber}` : 'Review the change'}
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
