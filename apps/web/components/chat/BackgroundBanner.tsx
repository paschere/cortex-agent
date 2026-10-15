'use client';

import type { TaskBanner } from '@/lib/background-tasks/banner';
import { TASK_STATUS_LABEL, durationMs, formatTaskDuration } from '@/lib/background-tasks/status';
import { clsx } from 'clsx';
import { Loader2, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ShareReplay } from '../tareas/ShareReplay';
import { TaskApprovals } from '../tareas/TaskApprovals';

/**
 * LA FRANJA DE UNA TAREA EN SEGUNDO PLANO, justo encima del compositor.
 *
 * Trabajando: dice que sigue sola (se puede cerrar la pestaña), cuánto lleva y
 * cuántos pasos, con «Cancelar». Te necesita: trae los botones de aprobar. Al
 * terminar: una línea con el desenlace, y se va con la ×.
 */
export function BackgroundBanner({
  task,
  starting,
  error,
  onCancel,
  onDismiss,
  onDecided,
}: {
  task: TaskBanner | null;
  starting?: boolean;
  error?: string | null;
  onCancel: () => void;
  onDismiss: () => void;
  onDecided: () => void;
}) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => setNow(new Date()), []);
  const ticking = task?.status === 'working' || task?.status === 'queued';
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);

  if (!task && !starting && !error) return null;
  if (!task) {
    return (
      <div className="mx-auto w-full max-w-[45rem] shrink-0 px-4 sm:px-6" aria-live="polite">
        <p
          className={clsx(
            'mb-2 rounded-card border px-3.5 py-2 text-sm',
            error
              ? 'border-rose/30 bg-rose-soft text-rose'
              : 'border-border bg-surface-2 text-ink-muted',
          )}
        >
          {error ?? 'Pasando la tarea a segundo plano…'}
        </p>
      </div>
    );
  }

  const terminal =
    task.status === 'done' || task.status === 'failed' || task.status === 'cancelled';
  const elapsed = formatTaskDuration(
    task.finishedAt || now ? durationMs(task, now ?? new Date()) : null,
  );
  const tone =
    task.status === 'needs_you'
      ? 'border-amber/30 bg-amber-soft'
      : task.status === 'failed'
        ? 'border-rose/30 bg-rose-soft'
        : task.status === 'done'
          ? 'border-emerald/30 bg-emerald-soft'
          : 'border-primary/20 bg-primary-soft';

  return (
    <div className="mx-auto w-full max-w-[45rem] shrink-0 px-4 sm:px-6" aria-live="polite">
      <div className={clsx('mb-2 flex flex-col gap-2 rounded-card border px-3.5 py-2.5', tone)}>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
          {!terminal && task.status !== 'needs_you' && (
            <Loader2
              className="h-4 w-4 shrink-0 animate-spin text-primary motion-reduce:animate-none"
              aria-hidden
            />
          )}
          <p className="min-w-[13rem] flex-1 text-sm text-ink">
            <span className="font-semibold">{TASK_STATUS_LABEL[task.status]}</span>
            {task.status === 'working' || task.status === 'queued' ? (
              <>
                {' · '}sigue en segundo plano, puedes cerrar la pestaña
                <span className="tabular text-ink-muted">
                  {' '}
                  · {elapsed}
                  {task.stepsCount > 0 ? ` · ${task.stepsCount} pasos` : ''}
                </span>
              </>
            ) : task.status === 'needs_you' ? (
              <> · una acción espera tu visto bueno y la tarea sigue sola al responder</>
            ) : task.status === 'done' ? (
              <> · terminó en {elapsed}. El resultado y sus archivos están arriba y en la tarea</>
            ) : task.status === 'failed' ? (
              <> · {task.error ?? 'no pudo terminar'}</>
            ) : (
              <> · se detuvo</>
            )}
          </p>
          <Link
            href={`/tareas/${task.id}`}
            className="shrink-0 text-xs font-semibold text-primary-ink underline-offset-2 hover:underline"
          >
            Ver tarea
          </Link>
          {(task.status === 'done' || task.status === 'failed') && (
            <ShareReplay taskId={task.id} label="Compartir" />
          )}
          {!terminal && (
            <button
              type="button"
              onClick={onCancel}
              className="shrink-0 rounded-pill bg-surface px-3 py-1 text-xs font-semibold text-ink shadow-card transition-colors duration-150 hover:bg-surface-2 motion-reduce:transition-none"
            >
              Cancelar
            </button>
          )}
          {terminal && (
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Quitar este aviso"
              className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-ink-muted hover:bg-surface-2 hover:text-ink"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          )}
        </div>
        {task.status === 'needs_you' && (
          <TaskApprovals approvals={task.approvals} onDecided={onDecided} compact />
        )}
        {error && <p className="text-xs text-rose">{error}</p>}
      </div>
    </div>
  );
}
