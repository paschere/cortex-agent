'use client';

import { type EditorWidth, WIDTHS, WIDTH_LABEL } from '@/lib/views/editor-shape';
import { titleOf } from '@/lib/views/editor-spec';
import type { ComputedBlock, ViewBlock } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { AlertTriangle, ChevronDown, ChevronUp, Copy, GripVertical, Trash2 } from 'lucide-react';
import { ViewBlockPreview } from '../ViewCanvas';
import { blockIcon, blockLabel } from './block-meta';

/**
 * UN BLOQUE EN EL LIENZO: SU DIBUJO DE VERDAD, CON UN MARCO ALREDEDOR.
 *
 * Dentro va el mismo `ViewBlockPreview` que pinta la vista guardada, inerte
 * (`inert`): en modo edición un clic elige el bloque, no ordena una tabla ni
 * envía un formulario. Encima, una barra con el asa para arrastrar, el nombre
 * y —cuando el bloque está elegido— el ancho, subir/bajar, duplicar y borrar.
 *
 * El asa también se maneja con el teclado: flechas para mover. Y todo lo del
 * asa existe además como botón, porque arrastrar no es algo que todo el mundo
 * pueda hacer.
 */

export const SPAN: Record<string, string> = {
  full: 'md:col-span-6',
  half: 'md:col-span-3',
  third: 'md:col-span-3 xl:col-span-2',
};

const ICON_BUTTON =
  'grid h-7 w-7 shrink-0 place-items-center rounded-pill text-ink-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-35';

export interface FrameDrag {
  dx: number;
  dy: number;
}

