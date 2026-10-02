'use client';

import { Check, Loader2, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { AutopilotActions } from './types';

/**
 * Aprobar o descartar una cosa que espera decisión. Aprobar la hace AHORA,
 * como quien aprueba; descartar la quita de la lista (y el piloto no la vuelve
 * a proponer en la semana). La huella viaja con el clic: si la cosa cambió
 * desde que se pintó, el servidor no la ejecuta.
 */
export function ItemDecision({
  itemId,
  contentHash,
  actions,
  approveLabel = 'Aprobar y hacerlo',
}: {
  itemId: string;
  contentHash: string;
  actions: AutopilotActions;
  approveLabel?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [which, setWhich] = useState<'approve' | 'dismiss' | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const decide = (decision: 'approve' | 'dismiss') => {
    setWhich(decision);
    start(async () => {
      const r = await actions.decide({ itemId, decision, contentHash });
      setNote({ ok: r.ok, text: r.note });
      if (r.ok) router.refresh();
    });
  };

  if (note?.ok) return <output className="text-xs font-semibold text-emerald">{note.text}</output>;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() => decide('approve')}
        className="cortex-primary-button inline-flex min-h-9 items-center gap-1.5 rounded-pill bg-primary px-4 py-1.5 text-xs font-bold text-white transition-colors hover:bg-primary-strong disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending && which === 'approve' ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : (
          <Check className="h-3.5 w-3.5" aria-hidden />
        )}
        {approveLabel}
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => decide('dismiss')}
        className="inline-flex min-h-9 items-center gap-1.5 rounded-pill border border-border-strong bg-surface px-3 py-1.5 text-xs font-semibold text-ink transition-colors hover:bg-surface-2 disabled:opacity-50"
      >
        {pending && which === 'dismiss' ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : (
          <X className="h-3.5 w-3.5" aria-hidden />
        )}
        Descartar
      </button>
      {note && !note.ok && (
        <p role="alert" className="w-full text-xs font-semibold text-rose">
          {note.text}
        </p>
      )}
    </div>
  );
}
