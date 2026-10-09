'use client';

import { clsx } from 'clsx';
import { Loader2, Undo2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { undoActivity } from '../actions';

/** El botón «Deshacer» de una línea. Pide confirmación en el mismo botón (dos toques). */
export function UndoButton({ eventIds, label }: { eventIds: string[]; label: string }) {
  const router = useRouter();
  const [armed, setArmed] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  if (note?.ok) return <span className="text-micro font-semibold text-emerald">{note.text}</span>;

  return (
    <span className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          if (!armed) {
            setArmed(true);
            return;
          }
          start(async () => {
            const res = await undoActivity(eventIds);
            setNote({ ok: res.ok, text: res.message });
            setArmed(false);
            if (res.ok) router.refresh();
          });
        }}
        onBlur={() => setArmed(false)}
        className={clsx(
          'inline-flex min-h-9 items-center gap-1.5 rounded-pill border px-3 text-xs font-semibold transition-colors disabled:opacity-60',
          armed
            ? 'border-rose/25 bg-rose-soft text-rose'
            : 'border-border-strong bg-surface text-ink-muted hover:bg-surface-2 hover:text-ink',
        )}
      >
        {pending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Undo2 className="h-3.5 w-3.5" />
        )}
        {armed ? 'Confirmar: ' : ''}
        {label}
      </button>
      {note && !note.ok && (
        <span className="max-w-56 text-right text-micro text-rose">{note.text}</span>
      )}
    </span>
  );
}
