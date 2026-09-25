'use client';

import {
  acceptMemoryProposalAction,
  rejectMemoryProposalAction,
} from '@/lib/memory-proposals/actions';
import { clsx } from 'clsx';
import { BookmarkPlus, Check, Loader2, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/**
 * Los recuerdos que Cortex propuso desde el chat y nadie ha decidido todavía
 * (migración 0157). Arriba de Brain Knowledge porque es donde se decide qué
 * sabe la empresa. Cada uno enseña la frase que se guardaría y las palabras
 * literales de quien la dijo.
 */

export interface PendingMemory {
  id: string;
  kindLabel: string;
  subject: string | null;
  statement: string;
  quote: string;
  proposer: string;
  when: string;
  space: string | null;
}

export function PendingMemories({ items }: { items: PendingMemory[] }) {
  if (!items.length) return null;
  return (
    <section className="mb-6 overflow-hidden rounded-card border border-primary/30 bg-surface shadow-card">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <BookmarkPlus className="h-4 w-4 text-primary" aria-hidden />
        <h2 className="text-sm font-semibold text-ink">Recuerdos por confirmar</h2>
        <span className="tabular rounded-pill bg-primary-soft px-2 py-0.5 font-mono text-micro text-primary">
          {items.length}
        </span>
        <span className="ml-auto hidden text-micro text-ink-faint sm:inline">
          Dichos en el chat. Al guardarlos, Cortex los usa en todas las respuestas.
        </span>
      </header>
      <ul className="divide-y divide-border">
        {items.map((item) => (
          <Row key={item.id} item={item} />
        ))}
      </ul>
    </section>
  );
}

function Row({ item }: { item: PendingMemory }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const decide = (accept: boolean) =>
    start(async () => {
      const res = accept
        ? await acceptMemoryProposalAction(item.id)
        : await rejectMemoryProposalAction(item.id);
      setNote(res.ok ? { ok: true, text: res.message } : { ok: false, text: res.error });
      if (res.ok) router.refresh();
    });
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <p className="text-micro font-semibold uppercase tracking-field text-ink-faint">
          {item.kindLabel}
          {item.subject ? ` · ${item.subject}` : ''}
        </p>
        <p className="mt-0.5 text-sm text-ink">{item.statement}</p>
        <p className="mt-1 border-l-2 border-border-strong pl-2.5 text-xs italic text-ink-muted">
          «{item.quote}» — {item.proposer}, {item.when}
          {item.space ? ` · para «${item.space}»` : ''}
        </p>
        {note && (
          <p className={clsx('mt-1 text-xs', note.ok ? 'text-emerald' : 'text-rose')}>
            {note.text}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          disabled={pending}
          onClick={() => decide(false)}
          className="inline-flex items-center gap-1 rounded-pill px-2.5 py-1 text-xs font-semibold text-ink-muted hover:bg-surface-2 hover:text-ink disabled:opacity-45"
        >
          <X className="h-3.5 w-3.5" /> Descartar
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => decide(true)}
          className="cortex-primary-button inline-flex items-center gap-1 rounded-pill bg-primary px-3 py-1 text-xs font-semibold text-white hover:bg-primary-strong disabled:opacity-45"
        >
          {pending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Check className="h-3.5 w-3.5" />
          )}
          Guardar
        </button>
      </div>
    </li>
  );
}
