'use client';

import { type TaskBanner, taskIsLive, toBanner } from '@/lib/background-tasks/banner';
import { canCancelTask, canRetryTask } from '@/lib/background-tasks/scope';
import {
  TASK_STATUSES,
  TASK_STATUS_LABEL,
  type TaskStatus,
  canCancel,
  canRetry,
  durationMs,
  formatTaskDuration,
} from '@/lib/background-tasks/status';
import { chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import { MessageSquare, RotateCcw, Square } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { TaskStatusChip } from './TaskStatusChip';

export interface TaskRow extends TaskBanner {
  userId: string;
  ownerName: string | null;
  queuedAt: string;
}

function when(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  // Node y el navegador no separan «a. m.» con el mismo espacio: se normaliza para que
  // el HTML del servidor y el del cliente coincidan.
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

export function toRow(raw: Record<string, unknown>): TaskRow {
  return {
    ...toBanner(raw),
    userId: String(raw.userId ?? raw.user_id ?? ''),
    ownerName: typeof raw.ownerName === 'string' ? raw.ownerName : null,
    queuedAt: String(raw.queuedAt ?? raw.queued_at ?? ''),
  };
}

const small =
  'inline-flex items-center gap-1.5 rounded-pill bg-surface-2 px-3 py-1 text-xs font-semibold text-ink transition-colors duration-150 hover:bg-border disabled:opacity-50 motion-reduce:transition-none';

/**
 * LA LISTA DE TAREAS: estado, inicio, fin, duración, dueña y acciones.
 *
 * Mientras alguna siga viva se vuelve a consultar sola (cada 6 s). `fixture`
 * congela la lista para las pantallas de muestra y las pruebas.
 */
export function TaskList({
  initial,
  viewer,
  fixture,
}: {
  initial: TaskRow[];
  viewer: { id: string; isManager: boolean };
  fixture?: boolean;
}) {
  const [tasks, setTasks] = useState<TaskRow[]>(initial);
  const [filter, setFilter] = useState<TaskStatus | 'all'>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Sin hora en el primer pintado (servidor y cliente tienen relojes distintos): las tareas
  // vivas muestran «—» en la duración hasta que el navegador monta.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => setNow(new Date()), []);

  const anyLive = tasks.some((t) => taskIsLive(t));

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/tasks?limit=100', { cache: 'no-store' });
      if (!res.ok) return;
      const body = (await res.json()) as { tasks?: Record<string, unknown>[] };
      setTasks((body.tasks ?? []).map(toRow));
    } catch {
      // La próxima consulta lo repone.
    }
  }, []);

  useEffect(() => {
    if (fixture || !anyLive) return;
    const poll = setInterval(() => void load(), 6000);
    const tick = setInterval(() => setNow(new Date()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [anyLive, fixture, load]);

  async function act(id: string, what: 'cancel' | 'retry') {
    if (fixture) return;
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${id}/${what}`, { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? 'No se pudo completar la acción.');
        return;
      }
      await load();
    } finally {
      setBusy(null);
    }
  }

  const counts = new Map<TaskStatus, number>();
  for (const t of tasks) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
  const shown = filter === 'all' ? tasks : tasks.filter((t) => t.status === filter);

  return (
    <div>
      <div
        className="mb-3 flex flex-wrap items-center gap-2"
        role="tablist"
        aria-label="Filtrar por estado"
      >
        {(['all', ...TASK_STATUSES] as const).map((s) => {
          const n = s === 'all' ? tasks.length : (counts.get(s) ?? 0);
          if (s !== 'all' && n === 0) return null;
          return (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={filter === s}
              onClick={() => setFilter(s)}
              className={clsx(
                chipClass(filter === s ? 'primary' : 'neutral'),
                'cursor-pointer hover:-translate-y-px motion-reduce:transform-none',
              )}
            >
              {s === 'all' ? 'Todas' : TASK_STATUS_LABEL[s]}
              <span className="tabular opacity-70">{n}</span>
            </button>
          );
        })}
      </div>

      {error && <p className="mb-2 text-sm text-rose">{error}</p>}

      {shown.length === 0 ? (
        <p className="rounded-card border border-dashed border-border px-4 py-8 text-center text-sm text-ink-muted">
          {tasks.length === 0
            ? 'Todavía no hay tareas. En el chat, abre «+» y elige «En segundo plano», o pulsa «Seguir en segundo plano» cuando un pedido largo esté corriendo.'
            : 'No hay tareas con ese estado.'}
        </p>
      ) : (
        <ul className="overflow-hidden rounded-card border border-border bg-surface shadow-card">
          <li className="hidden grid-cols-[minmax(0,1fr)_6.5rem_7rem_7rem_5.5rem_14.5rem] items-center gap-3 border-b border-border bg-surface-2/60 px-4 py-2 md:grid">
            {['Tarea', 'Estado', 'Inicio', 'Fin', 'Duración', 'Acciones'].map((h) => (
              <span key={h} className="field-label">
                {h}
              </span>
            ))}
          </li>
          {shown.map((t) => (
            <li
              key={t.id}
              className="grid grid-cols-1 gap-2 border-b border-border px-4 py-3.5 last:border-b-0 md:grid-cols-[minmax(0,1fr)_6.5rem_7rem_7rem_5.5rem_14.5rem] md:items-center md:gap-3"
            >
              <div className="min-w-0">
                <Link
                  href={`/tareas/${t.id}`}
                  className="line-clamp-2 text-sm font-semibold leading-snug text-ink hover:underline"
                >
                  {t.title}
                </Link>
                {viewer.isManager && (
                  <span className="mt-0.5 block text-xs text-ink-faint">
                    {t.userId === viewer.id ? 'Tuya' : (t.ownerName ?? 'Otra persona')}
                  </span>
                )}
                {t.status === 'needs_you' && (
                  <span className="mt-0.5 block text-xs text-amber">
                    Espera tu visto bueno ({t.approvals.filter((a) => !a.decision).length})
                  </span>
                )}
              </div>
              <div>
                <TaskStatusChip status={t.status} />
              </div>
              <span className="tabular text-xs text-ink-muted">
                <span className="md:hidden">Inicio: </span>
                {when(t.startedAt ?? t.queuedAt)}
              </span>
              <span className="tabular text-xs text-ink-muted">
                <span className="md:hidden">Fin: </span>
                {when(t.finishedAt)}
              </span>
              <span className="tabular text-xs text-ink-muted">
                {formatTaskDuration(t.finishedAt || now ? durationMs(t, now ?? new Date()) : null)}
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/tareas/${t.id}`} className={small}>
                  Abrir
                </Link>
                {t.conversationId && (
                  <Link
                    href={`/chat/${t.conversationId}`}
                    className={small}
                    title="Ver la conversación"
                  >
                    <MessageSquare className="h-3.5 w-3.5" aria-hidden />
                    Chat
                  </Link>
                )}
                {canCancel(t.status) && canCancelTask(viewer, t) && (
                  <button
                    type="button"
                    className={small}
                    disabled={busy === t.id}
                    onClick={() => void act(t.id, 'cancel')}
                  >
                    <Square className="h-3.5 w-3.5" aria-hidden />
                    Cancelar
                  </button>
                )}
                {canRetry(t.status) && canRetryTask(viewer, t) && (
                  <button
                    type="button"
                    className={small}
                    disabled={busy === t.id}
                    onClick={() => void act(t.id, 'retry')}
                  >
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                    Reintentar
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
