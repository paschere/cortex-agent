'use client';

import type { EditorWidth } from '@/lib/views/editor-shape';
import {
  type DropMeasure,
  type DropSpot,
  type StudioDevice,
  deviceColumns,
  deviceSpan,
  locateDrop,
} from '@/lib/views/studio';
import type { ComputedBlock, ViewSpec } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { MousePointerClick, Plus, Sparkles } from 'lucide-react';
import { useRef, useState } from 'react';
import { BlockFrame } from './BlockFrame';

/**
 * LA REJILLA DEL LIENZO Y EL ARRASTRE.
 *
 * Arrastrar es con eventos de puntero, no con el drag-and-drop de HTML5: el de
 * HTML5 no existe en el teléfono, pinta un fantasma que no se controla y no
 * deja ver dónde va a caer el bloque. Aquí el bloque sigue al dedo, una barra
 * de color dice dónde caería, y nada cambia en el spec hasta que se suelta.
 *
 * Dónde cae: los rectángulos de todos los marcos se miden UNA vez al empezar
 * (mientras se arrastra el orden no cambia, así que no se mueven) y
 * `locateDrop` (lib/views/studio.ts) decide. Menos de 5 px de movimiento es un
 * clic, no un arrastre.
 *
 * LO QUE SE SUELTA DESDE AFUERA. Las piezas de la biblioteca del estudio se
 * arrastran con el mismo cálculo, pero lo lleva el estudio (que es quien sabe
 * qué pieza viene): aquí sólo llega `external` para pintar la barra y resaltar
 * el final. La rejilla lleva `data-studio-grid` para que el estudio la mida.
 *
 * LAS GUÍAS. Al pasar el puntero, y siempre mientras algo se arrastra, se ven
 * las seis columnas de la rejilla: un bloque sólo puede ocupar 2, 3 o 6, y
 * verlas explica por qué no cae «un poco más a la derecha».
 *
 * EL DISPOSITIVO (`device`) decide las columnas, no la ventana: el lienzo de un
 * computador puede estar mostrando cómo se ve la vista en un celular.
 */

interface DragState {
  id: string;
  from: number;
  dx: number;
  dy: number;
  insert: number | null;
  target: DropSpot['target'];
}

export function measureBlocks(grid: HTMLElement | null): DropMeasure[] {
  const box = grid?.getBoundingClientRect();
  return [...(grid?.querySelectorAll<HTMLElement>('[data-block-id]') ?? [])].map((el) => {
    const rect = el.getBoundingClientRect();
    return {
      id: el.dataset.blockId ?? '',
      rect,
      wide: box ? rect.width > box.width * 0.75 : true,
    };
  });
}