export function BlockFrame({
  block,
  computed,
  index,
  count,
  selected,
  stale,
  problems,
  drag,
  indicator,
  onSelect,
  onWidth,
  onMove,
  onDuplicate,
  onRemove,
  canDuplicate,
  gripProps,
}: {
  block: ViewBlock;
  computed: ComputedBlock | undefined;
  index: number;
  count: number;
  selected: boolean;
  stale: boolean;
  problems: string[];
  drag: FrameDrag | null;
  /** Dónde caería el bloque que se arrastra, respecto de éste. */
  indicator: 'left' | 'right' | 'top' | 'bottom' | null;
  onSelect: () => void;
  onWidth: (width: EditorWidth) => void;
  onMove: (to: number) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  canDuplicate: boolean;
  gripProps: React.HTMLAttributes<HTMLButtonElement>;
}) {
  const Icon = blockIcon(block.type);
  const title = titleOf(block);
  const label = blockLabel(block.type);
  return (
    <section
      data-block-id={block.id}
      className={clsx('relative min-w-0', SPAN[block.width] ?? SPAN.full, drag && 'z-30')}
      style={drag ? { transform: `translate3d(${drag.dx}px, ${drag.dy}px, 0)` } : undefined}
    >
      {indicator && (
        <span
          aria-hidden
          className={clsx(
            'pointer-events-none absolute z-20 rounded-pill bg-primary',
            indicator === 'left' && '-left-2.5 top-0 h-full w-1',
            indicator === 'right' && '-right-2.5 top-0 h-full w-1',
            indicator === 'top' && '-top-2.5 left-0 h-1 w-full',
            indicator === 'bottom' && '-bottom-2.5 left-0 h-1 w-full',
          )}
        />
      )}
      {/* El clic en cualquier parte del marco lo elige (comodidad del ratón y
          del dedo); el teclado lo elige con el botón del nombre, abajo. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: el equivalente de teclado es el botón con el nombre del bloque. */}
      <div
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('button, a, input, select, textarea')) return;
          onSelect();
        }}
        className={clsx(
          'group/frame relative h-full cursor-pointer rounded-card p-1.5 ring-1 transition-[box-shadow,background-color] duration-150 focus-within:ring-2',
          selected
            ? 'bg-primary-soft/30 ring-2 ring-primary'
            : problems.length
              ? 'ring-amber/50 hover:ring-amber focus-within:ring-amber'
              : 'ring-transparent hover:bg-surface-2/40 hover:ring-border-strong focus-within:ring-border-strong',
          drag && 'shadow-pop',
        )}
      >
        {selected && (
          // La barra flota sobre el borde del marco: elegir un bloque no le cambia la altura.
          <div className="absolute -top-4 right-2 z-20 flex items-center gap-0.5 rounded-pill border border-border-strong bg-surface p-0.5 shadow-pop">
            <fieldset className="mr-1 hidden items-center gap-0.5 rounded-pill bg-surface-2 p-0.5 md:inline-flex">
              <legend className="sr-only">Ancho</legend>
              {WIDTHS.map((w) => (
                <button
                  key={w}
                  type="button"
                  aria-pressed={block.width === w}
                  aria-label={WIDTH_LABEL[w].long}
                  title={WIDTH_LABEL[w].long}
                  onClick={() => onWidth(w)}
                  className={clsx(
                    'rounded-pill px-2 py-0.5 text-micro font-semibold transition-colors duration-150',
                    block.width === w
                      ? 'bg-surface text-ink shadow-card'
                      : 'text-ink-muted hover:text-ink',
                  )}
                >
                  {WIDTH_LABEL[w].short}
                </button>
              ))}
            </fieldset>
            <button
              type="button"
              className={ICON_BUTTON}
              aria-label="Mover antes"
              title="Mover antes"
              disabled={index === 0}
              onClick={() => onMove(index - 1)}
            >
              <ChevronUp className="h-4 w-4" />
            </button>
            <button
              type="button"
              className={ICON_BUTTON}
              aria-label="Mover después"
              title="Mover después"
              disabled={index === count - 1}
              onClick={() => onMove(index + 1)}
            >
              <ChevronDown className="h-4 w-4" />
            </button>
            <button
              type="button"
              className={ICON_BUTTON}
              aria-label="Duplicar"
              title="Duplicar"
              disabled={!canDuplicate}
              onClick={onDuplicate}
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className={clsx(ICON_BUTTON, 'hover:bg-rose-soft hover:text-rose')}
              aria-label="Eliminar"
              title={count <= 1 ? 'Una vista necesita al menos un bloque' : 'Eliminar'}
              disabled={count <= 1}
              onClick={onRemove}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        <div className="mb-1.5 flex items-center gap-1 px-0.5">
          <button
            type="button"
            aria-label={`Mover ${label.toLowerCase()} «${title}». Usa las flechas para cambiar su lugar.`}
            title="Arrastra para mover · flechas con el teclado"
            className={clsx(ICON_BUTTON, 'cursor-grab touch-none active:cursor-grabbing')}
            {...gripProps}
          >
            <GripVertical className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-pressed={selected}
            aria-label={`${label}: ${title}${problems.length ? ' (por corregir)' : ''}. Enter para ajustarlo; Suprimir para eliminarlo; Alt y flechas para moverlo.`}
            onClick={onSelect}
            onKeyDown={(e) => {
              if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                onRemove();
              } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowLeft')) {
                e.preventDefault();
                onMove(index - 1);
              } else if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowRight')) {
                e.preventDefault();
                onMove(index + 1);
              }
            }}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-pill px-1 py-0.5 text-left"
          >
            <Icon className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
            <span className="shrink-0 text-micro font-semibold text-ink-muted">{label}</span>
            <span className="truncate text-micro text-ink-faint">{title}</span>
          </button>
          {problems.length > 0 && (
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber" aria-hidden />
          )}
        </div>

        <div
          inert
          className={clsx(
            'pointer-events-none select-none transition-opacity duration-200',
            stale && 'opacity-60',
          )}
        >
          {computed ? (
            <ViewBlockPreview block={computed} />
          ) : (
            <div className="grid h-32 place-items-center rounded-card border border-dashed border-border-strong bg-surface-2/50 text-micro text-ink-faint">
              {stale ? 'Calculando…' : 'Sin vista previa todavía'}
            </div>
          )}
        </div>

        {problems.length > 0 && (
          <ul className="mt-1.5 space-y-0.5 px-1 pb-0.5">
            {problems.slice(0, 3).map((p) => (
              <li key={p} className="flex gap-1.5 text-micro leading-snug text-amber">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                <span>{p}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
