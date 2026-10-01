'use client';

import { WIDTH_LABEL } from '@/lib/views/editor-shape';
import { titleOf } from '@/lib/views/editor-spec';
import { renameBlock } from '@/lib/views/studio';
import type { ViewBlock, ViewSpec } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { AlertTriangle, GripVertical, Pencil } from 'lucide-react';
import { useRef, useState } from 'react';
import { blockIcon, blockLabel } from '../editor/block-meta';

/**
 * «CAPAS»: LA VISTA COMO UNA LISTA.
 *
 * En el lienzo una vista larga obliga a bajar para encontrar «la tabla de
 * abajo»; aquí está entera en una columna, en el orden en que se pinta. Sirve
 * para elegir un bloque (el lienzo baja hasta él), cambiarle el orden
 * arrastrando por el asa o con Alt+flechas, y renombrarlo con doble clic o el
 * lápiz. Un bloque de texto no tiene título: se nombra por su primera línea y
 * se cambia en el inspector.
 */

export function LayersPanel({
  spec,
  selectedId,
  problems,
  onSelect,
  onMove,
  onChange,
}: {
  spec: ViewSpec;
  selectedId: string | null;
  problems: Map<string, string[]>;
  onSelect: (id: string) => void;
  onMove: (from: number, to: number) => void;
  onChange: (id: string, next: ViewBlock) => void;
}) {
  const list = useRef<HTMLOListElement>(null);
  const start = useRef<{ from: number; y: number; mids: number[] } | null>(null);
  const [drag, setDrag] = useState<{ from: number; to: number; dy: number } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  function targetIndex(y: number, mids: number[]): number {
    const i = mids.findIndex((m) => y < m);
    return i < 0 ? mids.length - 1 : i;
  }

  return (
    <div>
      <p className="mb-2 text-micro leading-relaxed text-ink-muted">
        {spec.blocks.length} {spec.blocks.length === 1 ? 'bloque' : 'bloques'}, de arriba abajo.
        Arrastra por el asa para cambiar el orden; doble clic para renombrar.
      </p>
      <ol ref={list} className="space-y-1">
        {spec.blocks.map((block, index) => {
          const Icon = blockIcon(block.type);
          const title = titleOf(block);
          const selected = selectedId === block.id;
          const warn = (problems.get(block.id) ?? []).length > 0;
          const renameable = 'title' in block && typeof block.title === 'string';
          const moving = drag?.from === index;
          const showLine =
            drag && drag.to === index && drag.from !== index
              ? drag.to > drag.from
                ? 'after'
                : 'before'
              : null;
          return (
            <li
              key={block.id}
              data-layer
              className={clsx(
                'relative transition-transform duration-150 motion-reduce:transition-none',
                moving && 'z-10 transition-none',
              )}
              style={moving ? { transform: `translateY(${drag.dy}px)` } : undefined}
            >
              {showLine && (
                <span
                  aria-hidden
                  className={clsx(
                    'pointer-events-none absolute inset-x-1 h-0.5 rounded-pill bg-primary',
                    showLine === 'before' ? '-top-1' : '-bottom-1',
                  )}
                />
              )}
              <div
                className={clsx(
                  'flex items-center gap-1 rounded-sm border px-1 py-1 transition-colors duration-150',
                  selected
                    ? 'border-primary/50 bg-primary-soft/50'
                    : 'border-transparent hover:bg-surface-2',
                  moving && 'border-border-strong bg-surface shadow-pop',
                )}
              >
                <button
                  type="button"
                  aria-label={`Mover «${title}». Alt y flechas también lo mueven.`}
                  className="grid h-6 w-5 shrink-0 cursor-grab touch-none place-items-center rounded-pill text-ink-faint hover:text-ink active:cursor-grabbing"
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    e.currentTarget.setPointerCapture(e.pointerId);
                    const items = [
                      ...(list.current?.querySelectorAll<HTMLElement>('[data-layer]') ?? []),
                    ];
                    start.current = {
                      from: index,
                      y: e.clientY,
                      mids: items.map((el) => {
                        const r = el.getBoundingClientRect();
                        return r.top + r.height / 2;
                      }),
                    };
                  }}
                  onPointerMove={(e) => {
                    const s = start.current;
                    if (!s) return;
                    const dy = e.clientY - s.y;
                    if (!drag && Math.abs(dy) < 4) return;
                    setDrag({ from: s.from, to: targetIndex(e.clientY, s.mids), dy });
                  }}
                  onPointerUp={() => {
                    if (drag && drag.to !== drag.from) onMove(drag.from, drag.to);
                    start.current = null;
                    setDrag(null);
                  }}
                  onPointerCancel={() => {
                    start.current = null;
                    setDrag(null);
                  }}
                  onKeyDown={(e) => {
                    const step = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
                    if (!step) return;
                    e.preventDefault();
                    const to = index + step;
                    if (to >= 0 && to < spec.blocks.length) onMove(index, to);
                  }}
                >
                  <GripVertical className="h-3.5 w-3.5" />
                </button>
                <Icon className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
                {editing === block.id && renameable ? (
                  <input
                    // biome-ignore lint/a11y/noAutofocus: se abre a pedido, con doble clic o el lápiz.
                    autoFocus
                    defaultValue={title}
                    aria-label="Nuevo nombre del bloque"
                    maxLength={120}
                    onFocus={(e) => e.currentTarget.select()}
                    onBlur={(e) => {
                      const next = renameBlock(block, e.currentTarget.value);
                      if (next && e.currentTarget.value.trim()) onChange(block.id, next);
                      setEditing(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                      if (e.key === 'Escape') setEditing(null);
                    }}
                    className="min-w-0 flex-1 rounded-sm border border-primary bg-surface px-1.5 py-0.5 text-xs text-ink outline-none"
                  />
                ) : (
                  <button
                    type="button"
                    aria-pressed={selected}
                    onClick={() => onSelect(block.id)}
                    onDoubleClick={() => renameable && setEditing(block.id)}
                    onKeyDown={(e) => {
                      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                        e.preventDefault();
                        const to = index + (e.key === 'ArrowUp' ? -1 : 1);
                        if (to >= 0 && to < spec.blocks.length) onMove(index, to);
                      } else if (e.key === 'F2' && renameable) setEditing(block.id);
                    }}
                    className="flex min-w-0 flex-1 flex-col items-start rounded-sm px-1 py-0.5 text-left"
                  >
                    <span className="w-full truncate text-xs font-semibold text-ink">{title}</span>
                    <span className="text-micro text-ink-faint">
                      {blockLabel(block.type)}
                      {' · '}
                      {WIDTH_LABEL[block.width as keyof typeof WIDTH_LABEL]?.long ?? block.width}
                    </span>
                  </button>
                )}
                {warn && (
                  <AlertTriangle
                    className="h-3.5 w-3.5 shrink-0 text-amber"
                    aria-label="Tiene algo por corregir"
                  />
                )}
                {renameable && editing !== block.id && (
                  <button
                    type="button"
                    onClick={() => setEditing(block.id)}
                    aria-label={`Renombrar «${title}»`}
                    title="Renombrar (F2)"
                    className="grid h-6 w-6 shrink-0 place-items-center rounded-pill text-ink-faint opacity-60 transition-opacity hover:bg-surface-2 hover:text-ink hover:opacity-100 focus-visible:opacity-100"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
