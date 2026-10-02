'use client';

import type { ComputedBlock } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { MapPin } from 'lucide-react';
import { useState } from 'react';
import { useRecordOpener } from './blocks/RecordDrawer';
import { RowActions, useViewWriter } from './view-writes';

/**
 * EL PLANO: UN TABLERO CON FORMA DE LUGAR.
 *
 * Cada zona es una opción del campo de opciones (una posición de plataforma,
 * un muelle, una bodega, una sala, una mesa) dibujada en una rejilla de 12
 * columnas; cada fila es una ficha dentro de su zona. Si la vista se puede
 * editar, arrastrar la ficha a otra zona cambia el campo — la misma escritura
 * que mover una tarjeta del tablero, validada en el servidor.
 *
 * En un teléfono la rejilla no cabe: las zonas se apilan en orden de lectura
 * (arriba-abajo, izquierda-derecha) y cada ficha trae un menú para moverla,
 * porque arrastrar con el dedo dentro de una página que hace scroll no
 * funciona bien.
 */

type Zones = Extract<ComputedBlock, { type: 'zones' }>;

const ROW_REM = 4.25;

export function ViewZones({
  block,
  Card,
}: {
  block: Zones;
  Card: (props: { title?: string; source?: string; children: React.ReactNode }) => React.ReactNode;
}) {
  const writer = useViewWriter();
  const open = useRecordOpener(block.id, block.record);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canDrag = Boolean(writer && block.dragField);
  const byKey = new Map(block.columns.map((c) => [c.key, c]));
  const rows = Math.max(...block.layout.map((l) => l.y + l.h), 2);
  const ordered = [...block.layout].sort((a, b) => a.y - b.y || a.x - b.x);

  async function moveTo(cardId: string, zone: string) {
    if (!writer || !block.dragField || zone === '__none') return;
    setError(null);
    const res = await writer.edit(block.id, cardId, { [block.dragField]: zone });
    if (!res.ok) setError(res.error);
  }

  return (
    <Card title={block.title} source={block.source}>
      <div
        className="view-floor -mx-1 flex flex-col gap-2.5 rounded-sm border border-border/60 bg-surface-2/40 p-2.5 md:mx-0 md:grid md:gap-2.5 md:p-3"
        style={{
          gridTemplateColumns: 'repeat(12, minmax(0, 1fr))',
          gridTemplateRows: `repeat(${rows}, minmax(${ROW_REM}rem, auto))`,
        }}
      >
        {ordered.map((place) => {
          const zone = byKey.get(place.zone);
          if (!zone) return null;
          const loose = zone.key === '__none';
          return (
            <section
              key={zone.key}
              aria-label={zone.label}
              onDragOver={(e) => {
                if (!canDrag || loose) return;
                e.preventDefault();
                setOver(zone.key);
              }}
              onDragLeave={() => setOver((o) => (o === zone.key ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                const id = e.dataTransfer.getData('text/plain') || dragging;
                setDragging(null);
                if (id) void moveTo(id, zone.key);
              }}
              style={{
                gridColumn: `${place.x + 1} / span ${place.w}`,
                gridRow: `${place.y + 1} / span ${place.h}`,
              }}
              className={clsx(
                'relative flex min-h-[4.25rem] flex-col overflow-hidden rounded-sm border p-2.5 shadow-card transition-colors duration-150',
                loose
                  ? 'border-dashed border-border-strong bg-surface/70 shadow-none'
                  : zone.count
                    ? 'border-primary/30 bg-surface'
                    : 'border-border bg-surface/80',
                over === zone.key && 'border-primary bg-primary-soft/60 ring-2 ring-primary/40',
              )}
            >
              {!loose && zone.count > 0 && (
                <span aria-hidden className="absolute inset-x-0 top-0 h-1 bg-primary" />
              )}
              <header className="mb-2 flex items-center justify-between gap-2 px-0.5">
                <span className="flex min-w-0 items-center gap-1.5 text-xs font-bold text-ink">
                  <MapPin
                    className={clsx(
                      'h-3.5 w-3.5 shrink-0',
                      zone.count && !loose ? 'text-primary' : 'text-ink-faint',
                    )}
                    aria-hidden
                  />
                  <span className="truncate">{zone.label}</span>
                </span>
                <span
                  className={clsx(
                    'tabular shrink-0 rounded-pill px-2 py-0.5 font-mono text-micro font-semibold',
                    zone.count && !loose
                      ? 'bg-primary-soft text-primary-ink'
                      : 'bg-surface-2 text-ink-faint',
                  )}
                >
                  {zone.count}
                </span>
              </header>
              {zone.count === 0 && (
                <p className="mt-auto px-0.5 text-micro text-ink-faint">Libre</p>
              )}
              <ul className="flex flex-wrap gap-1.5">
                {zone.cards.map((card) => (
                  <li
                    key={card.id}
                    draggable={canDrag}
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', card.id);
                      setDragging(card.id);
                    }}
                    onDragEnd={() => setDragging(null)}
                    title={card.details.map((d) => `${d.label}: ${d.value}`).join(' · ')}
                    className={clsx(
                      'max-w-full rounded-pill border border-border bg-surface-2/70 px-2.5 py-1 text-xs transition-colors hover:border-border-strong',
                      canDrag && 'cursor-grab active:cursor-grabbing',
                      dragging === card.id && 'opacity-50',
                    )}
                  >
                    {open ? (
                      <button
                        type="button"
                        onClick={() => open(card.id)}
                        className="tabular font-mono font-semibold text-ink underline-offset-4 hover:underline"
                      >
                        {card.label}
                      </button>
                    ) : (
                      <span className="tabular font-mono font-semibold text-ink">{card.label}</span>
                    )}
                    {card.details[0] && (
                      <span className="ml-1.5 text-micro text-ink-faint">
                        {card.details[0].value}
                      </span>
                    )}
                    {(block.actions.length > 0 || canDrag) && (
                      <span className="ml-1.5 inline-flex items-center gap-1 align-middle">
                        <RowActions
                          blockId={block.id}
                          actions={block.actions}
                          rowId={card.id}
                          rowLabel={card.label}
                        />
                        {canDrag && (
                          <select
                            aria-label={`Mover ${card.label}`}
                            value={zone.key}
                            onChange={(e) => void moveTo(card.id, e.target.value)}
                            className="rounded-pill border border-border bg-surface px-1.5 text-micro text-ink-muted md:hidden"
                          >
                            {block.columns
                              .filter((c) => c.key !== '__none' || c.key === zone.key)
                              .map((c) => (
                                <option key={c.key} value={c.key} disabled={c.key === '__none'}>
                                  {c.label}
                                </option>
                              ))}
                          </select>
                        )}
                      </span>
                    )}
                  </li>
                ))}
                {zone.count > zone.cards.length && (
                  <li className="px-1 text-micro text-ink-faint">
                    +{zone.count - zone.cards.length}
                  </li>
                )}
              </ul>
            </section>
          );
        })}
      </div>
      {error && <p className="mt-2 text-xs text-rose">{error}</p>}
    </Card>
  );
}
