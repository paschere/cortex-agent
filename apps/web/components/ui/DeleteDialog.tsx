'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { Loader2, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';

/**
 * Confirmación de un borrado de verdad: dice qué se va y qué se queda, y pide
 * escribir el nombre de lo que se borra. El que llama hace el borrado en
 * `onConfirm` y devuelve el error (o null si salió bien); el diálogo se cierra
 * solo cuando salió bien.
 */
export function DeleteDialog({
  open,
  onOpenChange,
  title,
  name,
  consequences,
  confirmLabel,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** El nombre que hay que escribir. */
  name: string;
  /** Qué se va y qué se queda, en palabras de todos los días. */
  consequences: string[];
  confirmLabel: string;
  onConfirm: () => Promise<string | null>;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setTyped('');
      setError(null);
    }
  }, [open]);

  const matches = typed.trim().toLowerCase() === name.trim().toLowerCase();

  async function go() {
    if (!matches || busy) return;
    setBusy(true);
    setError(null);
    const failure = await onConfirm();
    setBusy(false);
    if (failure) setError(failure);
    else onOpenChange(false);
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 animate-veil bg-canvas/70 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(440px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-card border border-border bg-surface p-5 shadow-pop outline-none">
          <div className="flex items-start justify-between gap-3">
            <Dialog.Title className="text-base font-semibold text-ink">{title}</Dialog.Title>
            <Dialog.Close
              aria-label="Cerrar"
              className="grid h-7 w-7 place-items-center rounded-pill text-ink-muted hover:bg-surface-2 hover:text-ink"
            >
              <X className="h-4 w-4" aria-hidden />
            </Dialog.Close>
          </div>
          <Dialog.Description asChild>
            <ul className="mt-3 list-disc space-y-1.5 pl-4 text-xs leading-relaxed text-ink-muted">
              {consequences.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </Dialog.Description>
          <form
            className="mt-4"
            onSubmit={(e) => {
              e.preventDefault();
              void go();
            }}
          >
            <label className="block text-xs font-semibold text-ink">
              Escribe «{name}» para confirmar
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                className="mt-1.5 h-9 w-full rounded-lg border border-border bg-canvas px-3 text-sm font-normal text-ink outline-none focus:border-primary"
              />
            </label>
            {error && (
              <p
                role="alert"
                className="mt-3 rounded-card bg-rose-soft px-3 py-2 text-xs text-rose"
              >
                {error}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => onOpenChange(false)}
                className="inline-flex h-8 items-center rounded-pill border border-border bg-surface px-3.5 text-xs font-semibold text-ink hover:bg-surface-2 disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={!matches || busy}
                className="inline-flex h-8 items-center gap-1.5 rounded-pill bg-rose px-3.5 text-xs font-semibold text-white transition-opacity disabled:opacity-40"
              >
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                )}
                {confirmLabel}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
