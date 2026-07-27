'use client';

import { clsx } from 'clsx';
import { Loader2, Pause, Pencil, Play, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { EditRoutineDialog } from './EditRoutineDialog';
import type { ScheduledJob } from './types';

const GHOST =
  'inline-flex items-center gap-1.5 rounded-[10px] border border-border bg-surface px-2.5 py-1.5 text-[12px] font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50';

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
        throw new Error(body?.error ?? `Request failed (${res.status})`);
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
    if (action === 'cancel' && !window.confirm('Cancel this routine permanently?')) return;
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
        throw new Error(body?.error ?? `Request failed (${res.status})`);
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
              ? 'Run this routine now'
              : `Only active routines can be run (this one is ${job.status})`
          }
          className="inline-flex items-center gap-1.5 rounded-[10px] bg-primary px-3 py-1.5 text-[12px] font-semibold text-white shadow-pop transition hover:bg-primary-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
        >
          {running ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Running…
            </>
          ) : (
            <>
              <Play className="h-3.5 w-3.5" /> Run now
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
            <Pause className="h-3.5 w-3.5" /> Pause
          </button>
        )}
        {job.status === 'paused' && (
          <button
            type="button"
            disabled={busy}
            onClick={() => act('resume')}
            className={clsx(GHOST, 'text-emerald hover:bg-emerald-soft')}
          >
            <Play className="h-3.5 w-3.5" /> Resume
          </button>
        )}

        {canEdit && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className={clsx(GHOST, 'text-ink-muted hover:bg-surface-2 hover:text-ink')}
          >
            <Pencil className="h-3.5 w-3.5" /> Edit
          </button>
        )}

        {(job.status === 'active' || job.status === 'paused') && (
          <button
            type="button"
            disabled={busy}
            onClick={() => act('cancel')}
            title="Cancel permanently"
            className={clsx(GHOST, 'text-rose hover:bg-rose-soft')}
          >
            <X className="h-3.5 w-3.5" /> Cancel
          </button>
        )}
      </div>

      {error && (
        <p className="rounded-[10px] border border-rose/30 bg-rose-soft px-2.5 py-1.5 text-[11.5px] text-rose">
          {error}
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
