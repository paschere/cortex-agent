'use client';

import { clsx } from 'clsx';
import { CircleStop, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * The brake.
 *
 * Available to any signed-in teammate on purpose — see the route handler for
 * why. It always asks first (a stop mid-run leaves a half-finished branch
 * behind), and it never pretends the run is over: for a run that is already
 * executing it reports "Stopping", because the sandbox stands down on its own
 * schedule and saying otherwise would be a lie the page cannot back up.
 */
export function StopButton({
  taskId,
  title,
  stopping,
  size = 'md',
}: {
  taskId: string;
  /** Used in the confirmation so nobody stops the wrong run from a list. */
  title: string;
  /** Somebody already pressed it; the executor has not finished standing down. */
  stopping: boolean;
  size?: 'sm' | 'md';
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shape =
    size === 'sm' ? 'gap-1 px-2 py-1 text-[11.5px]' : 'gap-1.5 px-2.5 py-1.5 text-[12px]';

  if (stopping) {
    return (
      <span
        className={clsx(
          'inline-flex items-center rounded-[10px] border border-rose/30 bg-rose-soft font-semibold text-rose',
          shape,
        )}
        title="A person asked Zippy to stop. It stands down after the step it is on."
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Stopping
      </span>
    );
  }

  async function stop() {
    if (
      !window.confirm(
        `Stop Zippy working on “${title}”?\n\nIt stops after the step it is on. Any work already pushed stays on its branch — nothing is merged.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/dev-work/${taskId}/stop`, { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? 'Could not stop this run.');
      }
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={stop}
        disabled={busy}
        className={clsx(
          'inline-flex items-center rounded-[10px] border border-border bg-surface font-semibold text-rose shadow-card transition hover:bg-rose-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-rose disabled:opacity-60',
          shape,
        )}
      >
        {busy ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Stopping…
          </>
        ) : (
          <>
            <CircleStop className="h-3.5 w-3.5" /> Stop
          </>
        )}
      </button>
      {error && (
        <p className="rounded-[10px] border border-rose/30 bg-rose-soft px-2 py-1 text-[11px] text-rose">
          {error}
        </p>
      )}
    </div>
  );
}
