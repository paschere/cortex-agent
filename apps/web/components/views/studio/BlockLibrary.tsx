'use client';

import { KNOWN_BLOCK_TYPES } from '@/lib/views/editor-shape';
import { type EditorSource, type PaletteType, newBlock } from '@/lib/views/editor-spec';
import type { ViewSpec } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { BlockGlyph } from '../ViewThumbnail';
import { BLOCK_PITCH, blockIcon, blockLabel } from '../editor/block-meta';

/**
 * LA BIBLIOTECA DE PIEZAS: «AGREGAR», EN LA COLUMNA IZQUIERDA DEL ESTUDIO.
 *
 * Cada pieza es una tarjeta con su dibujo (el mismo trazo de la miniatura de
 * /views), su nombre y una línea de qué es. Se agrega de dos maneras:
 *
 *   - Con un clic: queda después del bloque elegido (o al final).
 *   - Arrastrándola al lienzo: cae donde se suelta, con la misma barra que
 *     cuando se mueve un bloque. El arrastre lo lleva el estudio
 *     (`dragProps`), que es quien conoce el lienzo; aquí sólo se pinta.
 *
 * QUÉ PIEZAS HAY no se decide aquí. Salen de lo que el contrato del servidor
 * acepta (`blockTypes`, leído del esquema por /api/views/catalog) y de lo que
 * `newBlock` sabe armar: si el motor gana un tipo y el lienzo todavía no sabe
 * crearlo, no aparece; si sabe crearlo pero esta empresa no tiene con qué
 * (un formulario sin tablas propias), sale apagado con el motivo. El nombre,
 * el icono y la frase vienen de `block-meta`, igual que en el marco y el
 * inspector, para que una pieza se llame igual en todas partes.
 */

const BASE_ORDER = ['metric', 'table', 'chart', 'board', 'zones', 'form', 'text'];

/** En qué estante va cada tipo. Uno que no esté aquí cae en «Más piezas». */
const SHELF: Record<string, string> = {
  metric: 'Números',
  kpi: 'Números',
  trend: 'Números',
  progress: 'Números',
  chart: 'Gráficos',
  table: 'Listas y tableros',
  board: 'Listas y tableros',
  zones: 'Listas y tableros',
  gallery: 'Listas y tableros',
  calendar: 'Listas y tableros',
  form: 'Para recibir datos',
  text: 'Contenido',
  media: 'Contenido',
  image: 'Contenido',
  links: 'Contenido',
};
const SHELF_ORDER = [
  'Números',
  'Gráficos',
  'Listas y tableros',
  'Para recibir datos',
  'Contenido',
  'Más piezas',
];

const WHY_NOT: Record<string, string> = {
  form: 'Necesitas una tabla de tu empresa: pídele a Cortex que cree una.',
  board: 'Necesitas una tabla con un campo de opciones (un estado, una etapa).',
  zones: 'Necesitas una tabla con un campo de opciones (una zona, un muelle).',
};

export interface LibraryPiece {
  type: PaletteType;
  label: string;
  pitch: string;
  ready: boolean;
  shelf: string;
}

/** Las piezas que el estudio puede ofrecer ahora mismo, en orden. */
export function libraryPieces(
  spec: ViewSpec,
  sources: EditorSource[],
  blockTypes: string[],
  prefer: string | null,
): LibraryPiece[] {
  const known = KNOWN_BLOCK_TYPES as readonly string[];
  const types = [...new Set([...BASE_ORDER, ...blockTypes])].filter(
    (t) => known.includes(t) || blockTypes.includes(t),
  );
  const out: LibraryPiece[] = [];
  for (const type of types) {
    // `undefined` = el lienzo todavía no sabe armar este tipo: no se ofrece.
    // `null` = sabe, pero esta empresa no tiene una fuente que lo admita.
    const probe = newBlock(type as PaletteType, spec, sources, prefer);
    if (probe === undefined) continue;
    out.push({
      type: type as PaletteType,
      label: blockLabel(type),
      pitch: BLOCK_PITCH[type] ?? '',
      ready: probe !== null,
      shelf: SHELF[type] ?? 'Más piezas',
    });
  }
  return out;
}

