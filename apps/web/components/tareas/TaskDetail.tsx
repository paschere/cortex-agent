'use client';

import { ChatMarkdown } from '@/components/chat/ChatMarkdown';
import { type TaskBanner, taskIsLive, toBanner } from '@/lib/background-tasks/banner';
import type { TaskFile } from '@/lib/background-tasks/files';
import { canCancelTask, canRetryTask } from '@/lib/background-tasks/scope';
import {
  TASK_CAP_MS,
  canCancel,
  canRetry,
  durationMs,
  formatTaskDuration,
} from '@/lib/background-tasks/status';
import { MessageSquare, RotateCcw, Square } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { FilesPanel } from './FilesPanel';
import { ShareReplay } from './ShareReplay';
import { TaskApprovals } from './TaskApprovals';
import { TaskCost } from './TaskCost';
import { TaskStatusChip } from './TaskStatusChip';

function when(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('es-CO', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/Bogota',
  })
    .format(d)
    .replace(/[\u202f\u00a0]/g, ' ');
}

const btn =
  'inline-flex items-center gap-1.5 rounded-pill bg-surface-2 px-3.5 py-1.5 text-xs font-semibold text-ink transition-colors duration-150 hover:bg-border disabled:opacity-50 motion-reduce:transition-none';

/**
 * LA PANTALLA DE UNA TAREA: estado y tiempos, lo que espera de ti, el resultado y
 * los archivos que produjo. Se vuelve a consultar sola mientras siga viva.
 */
export function TaskDetail({
  initial,
  owner,
  viewer,
  fixtureFiles,
  fixture,
}: {
  initial: TaskBanner & { userId: string };
  owner: string | null;
  viewer: { id: string; isManager: boolean };
  /** Pantallas de muestra: archivos fijos y nada de consultas. */
  fixtureFiles?: TaskFile[];
  fixture?: boolean;
}) {
  const [task, setTask] = useState<TaskBanner & { userId: string }>(initial);
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => setNow(new Date()), []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = taskIsLive(task);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/tasks/${task.id}`, { cache: 'no-store' });
      if (!res.ok) return;
      const body = (await res.json()) as { task?: Record<string, unknown> };
      if (body.task)
        setTask({
          ...toBanner(body.task),
          userId: String(body.task.userId ?? initial.userId),
        });
    } catch {
      // La próxima lo repone.
    }
  }, [task.id, initial.userId]);

  useEffect(() => {
    if (fixture || !live) return;
    const poll = setInterval(() => void load(), 4000);
    const tick = setInterval(() => setNow(new Date()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [live, fixture, load]);

  async function act(what: 'cancel' | 'retry') {
    if (fixture) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${task.id}/${what}`, { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        task?: { id: string };
      };
      if (!res.ok) {
        setError(body.error ?? 'No se pudo completar la acción.');
        return;
      }
      if (what === 'retry' && body.task?.id) window.location.assign(`/tareas/${body.task.id}`);
      else await load();
    } finally {
      setBusy(false);
    }
  }

  const duration = formatTaskDuration(
    task.finishedAt || now ? durationMs(task, now ?? new Date()) : null,
  );
  const capLeft =
    live && task.deadlineAt && task.status === 'working'
      ? now
        ? Math.max(0, new Date(task.deadlineAt).getTime() - now.getTime())
        : null
      : null;
  const ref = { userId: task.userId };

  return (
    <div className="flex flex-col gap-5">
      <section className="rounded-card border border-border bg-surface p-5 shadow-card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-balance text-lg font-semibold leading-snug text-ink">
              {task.title}
            </h2>
            {viewer.isManager && owner && (
              <p className="mt-0.5 text-xs text-ink-faint">
                {task.userId === viewer.id ? 'Tuya' : owner}
              </p>
            )}
          </div>
          <TaskStatusChip status={task.status} />
        </div>
        <dl className="tabular mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
          {[
            ['Inicio', when(task.startedAt)],
            ['Fin', when(task.finishedAt)],
            ['Duración', duration],
            ['Pasos', String(task.stepsCount)],
          ].map(([k, v]) => (
            <div key={k}>
              <dt className="field-label">{k}</dt>
              <dd className="mt-0.5 text-ink">{v}</dd>
            </div>
          ))}
        </dl>
        <TaskCost
          taskId={task.id}
          live={live}
          {...(fixture ? { fixtureLine: '$ 3.870 · 41.200 tokens' } : {})}
        />
        {capLeft !== null && (
          <p className="mt-3 text-xs text-ink-faint">
            Tope de la tarea: {formatTaskDuration(TASK_CAP_MS)} de trabajo; le quedan{' '}
            {formatTaskDuration(capLeft)}.
          </p>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {task.conversationId && (
            <Link href={`/chat/${task.conversationId}`} className={btn}>
              <MessageSquare className="h-3.5 w-3.5" aria-hidden />
              Abrir la conversación
            </Link>
          )}
          {!live && canCancelTask(viewer, ref) && (
            <ShareReplay taskId={task.id} fixture={fixture === true} />
          )}
          {canCancel(task.status) && canCancelTask(viewer, ref) && (
            <button
              type="button"
              className={btn}
              disabled={busy}
              onClick={() => void act('cancel')}
            >
              <Square className="h-3.5 w-3.5" aria-hidden />
              Cancelar
            </button>
          )}
          {canRetry(task.status) && canRetryTask(viewer, ref) && (
            <button type="button" className={btn} disabled={busy} onClick={() => void act('retry')}>
              <RotateCcw className="h-3.5 w-3.5" aria-hidden />
              Reintentar
            </button>
          )}
        </div>
        {error && <p className="mt-2 text-sm text-rose">{error}</p>}
      </section>

      {task.status === 'needs_you' && (
        <section className="rounded-card border border-amber/30 bg-surface p-5 shadow-card">
          <h3 className="mb-3 text-sm font-semibold text-ink">Te necesita</h3>
          <TaskApprovals approvals={task.approvals} onDecided={() => void load()} />
        </section>
      )}

      {task.status === 'failed' && task.error && (
        <section className="rounded-card border border-rose/30 bg-rose-soft p-5 text-sm text-ink">
          <h3 className="mb-1 text-sm font-semibold text-rose">No pudo terminar</h3>
          <p className="[overflow-wrap:anywhere]">{task.error}</p>
        </section>
      )}

      {task.result && (
        <section className="rounded-card border border-border bg-surface p-5 shadow-card">
          <h3 className="mb-3 text-sm font-semibold text-ink">Resultado</h3>
          <div className="text-sm text-ink">
            <ChatMarkdown content={task.result} />
          </div>
        </section>
      )}

      <section className="rounded-card border border-border bg-surface p-5 shadow-card">
        <h3 className="mb-1 text-sm font-semibold text-ink">Archivos de la tarea</h3>
        <p className="mb-3 text-xs text-ink-faint">
          Todo lo que se produjo mientras corrió: informes, presentaciones, descargas del navegador
          y hojas.
        </p>
        <FilesPanel
          taskId={task.id}
          {...(fixtureFiles ? { initialFiles: fixtureFiles } : {})}
          {...(live ? { refreshMs: 8000 } : {})}
        />
      </section>
    </div>
  );
}
