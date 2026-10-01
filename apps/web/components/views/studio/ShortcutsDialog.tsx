'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

/**
 * LOS ATAJOS DEL ESTUDIO, CON «?».
 *
 * Son pocos a propósito y todos tienen un botón equivalente: el teclado
 * acelera a quien ya sabe, nunca es el único camino. Esta lista es la verdad:
 * si se agrega un atajo en ViewEditor y no aquí, nadie lo va a descubrir.
 */

export const SHORTCUTS: Array<{ keys: string[]; what: string }> = [
  { keys: ['⌘', 'K'], what: 'Pedirle un cambio a Cortex (también «/»)' },
  { keys: ['⌘', 'Z'], what: 'Deshacer' },
  { keys: ['⇧', '⌘', 'Z'], what: 'Rehacer' },
  { keys: ['⌘', 'S'], what: 'Guardar' },
  { keys: ['⌘', 'D'], what: 'Duplicar el bloque elegido' },
  { keys: ['Supr'], what: 'Eliminar el bloque elegido (con «Deshacer»)' },
  { keys: ['Alt', '↑ ↓'], what: 'Mover el bloque elegido' },
  { keys: ['P'], what: 'Probar la vista / volver a editar' },
  { keys: ['Esc'], what: 'Soltar la selección o cerrar un panel' },
  { keys: ['?'], what: 'Ver estos atajos' },
];

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 animate-veil bg-canvas/70 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(440px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-card border border-border bg-surface shadow-pop outline-none">
          <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
            <div>
              <Dialog.Title className="text-base font-semibold text-ink">
                Atajos de teclado
              </Dialog.Title>
              <Dialog.Description className="text-xs text-ink-muted">
                En Windows, Ctrl en lugar de ⌘.
              </Dialog.Description>
            </div>
            <Dialog.Close
              aria-label="Cerrar"
              className="grid h-8 w-8 place-items-center rounded-pill text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>
          <dl className="divide-y divide-border px-5 py-2">
            {SHORTCUTS.map((s) => (
              <div key={s.what} className="flex items-center justify-between gap-4 py-2">
                <dt className="text-sm text-ink">{s.what}</dt>
                <dd className="flex shrink-0 gap-1">
                  {s.keys.map((k) => (
                    <kbd
                      key={k}
                      className="min-w-6 rounded-sm border border-border-strong bg-surface-2 px-1.5 py-0.5 text-center font-mono text-micro text-ink-muted shadow-card"
                    >
                      {k}
                    </kbd>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
