'use client';

import {
  GRID_COLS,
  type ZoneRect,
  moveZone,
  overlapping,
  placeZone,
  removeZone,
  resizeZone,
  visibleRows,
} from '@/lib/views/zone-layout';
import * as Dialog from '@radix-ui/react-dialog';
import { clsx } from 'clsx';
import { Grid3x3, MapPinned, Plus, RotateCcw, X } from 'lucide-react';
import { useRef, useState } from 'react';

/**
 * DIBUJAR EL PLANO A MANO.
 *
 * Una rejilla de 12 columnas donde cada zona (una opción del campo de
 * opciones: muelle, posición, bodega, sala) es un rectángulo que se ARRASTRA
 * para moverlo y se ESTIRA desde la esquina para cambiarle el tamaño. Todo
 * cae en celdas enteras, y lo que se puede y no se puede lo deciden las
 * funciones de lib/views/zone-layout.ts — las mismas para ratón, dedo y
 * teclado.
 *
 * Teclado: con una zona elegida, las flechas la mueven y Mayús+flechas la
 * estiran o encogen. Supr la saca del plano (vuelve a acomodarse sola).
 *
 * Las zonas sin ubicar salen abajo como fichas: tocarlas las pone en el primer
 * hueco libre. «Acomodar solas» borra el dibujo y deja que el plano se arme en
 * filas de tres, que es lo que pasa cuando no hay dibujo.
 */

type Drag =
  | { kind: 'move'; zone: string; startX: number; startY: number; origin: ZoneRect }
  | { kind: 'resize'; zone: string; startX: number; startY: number; origin: ZoneRect };

const CELL_H = 44;

