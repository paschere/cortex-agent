'use client';

import type { ComputedAction, ComputedBlock, ComputedRecords } from '@cortex/agent-tools';
import * as Dialog from '@radix-ui/react-dialog';
import { clsx } from 'clsx';
import { X } from 'lucide-react';
import { createContext, useContext } from 'react';
import { EditableValue, RowActions } from '../view-writes';
import { useBrandScope } from './brand';
import { formatWhen } from './theme';

/**
 * LA FICHA DE UNA FILA.
 *
 * Tocar una fila de una tabla, una tarjeta del tablero, una ficha del plano,
 * una tarjeta de la galería o un evento del calendario abre esto: un panel a
 * la derecha (una hoja desde abajo en el teléfono) con todos los campos que la
 * vista declaró para esa fila, los que se editan en el sitio, sus botones y
 * cuándo se creó y se cambió.
 *
 * Los datos ya vinieron con el cálculo (`block.record`, ver el porqué en
 * packages/agent-tools/src/views/compute.ts): abrir la ficha no pide nada al
 * servidor. Lo que se edita aquí pasa por el mismo `useViewWriter` que una
 * celda, y el servidor vuelve a decidir con el spec guardado si ese campo se
 * puede tocar. Después de guardar, la vista se recalcula y la ficha se vuelve
 * a leer de lo nuevo; si la fila ya no está en el bloque (un filtro la sacó),
 * lo dice en vez de mostrar datos viejos.
 *
 * Radix Dialog pone el foco adentro, lo devuelve al cerrar, cierra con Esc y
 * esconde el resto de la página al lector de pantalla.
 */

type Opener = (blockId: string, rowId: string) => void;

const RecordContext = createContext<Opener | null>(null);

export const RecordOpenerProvider = RecordContext.Provider;

/**
 * Cómo abre la ficha una fila de este bloque, o null si no se abre (vista
 * previa del lienzo, `openRecord: false`, una fila sin ficha).
 */
export function useRecordOpener(
  blockId: string,
  record: ComputedRecords | null | undefined,
): ((rowId: string) => void) | null {
  const open = useContext(RecordContext);
  if (!open || !record) return null;
  return (rowId: string) => {
    if (record.rows[rowId]) open(blockId, rowId);
  };
}

type RecordBlock = Extract<
  ComputedBlock,
  { type: 'table' | 'board' | 'zones' | 'gallery' | 'calendar' }
>;

export function recordBlockOf(block: ComputedBlock | undefined): RecordBlock | null {
  return block &&
    (block.type === 'table' ||
      block.type === 'board' ||
      block.type === 'zones' ||
      block.type === 'gallery' ||
      block.type === 'calendar')
    ? block
    : null;
}

export function RecordDrawer({
  block,
  rowId,
  onClose,
}: {
  block: RecordBlock | null;
  rowId: string | null;
  onClose: () => void;
}) {
  const open = Boolean(block && rowId);
  const row = block?.record && rowId ? block.record.rows[rowId] : undefined;
  const actions: ComputedAction[] = block?.actions ?? [];
  // La ficha se monta en un portal, fuera del envoltorio de la vista: lleva
  // su propia copia de la marca para que sus botones y acentos sean los mismos.
  const scope = useBrandScope();
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 animate-veil bg-canvas/60 backdrop-blur-[2px]" />
        <Dialog.Content
          style={scope.style}
          className={clsx(
            scope.className,
            'fixed z-50 flex flex-col overflow-hidden border border-border bg-surface shadow-pop outline-none animate-veil',
            // Teléfono: hoja desde abajo. Desde sm: panel a la derecha.
            'inset-x-0 bottom-0 max-h-[88dvh] rounded-t-card',
            'sm:inset-x-auto sm:inset-y-3 sm:right-3 sm:max-h-none sm:w-[min(26rem,calc(100vw-1.5rem))] sm:rounded-card',
          )}
        >
          <div className="relative flex items-start justify-between gap-3 border-b border-border px-5 py-4">
            <span aria-hidden className="view-brand-stripe absolute inset-x-0 top-0 h-1" />
            <div className="min-w-0">
              <Dialog.Title className="truncate text-lg font-bold tracking-tight text-ink">
                {row?.label ?? 'Fila'}
              </Dialog.Title>
              <Dialog.Description className="truncate text-micro text-ink-faint">
                {block ? `${block.title} · ${block.source}` : ''}
              </Dialog.Description>
            </div>
            <Dialog.Close
              aria-label="Cerrar la ficha"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-pill text-ink-faint transition-colors duration-150 hover:bg-surface-2 hover:text-ink"
            >
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>

          <div className="scroll-slim min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {!row || !block?.record || !rowId ? (
              <p className="py-8 text-center text-sm text-ink-muted">
                Esta fila ya no está en el bloque: cambió o un filtro la dejó por fuera.
              </p>
            ) : (
              <>
                <dl className="divide-y divide-border/70">
                  {block.record.fields.map((f, i) => {
                    const display = row.values[i] ?? '—';
                    return (
                      <div
                        key={f.key}
                        className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-3 py-2.5"
                      >
                        <dt className="pt-0.5 text-micro font-semibold text-ink-faint">
                          {f.label}
                        </dt>
                        <dd
                          className={clsx(
                            'min-w-0 break-words text-sm text-ink',
                            f.kind !== 'text' && 'tabular font-mono text-xs',
                          )}
                        >
                          {f.edit ? (
                            <EditableValue
                              blockId={block.id}
                              rowId={rowId}
                              field={f.key}
                              edit={f.edit}
                              raw={row.raw[i] ?? null}
                              display={display}
                              label={f.label}
                            />
                          ) : (
                            display
                          )}
                        </dd>
                      </div>
                    );
                  })}
                </dl>
                {actions.length > 0 && (
                  <div className="mt-4">
                    <RowActions
                      blockId={block.id}
                      actions={actions}
                      rowId={rowId}
                      rowLabel={row.label}
                    />
                  </div>
                )}
              </>
            )}
          </div>

          {row && (
            <footer className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border px-5 py-3 text-micro text-ink-faint">
              <span>
                Creada <span className="tabular font-mono">{formatWhen(row.createdAt)}</span>
              </span>
              <span>
                Actualizada <span className="tabular font-mono">{formatWhen(row.updatedAt)}</span>
              </span>
            </footer>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
