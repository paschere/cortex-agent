import { QUIET_AFTER_MS } from '@/lib/orchestrator/liveness';
import type { RunStatus, TaskStatus } from '@/lib/orchestrator/types';
import { CHIP_BASE, CHIP_TONE, DOT_TONE, type StatusTone } from '@/lib/status-chip';
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
  planning: { label: 'Planeando', tone: 'primary' },
  running: { label: 'Ejecutando', tone: 'primary' },
  completed: { label: 'Terminada', tone: 'emerald' },
  failed: { label: 'Falló', tone: 'rose' },
  cancelled: { label: 'Detenida', tone: 'neutral' },
  // Amber, not rose: nobody has to fix anything, but somebody should know the
  // run stopped talking and its report was never written.
  interrupted: { label: 'Se interrumpió', tone: 'amber' },
};

export const TASK_TONE: Record<
  TaskStatus,
  { label: string; tone: StatusTone; ring: string; icon: typeof Circle }
> = {
  pending: { label: 'En espera', tone: 'neutral', ring: 'border-border', icon: Circle },
  running: { label: 'Trabajando', tone: 'primary', ring: 'border-primary', icon: Loader2 },
  completed: { label: 'Listo', tone: 'emerald', ring: 'border-emerald/50', icon: CircleCheckBig },
  failed: { label: 'Falló', tone: 'rose', ring: 'border-rose/50', icon: CircleX },
  skipped: { label: 'Omitido', tone: 'neutral', ring: 'border-border', icon: CircleSlash },
};

/**
 * The run's state, and — while it claims to be working — whether it has said
 * anything lately.
 *
 * A live run that has gone quiet stops being drawn as "Ejecutando". The sweep
 * has not closed it yet and might never (it could come back), so the chip does
 * not assert an ending; it drops the claim and reports the silence instead.
 * Saying "Ejecutando" over something that has not moved in ten minutes is the
 * exact lie this whole change exists to remove, and the sweep's threshold is
 * five times the screen's — so for most of that window the screen is the only
 * thing that can tell the truth.
 *
 * @param quietMs how long the run has been silent (lib/orchestrator/liveness.ts
 *   `silenceMs`), or null when the question does not apply.
 */
export function RunStatusPill({
  status,
  quietMs = null,
  className,
}: { status: RunStatus; quietMs?: number | null; className?: string }) {
  const quiet = quietMs !== null && quietMs >= QUIET_AFTER_MS;
  if (quiet) {
    return (
      <span className={clsx(CHIP_BASE, CHIP_TONE.amber, className)}>
        <span className={clsx('h-1.5 w-1.5 rounded-full', DOT_TONE.amber)} />
        Sin señales hace {formatDuration(quietMs)}
      </span>
    );
  }

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

/** The task's state as a small soft-cornered badge, sized to sit beside its sequence number. */
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
