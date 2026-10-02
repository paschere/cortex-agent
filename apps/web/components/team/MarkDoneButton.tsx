'use client';

import { clsx } from 'clsx';
import { Check, Loader2 } from 'lucide-react';
import { useState, useTransition } from 'react';
import type { TeamActions } from './types';

/** «Marcar hecho», sólo donde existe un camino seguro (ver `canMarkDone`). */
export function MarkDoneButton({
  itemId,
  title,
  markDone,
}: {
  itemId: string;
  title: string;
  markDone: TeamActions['markDone'];
}) {
  const [pending, start] = useTransition();
  const [state, setState] = useState<{ ok: boolean; text: string } | null>(null);
  const done = state?.ok === true;
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={pending || done}
        aria-label={`Marcar hecho: ${title}`}
        onClick={() =>
          start(async () => {
            const r = await markDone({ itemId });
            setState(r.ok ? { ok: true, text: r.note } : { ok: false, text: r.error });
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
      <output
        aria-live="polite"
        className={clsx('text-micro', state?.ok ? 'sr-only' : 'text-rose')}
      >
        {state?.text ?? ''}
      </output>
    </span>
  );
}