export function ZoneDrawer({
  zones,
  layout,
  onChange,
}: {
  /** Las opciones del campo: todas las zonas posibles. */
  zones: string[];
  layout: ZoneRect[];
  onChange: (next: ZoneRect[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ZoneRect[]>(layout);
  const [selected, setSelected] = useState<string | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);

  const rows = visibleRows(draft);
  const clashes = overlapping(draft);
  const unplaced = zones.filter((z) => !draft.some((r) => r.zone === z));

  function cellSize() {
    const width = grid.current?.getBoundingClientRect().width ?? 600;
    return { w: width / GRID_COLS, h: CELL_H };
  }

  function onPointerDown(e: React.PointerEvent, zone: string, kind: Drag['kind']) {
    const origin = draft.find((r) => r.zone === zone);
    if (!origin) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    setSelected(zone);
    drag.current = { kind, zone, startX: e.clientX, startY: e.clientY, origin };
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const cell = cellSize();
    const dx = Math.round((e.clientX - d.startX) / cell.w);
    const dy = Math.round((e.clientY - d.startY) / cell.h);
    setDraft((current) =>
      d.kind === 'move'
        ? moveZone(current, d.zone, d.origin.x + dx, d.origin.y + dy)
        : resizeZone(current, d.zone, d.origin.w + dx, d.origin.h + dy),
    );
  }

  function onKeyDown(e: React.KeyboardEvent, zone: string) {
    const r = draft.find((x) => x.zone === zone);
    if (!r) return;
    const step: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      setDraft((c) => removeZone(c, zone));
      return;
    }
    const s = step[e.key];
    if (!s) return;
    e.preventDefault();
    setDraft((c) =>
      e.shiftKey
        ? resizeZone(c, zone, r.w + s[0], r.h + s[1])
        : moveZone(c, zone, r.x + s[0], r.y + s[1]),
    );
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setDraft(layout);
          setSelected(null);
        }
        setOpen(next);
      }}
    >
      <Dialog.Trigger className="inline-flex w-full items-center justify-center gap-1.5 rounded-pill border border-border-strong bg-surface px-3 py-2 text-xs font-semibold text-ink shadow-card transition-colors hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary">
        <MapPinned className="h-3.5 w-3.5 text-primary" aria-hidden />
        {layout.length ? 'Editar el dibujo del plano' : 'Dibujar el plano a mano'}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[92vh] w-[min(980px,calc(100vw-1rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-card border border-border bg-surface shadow-pop outline-none">
          <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
            <div>
              <Dialog.Title className="flex items-center gap-2 text-sm font-bold text-ink">
                <Grid3x3 className="h-4 w-4 text-primary" aria-hidden /> Dibuja el plano
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 text-micro text-ink-faint">
                Arrastra una zona para moverla y la esquina para cambiar su tamaño. Con el teclado:
                flechas mueven, Mayús+flechas estiran, Supr la saca.
              </Dialog.Description>
            </div>
            <Dialog.Close
              aria-label="Cerrar"
              className="grid h-8 w-8 place-items-center rounded-card text-ink-faint hover:bg-surface-2 hover:text-ink"
            >
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>

          <div className="scroll-slim min-h-0 flex-1 overflow-auto p-4 sm:p-5">
            <div className="overflow-x-auto">
              <div
                ref={grid}
                onPointerMove={onPointerMove}
                onPointerUp={() => {
                  drag.current = null;
                }}
                onPointerCancel={() => {
                  drag.current = null;
                }}
                onPointerDown={() => setSelected(null)}
                className="relative min-w-[36rem] touch-none select-none rounded-sm border border-border bg-surface-2/40"
                style={{
                  height: rows * CELL_H,
                  backgroundImage:
                    'linear-gradient(to right, rgb(var(--border) / 0.7) 1px, transparent 1px), linear-gradient(to bottom, rgb(var(--border) / 0.7) 1px, transparent 1px)',
                  backgroundSize: `calc(100% / ${GRID_COLS}) ${CELL_H}px`,
                }}
              >
                {draft.map((r) => {
                  const active = selected === r.zone;
                  const clash = clashes.has(r.zone);
                  return (
                    // biome-ignore lint/a11y/useSemanticElements: una zona del plano se arrastra; un botón no puede.
                    <div
                      key={r.zone}
                      role="button"
                      tabIndex={0}
                      aria-label={`${r.zone}: columna ${r.x + 1}, fila ${r.y + 1}, ${r.w} de ancho por ${r.h} de alto`}
                      aria-pressed={active}
                      onPointerDown={(e) => onPointerDown(e, r.zone, 'move')}
                      onKeyDown={(e) => onKeyDown(e, r.zone)}
                      onFocus={() => setSelected(r.zone)}
                      className={clsx(
                        'group absolute flex cursor-grab flex-col rounded-sm border-2 p-2 text-xs font-semibold shadow-card transition-[box-shadow,border-color] duration-150 active:cursor-grabbing focus:outline-none',
                        clash
                          ? 'border-rose bg-rose-soft/70 text-ink'
                          : active
                            ? 'border-primary bg-primary-soft text-ink ring-2 ring-primary/30'
                            : 'border-primary/40 bg-primary-soft/50 text-ink',
                      )}
                      style={{
                        left: `calc(${(r.x / GRID_COLS) * 100}% + 2px)`,
                        top: r.y * CELL_H + 2,
                        width: `calc(${(r.w / GRID_COLS) * 100}% - 4px)`,
                        height: r.h * CELL_H - 4,
                      }}
                    >
                      <span className="truncate">{r.zone}</span>
                      <span className="text-micro font-normal text-ink-faint">
                        {r.w}×{r.h}
                        {clash ? ' · se pisa con otra' : ''}
                      </span>
                      <button
                        type="button"
                        aria-label={`Sacar ${r.zone} del plano`}
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => setDraft((c) => removeZone(c, r.zone))}
                        className={clsx(
                          'absolute right-1 top-1 grid h-5 w-5 place-items-center rounded-full text-ink-faint hover:bg-surface hover:text-ink',
                          !active && 'opacity-0 group-hover:opacity-100',
                        )}
                      >
                        <X className="h-3 w-3" />
                      </button>
                      <span
                        aria-hidden
                        onPointerDown={(e) => onPointerDown(e, r.zone, 'resize')}
                        className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize rounded-br-sm border-b-2 border-r-2 border-primary"
                      />
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="mt-4">
              <p className="field-label mb-2">Zonas sin ubicar</p>
              {unplaced.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {unplaced.map((z) => (
                    <button
                      key={z}
                      type="button"
                      onClick={() => {
                        setDraft((c) => placeZone(c, z));
                        setSelected(z);
                      }}
                      className="inline-flex items-center gap-1 rounded-pill border border-border bg-surface px-2.5 py-1 text-xs text-ink-muted transition-colors hover:border-primary hover:text-ink"
                    >
                      <Plus className="h-3 w-3" /> {z}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-micro text-ink-faint">Todas las zonas están en el plano.</p>
              )}
              <p className="mt-2 text-micro text-ink-faint">
                Las zonas son las opciones del campo. Para una zona nueva, agrega la opción a la
                tabla y aparecerá aquí. Las que no ubiques se acomodan solas debajo.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-3">
            <button
              type="button"
              onClick={() => setDraft([])}
              className="inline-flex items-center gap-1.5 rounded-pill px-3 py-1.5 text-xs font-semibold text-ink-muted hover:bg-surface-2 hover:text-ink"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Acomodar solas
            </button>
            <div className="flex items-center gap-2">
              <Dialog.Close className="rounded-pill px-3 py-1.5 text-xs font-semibold text-ink-muted hover:bg-surface-2 hover:text-ink">
                Cancelar
              </Dialog.Close>
              <button
                type="button"
                onClick={() => {
                  onChange(draft);
                  setOpen(false);
                }}
                className="cortex-primary-button rounded-pill bg-primary px-4 py-1.5 text-xs font-semibold text-white hover:bg-primary-strong"
              >
                Usar este plano
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