export function EditorCanvas({
  spec,
  computed,
  problems,
  selectedId,
  stale,
  canAdd,
  device,
  external,
  gridRef,
  onSelect,
  onMove,
  onWidth,
  onDuplicate,
  onRemove,
  onAdd,
  onAsk,
  announce,
}: {
  spec: ViewSpec;
  computed: Map<string, ComputedBlock>;
  problems: Map<string, string[]>;
  selectedId: string | null;
  stale: boolean;
  canAdd: boolean;
  device: StudioDevice;
  /** Una pieza de la biblioteca en vuelo: dónde caería. */
  external: DropSpot | null;
  gridRef?: React.RefObject<HTMLDivElement | null>;
  onSelect: (id: string) => void;
  onMove: (from: number, to: number) => void;
  onWidth: (id: string, width: EditorWidth) => void;
  onDuplicate: (id: string) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
  /** Lleva el foco a la caja de Cortex. */
  onAsk: () => void;
  announce: (message: string) => void;
}) {
  const ownGrid = useRef<HTMLDivElement>(null);
  const grid = gridRef ?? ownGrid;
  const start = useRef<{
    x: number;
    y: number;
    id: string;
    from: number;
    measures: DropMeasure[];
  } | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const count = spec.blocks.length;
  const columns = device === 'phone' ? 1 : 6;
  const dragging = Boolean(drag) || Boolean(external);
  // Una vista recién empezada: sólo el texto de bienvenida. Ahí el final del
  // lienzo no es un botón chico sino la explicación de cómo se arma.
  const barelyStarted = count <= 1 && spec.blocks[0]?.type === 'text';
  const endTarget = external?.insert === count;

  function gripProps(id: string, index: number): React.HTMLAttributes<HTMLButtonElement> {
    return {
      onPointerDown(e) {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = {
          x: e.clientX,
          y: e.clientY,
          id,
          from: index,
          measures: measureBlocks(grid.current),
        };
      },
      onPointerMove(e) {
        const s = start.current;
        if (!s) return;
        const dx = e.clientX - s.x;
        const dy = e.clientY - s.y;
        if (!drag && Math.hypot(dx, dy) < 5) return;
        setDrag({
          id: s.id,
          from: s.from,
          dx,
          dy,
          ...locateDrop(e.clientX, e.clientY, s.measures, s.from),
        });
      },
      onPointerUp() {
        const s = start.current;
        start.current = null;
        if (drag && s && drag.insert !== null) {
          const to = drag.insert > s.from ? drag.insert - 1 : drag.insert;
          onMove(s.from, to);
          announce(`Movido a la posición ${to + 1} de ${count}.`);
        }
        setDrag(null);
      },
      onPointerCancel() {
        start.current = null;
        setDrag(null);
      },
      onKeyDown(e) {
        if (e.key === 'Escape' && drag) {
          start.current = null;
          setDrag(null);
          return;
        }
        const step =
          e.key === 'ArrowUp' || e.key === 'ArrowLeft'
            ? -1
            : e.key === 'ArrowDown' || e.key === 'ArrowRight'
              ? 1
              : 0;
        if (!step) return;
        e.preventDefault();
        e.stopPropagation();
        const to = index + step;
        if (to < 0 || to >= count) return;
        onMove(index, to);
        announce(`Movido a la posición ${to + 1} de ${count}.`);
      },
    };
  }

  const indicatorFor = (id: string) =>
    drag?.target?.id === id
      ? drag.target.side
      : external?.target?.id === id
        ? external.target.side
        : null;

  return (
    <div className="group/canvas relative">
      {/* Las seis columnas, detrás de los bloques. */}
      <div
        aria-hidden
        className={clsx(
          'pointer-events-none absolute -inset-x-1 -inset-y-1 grid gap-4 transition-opacity duration-150 motion-reduce:transition-none',
          deviceColumns(device),
          dragging ? 'opacity-100' : 'opacity-0 group-hover/canvas:opacity-100',
        )}
      >
        {Array.from({ length: columns }, (_, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: columnas fijas de la rejilla.
            key={i}
            className="rounded-sm bg-primary/[0.035] ring-1 ring-inset ring-primary/10"
          />
        ))}
      </div>

      <div
        ref={grid}
        data-studio-grid
        className={clsx('relative grid gap-4', deviceColumns(device))}
      >
        {spec.blocks.map((block, index) => (
          <BlockFrame
            key={block.id}
            block={block}
            computed={computed.get(block.id)}
            index={index}
            count={count}
            selected={selectedId === block.id}
            stale={stale}
            problems={problems.get(block.id) ?? []}
            drag={drag?.id === block.id ? { dx: drag.dx, dy: drag.dy } : null}
            indicator={indicatorFor(block.id)}
            span={deviceSpan(block.width, device)}
            resizable={device !== 'phone'}
            onSelect={() => onSelect(block.id)}
            onWidth={(w) => onWidth(block.id, w)}
            onMove={(to) => {
              if (to < 0 || to >= count) return;
              onMove(index, to);
              announce(`Movido a la posición ${to + 1} de ${count}.`);
            }}
            onDuplicate={() => onDuplicate(block.id)}
            onRemove={() => onRemove(block.id)}
            canDuplicate={canAdd}
            gripProps={gripProps(block.id, index)}
          />
        ))}

        {barelyStarted ? (
          <div
            className={clsx(
              'col-span-full flex flex-col items-center gap-3 rounded-card border-2 border-dashed px-6 py-12 text-center transition-colors duration-150',
              endTarget
                ? 'border-primary bg-primary-soft/40'
                : 'border-border-strong bg-surface/40',
            )}
          >
            <span className="grid h-11 w-11 place-items-center rounded-pill bg-primary-soft text-primary">
              <MousePointerClick className="h-5 w-5" aria-hidden />
            </span>
            <p className="text-base font-semibold text-ink">
              Arrastra una pieza aquí o pídeselo a Cortex
            </p>
            <p className="max-w-md text-xs leading-relaxed text-ink-muted">
              Empieza por una cifra, una tabla o un gráfico desde «Agregar», o escribe lo que
              quieres ver: «las facturas vencidas por cliente».
            </p>
            <div className="mt-1 flex flex-wrap justify-center gap-2">
              <button
                type="button"
                onClick={onAdd}
                disabled={!canAdd}
                className="inline-flex items-center gap-1.5 rounded-pill border border-border-strong bg-surface px-3 py-1.5 text-xs font-semibold text-ink shadow-card transition-all duration-150 hover:-translate-y-px hover:bg-surface-2"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden /> Agregar pieza
              </button>
              <button
                type="button"
                onClick={onAsk}
                className="inline-flex items-center gap-1.5 rounded-pill bg-primary-soft px-3 py-1.5 text-xs font-semibold text-primary transition-all duration-150 hover:-translate-y-px"
              >
                <Sparkles className="h-3.5 w-3.5" aria-hidden /> Pedírselo a Cortex
                <kbd className="ml-1 rounded-sm bg-surface/70 px-1 font-mono text-micro">⌘K</kbd>
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={onAdd}
            disabled={!canAdd}
            className={clsx(
              'col-span-full flex min-h-20 items-center justify-center gap-2 rounded-card border border-dashed px-4 py-5 text-sm font-semibold transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-45',
              endTarget
                ? 'border-primary bg-primary-soft/40 text-primary'
                : 'border-border-strong bg-surface/30 text-ink-muted hover:border-primary hover:bg-primary-soft/30 hover:text-primary',
            )}
          >
            <Plus className="h-4 w-4" aria-hidden />
            {canAdd ? 'Agregar bloque aquí' : 'Una vista admite hasta 24 bloques'}
          </button>
        )}
      </div>
    </div>
  );
}
