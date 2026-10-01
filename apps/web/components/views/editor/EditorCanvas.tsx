'use client';

import type { EditorWidth } from '@/lib/views/editor-shape';
import type { ComputedBlock, ViewSpec } from '@cortex/agent-tools';
import { Plus } from 'lucide-react';
import { useRef, useState } from 'react';
import { BlockFrame } from './BlockFrame';

/**
 * LA REJILLA DEL LIENZO Y EL ARRASTRE.
 *
 * Arrastrar es con eventos de puntero, no con el drag-and-drop de HTML5: el de
 * HTML5 no existe en el teléfono, pinta un fantasma que no se controla y no
 * deja ver dónde va a caer el bloque. Aquí el bloque sigue al dedo, una barra
 * índigo dice dónde caería, y nada cambia en el spec hasta que se suelta.
 *
 * Dónde cae: los rectángulos de todos los marcos se miden UNA vez al empezar
 * (mientras se arrastra el orden no cambia, así que no se mueven). El bloque
 * bajo el puntero —o el más cercano— decide; en un bloque ancho la mitad de
 * arriba es «antes», en uno angosto la mitad izquierda. Menos de 5 px de
 * movimiento es un clic, no un arrastre.
 */

interface DragState {
  id: string;
  from: number;
  dx: number;
  dy: number;
  /** Posición de inserción 0..n, o null si cae donde ya estaba. */
  insert: number | null;
  target: { id: string; side: 'left' | 'right' | 'top' | 'bottom' } | null;
}

interface Measure {
  id: string;
  rect: DOMRect;
  wide: boolean;
}

export function EditorCanvas({
  spec,
  computed,
  problems,
  selectedId,
  stale,
  canAdd,
  onSelect,
  onMove,
  onWidth,
  onDuplicate,
  onRemove,
  onAdd,
  announce,
}: {
  spec: ViewSpec;
  computed: Map<string, ComputedBlock>;
  problems: Map<string, string[]>;
  selectedId: string | null;
  stale: boolean;
  canAdd: boolean;
  onSelect: (id: string) => void;
  onMove: (from: number, to: number) => void;
  onWidth: (id: string, width: EditorWidth) => void;
  onDuplicate: (id: string) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
  announce: (message: string) => void;
}) {
  const grid = useRef<HTMLDivElement>(null);
  const start = useRef<{
    x: number;
    y: number;
    id: string;
    from: number;
    measures: Measure[];
  } | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const count = spec.blocks.length;

  function measure(): Measure[] {
    const box = grid.current?.getBoundingClientRect();
    return [...(grid.current?.querySelectorAll<HTMLElement>('[data-block-id]') ?? [])].map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        id: el.dataset.blockId ?? '',
        rect,
        wide: box ? rect.width > box.width * 0.75 : true,
      };
    });
  }

  function locate(
    x: number,
    y: number,
    measures: Measure[],
    from: number,
  ): Pick<DragState, 'insert' | 'target'> {
    let best = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    measures.forEach(({ rect }, i) => {
      const dx = Math.max(rect.left - x, 0, x - rect.right);
      const dy = Math.max(rect.top - y, 0, y - rect.bottom);
      const d = Math.hypot(dx, dy);
      if (d < bestDistance) {
        bestDistance = d;
        best = i;
      }
    });
    const hit = measures[best];
    if (!hit || best === from) return { insert: null, target: null };
    const before = hit.wide
      ? y < hit.rect.top + hit.rect.height / 2
      : x < hit.rect.left + hit.rect.width / 2;
    const insert = before ? best : best + 1;
    // Caer justo antes o justo después de sí mismo es no moverse.
    if (insert === from || insert === from + 1) return { insert: null, target: null };
    const side = hit.wide ? (before ? 'top' : 'bottom') : before ? 'left' : 'right';
    return { insert, target: { id: hit.id, side } };
  }

  function gripProps(id: string, index: number): React.HTMLAttributes<HTMLButtonElement> {
    return {
      onPointerDown(e) {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, y: e.clientY, id, from: index, measures: measure() };
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
          ...locate(e.clientX, e.clientY, s.measures, s.from),
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

  return (
    <div ref={grid} className="grid grid-cols-1 gap-4 md:grid-cols-6">
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
          indicator={drag?.target?.id === block.id ? drag.target.side : null}
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
      <button
        type="button"
        onClick={onAdd}
        disabled={!canAdd}
        className="flex min-h-24 items-center justify-center gap-2 rounded-card border border-dashed border-border-strong bg-surface/40 px-4 py-6 text-sm font-semibold text-ink-muted transition-colors duration-150 hover:border-primary hover:bg-primary-soft/30 hover:text-primary disabled:cursor-not-allowed disabled:opacity-45 md:col-span-6"
      >
        <Plus className="h-4 w-4" />
        {canAdd ? 'Agregar bloque' : 'Una vista admite hasta 24 bloques'}
      </button>
    </div>
  );
}
