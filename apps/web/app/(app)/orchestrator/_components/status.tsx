import type { RunStatus, TaskStatus } from '@/lib/orchestrator/types';
import { clsx } from 'clsx';
import { Ban, Circle, CircleCheckBig, CircleSlash, CircleX, Loader2, Sparkles } from 'lucide-react';

/**
 * The one place run and task status turn into colour and words.
 *
 * Imported by both the server pages and the live console, so it stays free of
 * hooks and of server-only imports.
 */

export const RUN_TONE: Record<RunStatus, { label: string; chip: string; dot: string }> = {
  planning: { label: 'Planning', chip: 'bg-sky-soft text-sky', dot: 'bg-sky' },
  running: { label: 'Running', chip: 'bg-primary-soft text-primary', dot: 'bg-primary' },
  completed: { label: 'Completed', chip: 'bg-emerald-soft text-emerald', dot: 'bg-emerald' },
  failed: { label: 'Failed', chip: 'bg-rose-soft text-rose', dot: 'bg-rose' },
  cancelled: { label: 'Cancelled', chip: 'bg-surface-2 text-ink-faint', dot: 'bg-ink-faint' },
};

export const TASK_TONE: Record<
  TaskStatus,
  { label: string; chip: string; ring: string; icon: typeof Circle }
> = {
  pending: {
    label: 'Waiting',
    chip: 'bg-surface-2 text-ink-faint',
    ring: 'border-border',
    icon: Circle,
  },
  running: {
    label: 'Running',
    chip: 'bg-primary-soft text-primary',
    ring: 'border-primary/50',
    icon: Loader2,
  },
  completed: {
    label: 'Done',
    chip: 'bg-emerald-soft text-emerald',
    ring: 'border-emerald/40',
    icon: CircleCheckBig,
  },
  failed: {
    label: 'Failed',
    chip: 'bg-rose-soft text-rose',
    ring: 'border-rose/40',
    icon: CircleX,
  },
  skipped: {
    label: 'Skipped',
    chip: 'bg-surface-2 text-ink-faint',
    ring: 'border-border',
    icon: CircleSlash,
  },
};

export function RunStatusPill({ status, className }: { status: RunStatus; className?: string }) {
  const tone = RUN_TONE[status];
  const live = status === 'planning' || status === 'running';
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-pill px-2.5 py-1 text-[11.5px] font-bold',
        tone.chip,
        className,
      )}
    >
      <span className="relative flex h-1.5 w-1.5">
        {live && (
          <span
            className={clsx(
              'absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 motion-reduce:animate-none',
              tone.dot,
            )}
          />
        )}
        <span className={clsx('relative inline-flex h-1.5 w-1.5 rounded-full', tone.dot)} />
      </span>
      {tone.label}
    </span>
  );
}

export function TaskStatusIcon({ status }: { status: TaskStatus }) {
  const tone = TASK_TONE[status];
  const Icon = tone.icon;
  return (
    <span className={clsx('grid h-7 w-7 shrink-0 place-items-center rounded-[9px]', tone.chip)}>
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
