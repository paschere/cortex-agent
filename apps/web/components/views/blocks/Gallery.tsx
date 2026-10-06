'use client';

import type { ComputedBlock } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { LayoutGrid } from 'lucide-react';
import { useState } from 'react';
import { useFlashClass } from '../flash-context';
import { RowActions } from '../view-writes';
import { useRecordOpener } from './RecordDrawer';
import { RichValue } from './RichValue';
import { Card, EmptyState, StatusChip, useViewTheme } from './theme';

/**
 * LA GALERÍA: TARJETAS EN REJILLA.
 *
 * Inmuebles, vehículos, cursos, pacientes, productos: cualquier lista que se
 * lee mejor por tarjeta. Cada tarjeta es UN botón que abre la ficha (el patrón
 * del enlace estirado: el título es el botón y su `::after` cubre la tarjeta),
 * y los botones de la fila quedan por encima para que no abran la ficha.
 *
 * La imagen sólo se pinta si el cálculo la dejó pasar (`https:` público) y se
 * vuelve a comprobar aquí: `loading="lazy"`, sin referrer —quien sirve la foto
 * no se entera de qué vista la mostró— y, si falla, la tarjeta sigue sin ella.
 */

type Gallery = Extract<ComputedBlock, { type: 'gallery' }>;

const COLS: Record<Gallery['columns'], string> = {
  2: 'sm:grid-cols-2',
  3: 'sm:grid-cols-2 lg:grid-cols-3',
  4: 'sm:grid-cols-2 lg:grid-cols-4',
};

function initialsOf(text: string): string {
  const words = text.trim().split(/\s+/);
  // Una sola palabra («WXK-482», «Kenworth»): sus dos primeros caracteres.
  if (words.length === 1) return (words[0] ?? '').slice(0, 2).toLocaleUpperCase('es-CO') || '·';
  return (
    words
      .filter((w) => /^[\p{L}\p{N}]/u.test(w))
      .slice(0, 2)
      .map((w) => w.charAt(0).toLocaleUpperCase('es-CO'))
      .join('') || '·'
  );
}

export function GalleryBlock({ block }: { block: Gallery }) {
  const open = useRecordOpener(block.id, block.record);
  const flash = useFlashClass();
  const { density } = useViewTheme();
  // Si ninguna tarjeta trae foto, cada una lleva sus iniciales: una rejilla de
  // huecos grises no es una galería.
  const anyImage = block.cards.some((c) => c.image);
  return (
    <Card
      title={block.title}
      source={`${block.total} ${block.total === 1 ? 'fila' : 'filas'} · ${block.source}`}
    >
      {block.cards.length === 0 ? (
        <EmptyState
          icon={<LayoutGrid className="h-5 w-5" aria-hidden />}
          title="Todavía no hay filas"
          hint="Cada fila nueva de la fuente aparece aquí como una tarjeta."
        />
      ) : (
        <ul
          className={clsx(
            'grid grid-cols-1',
            COLS[block.columns],
            density === 'compact' ? 'gap-2.5' : 'gap-4',
          )}
        >
          {block.cards.map((card) => (
            <li
              key={card.id}
              className={clsx(
                flash(block.id, card.id),
                'group relative flex flex-col overflow-hidden rounded-sm border shadow-card transition-all duration-150',
                card.alert ? 'border-rose/50 bg-rose-soft' : 'border-border bg-surface',
                open &&
                  'hover:-translate-y-0.5 hover:border-border-strong hover:shadow-pop focus-within:ring-2 focus-within:ring-primary/40',
              )}
            >
              {anyImage &&
                (card.image ? (
                  <CardImage src={card.image} />
                ) : (
                  <div
                    aria-hidden
                    className="grid aspect-[4/3] w-full place-items-center bg-primary-soft text-xl font-extrabold tracking-tight text-primary-ink"
                  >
                    {initialsOf(card.title)}
                  </div>
                ))}
              <div className={clsx('flex flex-1 flex-col', density === 'compact' ? 'p-3' : 'p-4')}>
                <div className="flex items-start gap-3">
                  {!anyImage && (
                    <span
                      aria-hidden
                      className="grid h-10 w-10 shrink-0 place-items-center rounded-sm bg-primary-soft text-xs font-extrabold tracking-tight text-primary-ink"
                    >
                      {initialsOf(card.title)}
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    {open ? (
                      <button
                        type="button"
                        onClick={() => open(card.id)}
                        className="block min-w-0 max-w-full truncate text-left text-sm font-bold text-ink outline-none after:absolute after:inset-0 after:content-['']"
                      >
                        {card.title}
                      </button>
                    ) : (
                      <p className="min-w-0 truncate text-sm font-bold text-ink">{card.title}</p>
                    )}
                    {card.subtitle && (
                      <p className="mt-0.5 truncate text-xs text-ink-muted">{card.subtitle}</p>
                    )}
                  </div>
                </div>
                {card.badge && (
                  <div className="mt-3">
                    <StatusChip value={card.badge.label} tone={card.badge.tone} />
                  </div>
                )}
                {card.meta.length > 0 && (
                  <dl className="mt-3 space-y-1 border-t border-border/70 pt-3">
                    {card.meta.map((m) => (
                      <div key={m.label} className="flex justify-between gap-3 text-micro">
                        <dt className="shrink-0 text-ink-faint">{m.label}</dt>
                        <dd className="tabular truncate font-mono text-ink">
                          <RichValue kind={m.kind} raw={m.raw} text={m.value} size={28} />
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
                {block.actions.length > 0 && (
                  <div className="relative z-10 mt-auto pt-3">
                    <RowActions
                      blockId={block.id}
                      actions={block.actions}
                      rowId={card.id}
                      rowLabel={card.title}
                    />
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {block.total > block.cards.length && (
        <p className="mt-3 text-micro text-ink-faint">
          Se muestran {block.cards.length} de {block.total}.
        </p>
      )}
    </Card>
  );
}

function CardImage({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed || !src.startsWith('https://')) return null;
  return (
    <div className="aspect-[4/3] w-full overflow-hidden bg-surface-2">
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className="h-full w-full object-cover"
      />
    </div>
  );
}
