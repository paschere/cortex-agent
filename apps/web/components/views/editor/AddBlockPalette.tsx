'use client';

import { KNOWN_BLOCK_TYPES } from '@/lib/views/editor-shape';
import { type EditorSource, type PaletteType, defaultSourceFor } from '@/lib/views/editor-spec';
import * as Dialog from '@radix-ui/react-dialog';
import { clsx } from 'clsx';
import { X } from 'lucide-react';
import { BLOCK_PITCH, blockIcon, blockLabel } from './block-meta';

/**
 * «+ AGREGAR BLOQUE»: LAS PLANTILLAS, CADA UNA YA VÁLIDA.
 *
 * Cada tarjeta crea un bloque que pasa el contrato desde el primer momento
 * (`newBlock` elige fuente, título y campos probables), así que lo primero que
 * se ve después del clic es un bloque con datos, no un aviso amarillo. Si un
 * tipo no tiene con qué armarse —un formulario sin tablas propias, un tablero
 * sin campo de opciones— la tarjeta sale apagada y dice por qué.
 *
 * El plano (`zones`) aparece sólo si el contrato del servidor lo acepta
 * (`catalog.blockTypes`): la paleta no ofrece lo que el guardado rechazaría.
 */

const ORDER: PaletteType[] = ['metric', 'table', 'chart', 'board', 'zones', 'form', 'text'];

const WHY_NOT: Partial<Record<PaletteType, string>> = {
  form: 'Necesitas una tabla de tu empresa: pídele a Cortex que cree una.',
  board: 'Necesitas una tabla con un campo de opciones (un estado, una etapa).',
  zones: 'Necesitas una tabla con un campo de opciones (una zona, un muelle).',
};

export function AddBlockPalette({
  open,
  onOpenChange,
  sources,
  blockTypes,
  prefer,
  loading,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sources: EditorSource[];
  blockTypes: string[];
  prefer: string | null;
  loading: boolean;
  onPick: (type: PaletteType) => void;
}) {
  const types = ORDER.filter(
    (t) => (KNOWN_BLOCK_TYPES as readonly string[]).includes(t) || blockTypes.includes(t),
  );
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 animate-veil bg-canvas/70 backdrop-blur-sm" />
        <Dialog.Content className="fixed inset-x-0 bottom-0 z-50 flex max-h-[85vh] flex-col overflow-hidden rounded-t-card border border-border bg-surface shadow-pop outline-none sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:w-[min(640px,calc(100vw-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-card">
          <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
            <div>
              <Dialog.Title className="text-base font-semibold text-ink">
                Agregar bloque
              </Dialog.Title>
              <Dialog.Description className="text-xs text-ink-muted">
                Sale con datos de una de tus tablas; después lo ajustas a la derecha.
              </Dialog.Description>
            </div>
            <Dialog.Close
              aria-label="Cerrar"
              className="grid h-8 w-8 place-items-center rounded-pill text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>
          <ul className="scroll-slim grid min-h-0 gap-2 overflow-auto p-4 sm:grid-cols-2">
            {types.map((type) => {
              const Icon = blockIcon(type);
              const ready = type === 'text' || Boolean(defaultSourceFor(type, sources, prefer));
              const disabled = loading || !ready;
              return (
                <li key={type}>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => onPick(type)}
                    className={clsx(
                      'flex h-full w-full items-start gap-3 rounded-sm border border-border bg-surface p-3 text-left transition-all duration-150',
                      disabled
                        ? 'cursor-not-allowed opacity-50'
                        : 'hover:-translate-y-px hover:border-primary/50 hover:bg-primary-soft/30 hover:shadow-card',
                    )}
                  >
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-primary-soft text-primary">
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-ink">
                        {blockLabel(type)}
                      </span>
                      <span className="block text-xs leading-relaxed text-ink-muted">
                        {!ready && !loading ? WHY_NOT[type] : BLOCK_PITCH[type]}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {loading && (
            <p className="border-t border-border px-5 py-3 text-micro text-ink-faint">
              Leyendo tus tablas…
            </p>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
