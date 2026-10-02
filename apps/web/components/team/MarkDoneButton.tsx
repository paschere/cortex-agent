'use client';

import { clsx } from 'clsx';
import { Check, Loader2, Undo2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import type { MarkDoneUndo, TeamActions } from './types';

/** Cuánto se queda el aviso con «Deshacer» antes de refrescar la lista. */
const UNDO_WINDOW_MS = 8_000;

/**
 * «Marcar hecho», sólo donde existe un camino seguro (ver `canMarkDone`).
 *
 * Una fila de tabla se puede deshacer desde el mismo aviso: el servidor no
 * refresca la página al marcarla, así que la fila se queda con «Deshacer» unos
 * segundos y después la lista se refresca sola. Lo demás (un compromiso, lo
 * anotado en el registro) se cierra y la página se refresca enseguida.
 */
export function MarkDoneButton({
  itemId,
  title,
  markDone,
  undoMarkDone,
}: {
  itemId: string;
  title: string;
  markDone: TeamActions['markDone'];
  undoMarkDone?: TeamActions['undoMarkDone'];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [state, setState] = useState<{
    ok: boolean;
    text: string;
    undo?: MarkDoneUndo;
  } | null>(null);
  const done = state?.ok === true;
  const canUndo = done && state?.undo !== undefined && undoMarkDone !== undefined;

  // Pasada la ventana de deshacer, la lista se refresca y la fila se va.
  useEffect(() => {
    if (!canUndo) return;
    const timer = setTimeout(() => router.refresh(), UNDO_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [canUndo, router]);

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={pending || done}
        aria-label={`Marcar hecho: ${title}`}
        onClick={() =>
          start(async () => {
            const r = await markDone({ itemId });
            setState(
              r.ok ? { ok: true, text: r.note, undo: r.undo } : { ok: false, text: r.error },
            );
          })
        }
        className={clsx(
          'inline-flex min-h-8 items-center gap-1 rounded-pill border px-3 py-1 text-micro font-semibold transition-colors disabled:cursor-default',
          done
            ? 'border-emerald/20 bg-emerald-soft text-emerald'
            : 'border-border-strong bg-surface text-ink hover:bg-surface-2',
        )}
      >
        {pending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : (
          <Check className="h-3.5 w-3.5" aria-hidden />
        )}
        {done ? 'Hecho' : 'Marcar hecho'}
      </button>
      {canUndo && (
        <button
          type="button"
          disabled={pending}
          aria-label={`Deshacer: ${title}`}
          onClick={() =>
            start(async () => {
              const undo = state?.undo;
              if (!undoMarkDone || !undo) return;
              const r = await undoMarkDone({ itemId, ...undo });
              setState(r.ok ? null : { ok: false, text: r.error });
              if (r.ok) router.refresh();
            })
          }
          className="inline-flex min-h-8 items-center gap-1 rounded-pill px-2 py-1 text-micro font-semibold text-primary hover:underline"
        >
          <Undo2 className="h-3.5 w-3.5" aria-hidden />
          Deshacer
        </button>
      )}
      <output
        aria-live="polite"
        className={clsx('text-micro', state?.ok ? 'sr-only' : 'text-rose')}
      >
        {state?.text ?? ''}
      </output>
    </span>
  );
}
