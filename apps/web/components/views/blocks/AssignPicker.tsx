'use client';

import type { AssignablePerson } from '@cortex/agent-tools';
import * as Dialog from '@radix-ui/react-dialog';
import { clsx } from 'clsx';
import { Loader2, Search, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useBrandScope } from './brand';

/**
 * «ASIGNAR A…»: la lista de personas de la app para un botón de fila.
 *
 * Las personas llegan del servidor (`assignablePeopleAction`): sólo quienes
 * pertenecen a ESTA app (y a los roles que el botón permite), sin coordenadas
 * ni correos. Elegir una llama al `assign` del escritor de la vista, que vuelve
 * a comprobar en el servidor el permiso de asignar y a la persona. Se monta en
 * un portal con su copia de la marca, como la ficha de una fila.
 */
export function AssignPicker({
  open,
  title,
  load,
  onPick,
  onClose,
}: {
  open: boolean;
  title: string;
  load: () => Promise<{ ok: true; people: AssignablePerson[] } | { ok: false; error: string }>;
  onPick: (ref: string) => Promise<void>;
  onClose: () => void;
}) {
  const scope = useBrandScope();
  const [people, setPeople] = useState<AssignablePerson[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: se pide la lista una vez cada vez que se abre
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPeople(null);
    setError(null);
    setQ('');
    load().then((res) => {
      if (cancelled) return;
      if (res.ok) setPeople(res.people);
      else setError(res.error);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (people ?? []).filter((p) => !needle || p.name.toLowerCase().includes(needle));
  }, [people, q]);
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 animate-veil bg-canvas/60 backdrop-blur-[2px]" />
        <Dialog.Content
          style={scope.style}
          className={clsx(
            scope.className,
            'fixed z-50 flex max-h-[80dvh] flex-col overflow-hidden border border-border bg-surface shadow-pop outline-none animate-veil',
            'inset-x-0 bottom-0 rounded-t-card',
            'sm:inset-auto sm:left-1/2 sm:top-1/2 sm:w-[min(24rem,calc(100vw-1.5rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-card',
          )}
        >
          <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="truncate text-base font-bold text-ink">{title}</Dialog.Title>
              <Dialog.Description className="text-micro text-ink-faint">
                Elige a quién asignarla. Le llegará un aviso.
              </Dialog.Description>
            </div>
            <Dialog.Close
              aria-label="Cerrar"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-pill text-ink-faint hover:bg-surface-2 hover:text-ink"
            >
              <X className="h-4 w-4" aria-hidden />
            </Dialog.Close>
          </div>
          <div className="border-b border-border px-5 py-3">
            <label className="relative block">
              <span className="sr-only">Buscar a una persona</span>
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint"
                aria-hidden
              />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Buscar por nombre"
                className="w-full rounded-sm border border-border bg-surface py-2 pl-9 pr-3 text-sm text-ink placeholder:text-ink-faint"
              />
            </label>
          </div>
          <div className="scroll-slim min-h-0 flex-1 overflow-y-auto px-2 py-2">
            {error && (
              <p className="m-3 rounded-sm bg-rose-soft px-3 py-2 text-xs text-rose" role="alert">
                {error}
              </p>
            )}
            {!error && people === null && (
              <p className="flex items-center justify-center gap-2 py-8 text-xs text-ink-faint">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Buscando a las personas…
              </p>
            )}
            {people && shown.length === 0 && (
              <p className="py-8 text-center text-xs text-ink-faint">No hay a quién asignar.</p>
            )}
            <ul>
              {shown.map((p) => (
                <li key={p.ref}>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={async () => {
                      setBusy(p.ref);
                      await onPick(p.ref);
                      setBusy(null);
                    }}
                    className="flex min-h-11 w-full items-center gap-3 rounded-sm px-3 py-2 text-left transition-colors hover:bg-surface-2 disabled:opacity-50"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-ink">
                        {p.name}
                      </span>
                      <span className="block truncate text-micro text-ink-faint">{p.roleName}</span>
                    </span>
                    {p.onShift && (
                      <span className="rounded-pill bg-emerald-soft px-2 py-0.5 text-micro font-semibold text-emerald">
                        En turno
                      </span>
                    )}
                    {busy === p.ref && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
