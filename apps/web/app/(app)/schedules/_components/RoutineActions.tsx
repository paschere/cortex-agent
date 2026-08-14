'use client';

import { clsx } from 'clsx';
import { Loader2, Pause, Pencil, Play, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { EditRoutineDialog } from './EditRoutineDialog';
import type { ScheduledJob } from './types';

const GHOST =
  'inline-flex items-center gap-1.5 rounded-pill border border-border-strong bg-surface px-2.5 py-1.5 text-xs font-semibold shadow-card transition-all duration-150 hover:-translate-y-px focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50 disabled:hover:translate-y-0 motion-reduce:transform-none motion-reduce:transition-none';

/**
 * The routine detail header's action row — the same four verbs the card offers
 * (Run now, Pause/Resume, Edit, Cancel), hitting the same endpoints. Every
 * mutation ends in `router.refresh()`, so the server page is the source of truth.
 */
export function RoutineActions({ job, canEdit }: { job: ScheduledJob; canEdit: boolean }) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  async function runNow() {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(`/api/schedules/${job.id}/run`, { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `La solicitud falló (${res.status}).`);
      }
      // The run happens in the background; give it a beat before re-reading.
      setTimeout(() => {
        setRunning(false);
        router.refresh();
      }, 2000);
    } catch (err) {
      setError((err as Error).message);
      setRunning(false);
    }
  }

  async function act(action: 'pause' | 'resume' | 'cancel') {
    if (action === 'cancel' && !window.confirm('¿Cancelar esta rutina para siempre?')) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/schedules/${job.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `La solicitud falló (${res.status}).`);
      }
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-stretch gap-1.5 sm:items-end">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={runNow}
          disabled={running || job.status !== 'active'}
          title={
            job.status === 'active'
              ? 'Ejecutar esta rutina ahora'
              : 'Solo se pueden ejecutar las rutinas activas'
          }
          className="inline-flex items-center gap-1.5 rounded-pill bg-primary px-3 py-1.5 text-xs font-semibold text-white shadow-pop transition-all duration-150 hover:-translate-y-px hover:bg-primary-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50 disabled:hover:translate-y-0 motion-reduce:transform-none motion-reduce:transition-none"
        >
          {running ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />{' '}
              Ejecutando…
            </>
          ) : (
            <>
              <Play className="h-3.5 w-3.5" /> Ejecutar ahora
            </>
          )}
        </button>

        {job.status === 'active' && (
          <button
            type="button"
            disabled={busy}
            onClick={() => act('pause')}
            className={clsx(GHOST, 'text-ink-muted hover:bg-surface-2 hover:text-ink')}
          >
            <Pause className="h-3.5 w-3.5" /> Pausar
          </button>
        )}
        {job.status === 'paused' && (
          <button
            type="button"
            disabled={busy}
            onClick={() => act('resume')}
            className={clsx(GHOST, 'text-emerald hover:bg-emerald-soft')}
          >
            <Play className="h-3.5 w-3.5" /> Reanudar
          </button>
        )}

        {canEdit && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className={clsx(GHOST, 'text-ink-muted hover:bg-surface-2 hover:text-ink')}
          >
            <Pencil className="h-3.5 w-3.5" /> Editar
          </button>
        )}

        {(job.status === 'active' || job.status === 'paused') && (
          <button
            type="button"
            disabled={busy}
            onClick={() => act('cancel')}
            title="Cancelar para siempre"
            className={clsx(GHOST, 'text-rose hover:bg-rose-soft')}
          >
            <X className="h-3.5 w-3.5" /> Cancelar
          </button>
        )}
      </div>

      {error && (
        <p className="rounded-card border border-rose/40 bg-rose-soft px-2.5 py-1.5 text-micro text-rose shadow-card">
          {error} No se cambió nada; vuelve a intentarlo.
        </p>
      )}

      {editing && (
        <EditRoutineDialog
          job={job}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
