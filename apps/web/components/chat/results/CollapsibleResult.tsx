'use client';

import { clsx } from 'clsx';
import { ChevronDown, Table2 } from 'lucide-react';
import { type ReactNode, useId, useLayoutEffect, useRef, useState } from 'react';

/**
 * UN RESULTADO LARGO, EN UNA FILA DE UNA LÍNEA.
 *
 * El lienzo del chat lo pide así: una tabla de diez filas, una lista de
 * registros o una búsqueda no deben empujar la respuesta fuera de la pantalla.
 * Se pliegan en una fila —«Tablas usadas · 10 filas ▾»— y se abren con un
 * toque. Es GENÉRICO a propósito: no sabe de ninguna herramienta, sólo mide.
 *
 *   · lo corto se queda abierto: si el resultado cabe en `LIMIT` px, esto no
 *     añade ni una fila (y no hay salto: se mide antes de pintar);
 *   · lo largo arranca plegado y, una vez que la persona lo abre, se queda
 *     abierto aunque el contenido siga creciendo;
 *   · el contenido sigue montado mientras está plegado (sólo oculto), así que
 *     abrirlo no pierde el estado de la rejilla ni vuelve a pedir nada.
 */
const LIMIT = 280;

export function CollapsibleResult({
  title,
  count,
  unit = 'filas',
  skip = false,
  children,
}: {
  title: string;
  /** Cuántos registros trae, si se sabe. */
  count?: number | null;
  unit?: string;
  /** Lo que nunca se pliega (entregables, tarjetas vivas). */
  skip?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    if (skip) return;
    const el = ref.current;
    if (!el) return;
    const measure = () => setLong(el.scrollHeight > LIMIT);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [skip]);

  if (skip) return <>{children}</>;
  const folded = long && !open;

  return (
    <div>
      {long && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={id}
          className={clsx(
            'flex min-h-11 w-full items-center gap-2.5 rounded-card border border-border bg-surface px-3.5 text-left text-sm text-ink transition-colors duration-150 hover:bg-surface-2 motion-reduce:transition-none',
            open && 'mb-1.5',
          )}
        >
          <Table2 className="h-4 w-4 shrink-0 text-primary" strokeWidth={1.75} aria-hidden />
          <span className="min-w-0 flex-1 truncate">
            <span className="font-semibold">{title}</span>
            {typeof count === 'number' && count > 0 && (
              <span className="text-ink-faint">
                {' '}
                · {count} {count === 1 ? unit.replace(/s$/, '') : unit}
              </span>
            )}
          </span>
          <ChevronDown
            className={clsx(
              'h-4 w-4 shrink-0 text-ink-faint transition-transform duration-150 motion-reduce:transition-none',
              open && 'rotate-180',
            )}
            aria-hidden
          />
        </button>
      )}
      <div
        id={id}
        ref={ref}
        // Plegado: mide 0 pero conserva su scrollHeight, y `invisible` lo saca
        // del orden de tabulación y de los lectores de pantalla.
        className={clsx(folded && 'invisible max-h-0 overflow-hidden')}
        aria-hidden={folded || undefined}
      >
        {children}
      </div>
    </div>
  );
}
