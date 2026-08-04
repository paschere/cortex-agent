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
          'inline-flex items-center rounded-card border border-rose/40 bg-rose-soft font-semibold text-rose',
          shape,
        )}
        title="Alguien le pidió a Cortex que se detenga. Para después del paso en el que va."
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> Deteniendo
      </span>
    );
  }

  async function stop() {
    if (
      !window.confirm(
        `¿Detener a Cortex en “${title}”?\n\nPara después del paso en el que va. Lo que ya subió se queda en su rama: no se integra nada.`,
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
        throw new Error(body?.error ?? 'No se pudo detener esta ejecución.');
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
          'inline-flex items-center rounded-card border border-border-strong bg-surface font-semibold text-rose transition-colors hover:bg-rose-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-rose disabled:opacity-60',
          shape,
        )}
      >
        {busy ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> Deteniendo…
          </>
        ) : (
          <>
            <CircleStop className="h-3.5 w-3.5" /> Detener
          </>
        )}
      </button>
      {error && (
        <p className="rounded-card border border-rose/40 bg-rose-soft px-2 py-1 text-[11px] text-rose">
          {error} La ejecución sigue corriendo; vuelve a intentarlo.
        </p>
      )}
    </div>
  );
}
