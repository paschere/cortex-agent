'use client';

import { DeleteDialog } from '@/components/ui/DeleteDialog';
import { Archive, ChevronDown, Loader2, RotateCcw, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/**
 * «Archivadas (N)»: lo archivado de una estantería (apps o vistas), con
 * «Restaurar» y «Eliminar». El servidor sólo la manda a quien administra y
 * vuelve a exigirlo en cada acción; aquí sólo se pinta.
 */

export interface ArchivedItem {
  id: string;
  name: string;
  icon?: string;
  /** «hace 3 días», calculado en el servidor. */
  when: string;
}

type Result = { ok: true } | { ok: false; error: string };

export function ArchivedSection({
  items,
  noun,
  onRestore,
  onDelete,
  deleteTitle,
  confirmLabel,
  consequences,
}: {
  items: ArchivedItem[];
  /** «aplicación» o «vista», para los textos. */
  noun: string;
  onRestore: (id: string) => Promise<Result>;
  onDelete: (id: string) => Promise<Result>;
  deleteTitle: string;
  confirmLabel: string;
  consequences: string[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteFor, setDeleteFor] = useState<ArchivedItem | null>(null);

  if (items.length === 0) return null;

  function restore(id: string) {
    setError(null);
    setBusyId(id);
    start(async () => {
      const res = await onRestore(id);
      setBusyId(null);
      if (!res.ok) return setError(res.error);
      router.refresh();
    });
  }

  return (
    <section aria-labelledby="archivadas" className="mt-10">
      <h2 id="archivadas" className="text-sm font-semibold text-ink">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="inline-flex items-center gap-2 rounded-pill border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-ink-muted transition-colors hover:text-ink"
        >
          <Archive className="h-3.5 w-3.5" aria-hidden /> Archivadas ({items.length})
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
            aria-hidden
          />
        </button>
      </h2>
      {open && (
        <div className="mt-3">
          {error && (
            <p role="alert" className="mb-3 rounded-card bg-rose-soft px-3 py-2 text-xs text-rose">
              {error}
            </p>
          )}
          <ul className="divide-y divide-border rounded-card border border-border bg-surface">
            {items.map((it) => (
              <li key={it.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                {it.icon && (
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface-2 text-xl">
                    {it.icon}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">{it.name}</p>
                  <p className="text-micro text-ink-faint">Archivada {it.when}</p>
                </div>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => restore(it.id)}
                  aria-label={`Restaurar ${noun} «${it.name}»`}
                  className="inline-flex h-8 items-center gap-1.5 rounded-pill border border-border bg-surface px-3 text-xs font-semibold text-ink transition-colors hover:border-primary/50 hover:text-primary disabled:opacity-50"
                >
                  {busyId === it.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  ) : (
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                  )}
                  Restaurar
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => setDeleteFor(it)}
                  aria-label={`Eliminar ${noun} «${it.name}»`}
                  className="inline-flex h-8 items-center gap-1.5 rounded-pill border border-border bg-surface px-3 text-xs font-semibold text-rose transition-colors hover:border-rose/50 disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden /> Eliminar
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <DeleteDialog
        open={deleteFor !== null}
        onOpenChange={(o) => !o && setDeleteFor(null)}
        title={deleteTitle}
        name={deleteFor?.name ?? ''}
        confirmLabel={confirmLabel}
        consequences={consequences}
        onConfirm={async () => {
          if (!deleteFor) return null;
          const res = await onDelete(deleteFor.id);
          if (!res.ok) return res.error;
          router.refresh();
          return null;
        }}
      />
    </section>
  );
}
