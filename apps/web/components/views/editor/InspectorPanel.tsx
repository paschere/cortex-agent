'use client';

import { clsx } from 'clsx';
import { MousePointerClick, X } from 'lucide-react';
import { useEffect, useRef } from 'react';

/**
 * DONDE SE AJUSTA LO ELEGIDO: columna a la derecha en escritorio, hoja que
 * sube desde abajo en el teléfono.
 *
 * Es un solo panel con dos pestañas —el bloque elegido y la vista entera— y no
 * dos, porque en 375 px no caben dos y en escritorio la persona no debería
 * tener que buscar dónde quedó «cada cuánto se refresca».
 *
 * En el teléfono la hoja tapa la mitad de abajo del lienzo, con un velo que
 * la cierra al tocarlo, y lleva el foco a su título al abrirse para que el
 * lector de pantalla diga dónde está. En escritorio está siempre.
 */
export function InspectorPanel({
  tab,
  onTab,
  hasBlock,
  blockTitle,
  open,
  onClose,
  scrollKey,
  children,
}: {
  tab: 'block' | 'view';
  onTab: (tab: 'block' | 'view') => void;
  hasBlock: boolean;
  blockTitle: string | null;
  /** Sólo cuenta en el teléfono: en escritorio el panel está siempre. */
  open: boolean;
  onClose: () => void;
  /** Cambia cuando se elige otra cosa: el panel vuelve arriba en vez de quedarse a media altura. */
  scrollKey: string;
  children: React.ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const body = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrollKey es justamente el disparador.
  useEffect(() => {
    if (body.current) body.current.scrollTop = 0;
  }, [scrollKey]);
  useEffect(() => {
    if (open && window.matchMedia('(max-width: 1023px)').matches) heading.current?.focus();
  }, [open]);

  return (
    <>
      {open && (
        // biome-ignore lint/a11y/useKeyWithClickEvents: el velo es sólo para el dedo; el teclado cierra con Escape o con el botón «Cerrar ajustes».
        <div
          aria-hidden
          onClick={onClose}
          className="fixed inset-0 z-40 animate-veil bg-canvas/60 backdrop-blur-[2px] lg:hidden"
        />
      )}
      <aside
        aria-label="Ajustes"
        className={clsx(
          'fixed inset-x-0 bottom-0 z-50 flex max-h-[78vh] flex-col rounded-t-card border border-border bg-surface shadow-pop transition-transform duration-200 ease-out motion-reduce:transition-none',
          open ? 'translate-y-0' : 'invisible translate-y-full',
          'lg:visible lg:sticky lg:inset-auto lg:top-[4.5rem] lg:z-auto lg:max-h-[calc(100vh-7.5rem)] lg:translate-y-0 lg:self-start lg:rounded-card lg:shadow-card',
        )}
      >
        <div
          className="mx-auto mt-2 h-1 w-10 rounded-pill bg-border-strong lg:hidden"
          aria-hidden
        />
        <div className="flex items-center gap-2 border-b border-border px-4 pb-3 pt-2 lg:pt-3">
          <h2 ref={heading} tabIndex={-1} className="sr-only">
            {tab === 'block' && blockTitle ? `Ajustes de ${blockTitle}` : 'Ajustes de la vista'}
          </h2>
          <div
            role="tablist"
            aria-label="Qué ajustar"
            className="flex flex-1 gap-0.5 rounded-pill bg-surface-2 p-0.5"
          >
            {(
              [
                ['block', 'Bloque'],
                ['view', 'Vista'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => onTab(id)}
                className={clsx(
                  'flex-1 rounded-pill px-3 py-1 text-xs font-semibold transition-colors duration-150',
                  tab === id ? 'bg-surface text-ink shadow-card' : 'text-ink-muted hover:text-ink',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar ajustes"
            className="grid h-8 w-8 place-items-center rounded-pill text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink lg:hidden"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div
          ref={body}
          role="tabpanel"
          className="scroll-slim min-h-0 flex-1 overflow-y-auto px-4 py-4"
        >
          {tab === 'block' && !hasBlock ? (
            <div className="flex flex-col items-center gap-2 px-2 py-8 text-center">
              <MousePointerClick className="h-6 w-6 text-ink-faint" aria-hidden />
              <p className="text-sm font-semibold text-ink">Elige un bloque</p>
              <p className="text-xs leading-relaxed text-ink-muted">
                Tócalo en el lienzo para cambiar su título, sus datos, sus filtros o su ancho.
              </p>
            </div>
          ) : (
            children
          )}
        </div>
      </aside>
    </>
  );
}
