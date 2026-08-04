import { type StatusTone, CHIP_BASE, CHIP_TONE, DOT_TONE } from '@/lib/status-chip';
import type { RunStatus, TaskStatus } from '@/lib/orchestrator/types';
import { clsx } from 'clsx';
import { Ban, Circle, CircleCheckBig, CircleSlash, CircleX, Loader2, Sparkles } from 'lucide-react';

/**
 * The one place run and task status turn into colour and words.
 *
 * Imported by both the server pages and the live console, so it stays free of
 * hooks and of server-only imports.
 *
 * Blue is the system at work, green a run that finished, red one that did not,
 * grey a run nothing has been asserted about yet.
 */

export const RUN_TONE: Record<RunStatus, { label: string; tone: StatusTone }> = {
  planning: { label: 'Planning', tone: 'primary' },
  running: { label: 'Running', tone: 'primary' },
  completed: { label: 'Completed', tone: 'emerald' },
  failed: { label: 'Failed', tone: 'rose' },
  cancelled: { label: 'Stopped', tone: 'neutral' },
};

export const TASK_TONE: Record<
  TaskStatus,
  { label: string; tone: StatusTone; ring: string; icon: typeof Circle }
> = {
  pending: { label: 'Waiting', tone: 'neutral', ring: 'border-border', icon: Circle },
  running: { label: 'Running', tone: 'primary', ring: 'border-primary', icon: Loader2 },
  completed: { label: 'Done', tone: 'emerald', ring: 'border-emerald/50', icon: CircleCheckBig },
  failed: { label: 'Failed', tone: 'rose', ring: 'border-rose/50', icon: CircleX },
  skipped: { label: 'Skipped', tone: 'neutral', ring: 'border-border', icon: CircleSlash },
};

export function RunStatusPill({ status, className }: { status: RunStatus; className?: string }) {
  const { label, tone } = RUN_TONE[status];
  const live = status === 'planning' || status === 'running';
  return (
    <span className={clsx(CHIP_BASE, CHIP_TONE[tone], className)}>
      <span className="relative flex h-1.5 w-1.5">
        {live && (
          <span
            className={clsx(
              'absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 motion-reduce:animate-none',
              DOT_TONE[tone],
            )}
          />
        )}
        <span className={clsx('relative inline-flex h-1.5 w-1.5 rounded-full', DOT_TONE[tone])} />
      </span>
      {label}
    </span>
  );
}

/** The task's state as a squared mark, sized to sit beside its sequence number. */
export function TaskStatusIcon({ status }: { status: TaskStatus }) {
  const { tone, icon: Icon } = TASK_TONE[status];
  return (
    <span
      className={clsx(
        'grid h-7 w-7 shrink-0 place-items-center rounded-sm border',
        CHIP_TONE[tone],
      )}
    >
      <Icon
        className={clsx(
          'h-4 w-4',
          status === 'running' && 'animate-spin motion-reduce:animate-none',
        )}
      />
    </span>
  );
}

/** Icons used by the empty/terminal states, re-exported so pages import one module. */
export { Ban, Sparkles };

/** "1m 12s" / "820ms" — compact, never negative. */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function elapsedMs(
  startedAt: string | null,
  finishedAt: string | null,
  now: number,
): number | null {
  if (!startedAt) return null;
  const start = new Date(startedAt).getTime();
  if (!Number.isFinite(start)) return null;
  const end = finishedAt ? new Date(finishedAt).getTime() : now;
  return Math.max(0, end - start);
}