export function BlockLibrary({
  pieces,
  loading,
  canAdd,
  onAdd,
  dragProps,
}: {
  pieces: LibraryPiece[];
  loading: boolean;
  canAdd: boolean;
  onAdd: (type: PaletteType) => void;
  /** Arrastrar al lienzo; en el teléfono no se pasa y la tarjeta sólo se toca. */
  dragProps?: (type: PaletteType) => React.HTMLAttributes<HTMLButtonElement>;
}) {
  const [query, setQuery] = useState('');
  const shelves = useMemo(() => {
    const q = query
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '');
    const match = (p: LibraryPiece) =>
      !q ||
      `${p.label} ${p.pitch}`
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .includes(q);
    return SHELF_ORDER.map((shelf) => ({
      shelf,
      items: pieces.filter((p) => p.shelf === shelf && match(p)),
    })).filter((s) => s.items.length > 0);
  }, [pieces, query]);

  return (
    <div className="space-y-4">
      <label className="relative block">
        <span className="sr-only">Buscar una pieza</span>
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint"
          aria-hidden
        />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar: gráfico, lista, formulario…"
          className="w-full rounded-pill border border-border bg-surface-2/60 py-1.5 pl-8 pr-3 text-xs text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-primary"
        />
      </label>

      {!canAdd && (
        <p className="rounded-sm bg-amber-soft px-3 py-2 text-micro text-amber">
          Una vista admite hasta 24 bloques. Quita uno para agregar otro.
        </p>
      )}

      {shelves.map(({ shelf, items }) => (
        <section key={shelf}>
          <h3 className="field-label mb-2">{shelf}</h3>
          <ul className="grid grid-cols-2 gap-2">
            {items.map((p) => {
              const Icon = blockIcon(p.type);
              const disabled = loading || !p.ready || !canAdd;
              return (
                <li key={p.type}>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => onAdd(p.type)}
                    title={
                      !p.ready && !loading
                        ? (WHY_NOT[p.type] ?? 'Ninguna de tus tablas sirve para esta pieza.')
                        : `${p.pitch} Arrástrala al lienzo o tócala para agregarla.`
                    }
                    {...(disabled ? {} : dragProps?.(p.type))}
                    className={clsx(
                      'group flex h-full w-full select-none flex-col gap-1.5 rounded-sm border border-border bg-surface p-2 text-left transition-all duration-150 motion-reduce:transition-none',
                      disabled
                        ? 'cursor-not-allowed opacity-50'
                        : clsx(
                            'hover:-translate-y-px hover:border-primary/50 hover:shadow-card',
                            dragProps && 'cursor-grab touch-none active:cursor-grabbing',
                          ),
                    )}
                  >
                    <span className="block overflow-hidden rounded-sm bg-canvas/70 ring-1 ring-inset ring-border">
                      <BlockGlyph type={p.type} large />
                    </span>
                    <span className="flex items-center gap-1.5">
                      <Icon className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
                      <span className="truncate text-xs font-semibold text-ink">{p.label}</span>
                    </span>
                    <span className="line-clamp-2 text-micro leading-snug text-ink-muted">
                      {!p.ready && !loading
                        ? (WHY_NOT[p.type] ?? 'Sin una tabla que sirva.')
                        : p.pitch}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {!shelves.length && (
        <p className="px-1 py-6 text-center text-xs text-ink-muted">
          Ninguna pieza se llama así. Prueba con «número», «lista» o «gráfico».
        </p>
      )}
      {loading && <p className="text-micro text-ink-faint">Leyendo tus tablas…</p>}
    </div>
  );
}
