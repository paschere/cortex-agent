'use client';

import { parseFileValue } from '@/lib/views/upload-rules';
import type { ComputedBlock } from '@cortex/agent-tools';
import {
  type CardFilterState,
  EMPTY_CARD_FILTER,
  filterCards,
  groupCards,
  pageOf,
  sortCards,
} from '@cortex/agent-tools/src/views/cards-filter';
import { clsx } from 'clsx';
import { ArrowDownAZ, ArrowUpAZ, LayoutGrid, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFlashClass } from '../flash-context';
import { RowActions } from '../view-writes';
import { useRecordOpener } from './RecordDrawer';
import { RichValue } from './RichValue';
import { Card, EmptyState, StatusChip, useViewTheme } from './theme';

/**
 * LA LISTA DE TARJETAS CON FILTROS RÁPIDOS.
 *
 * Tarjetas grandes —imagen, estado y dos a cuatro datos— con lo que se usa
 * todo el día arriba: buscador, chips (estado, hoy, esta semana, mías) y el
 * orden. Los filtros corren aquí sobre lo que el cálculo entregó: tocar un
 * chip no pide nada al servidor. La función que filtra vive en
 * `@cortex/agent-tools/src/views/cards-filter` y se prueba sin React.
 *
 * Cada tarjeta es UN botón (el patrón del enlace estirado de la galería); si
 * la vista tiene un detalle para esta tabla, abre el detalle por su enlace.
 * Los botones de la fila quedan por encima para no abrirlo. El paginado es
 * «Ver más» o, con `paging: 'infinite'`, carga sola al llegar al final.
 */

type Cards = Extract<ComputedBlock, { type: 'cards' }>;
type CardItem = Cards['cards'][number];

const CHIP_LABEL = { today: 'Hoy', week: 'Esta semana', mine: 'Mías' } as const;

function initialsOf(text: string): string {
  const words = text.trim().split(/\s+/);
  if (words.length === 1) return (words[0] ?? '').slice(0, 2).toLocaleUpperCase('es-CO') || '·';
  return (
    words
      .filter((w) => /^[\p{L}\p{N}]/u.test(w))
      .slice(0, 2)
      .map((w) => w.charAt(0).toLocaleUpperCase('es-CO'))
      .join('') || '·'
  );
}

function Chip({
  active,
  onClick,
  children,
  count,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  count?: number;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={clsx(
        'inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-pill border px-3.5 text-xs font-semibold transition-colors duration-150',
        active
          ? 'border-primary/50 bg-primary-soft text-primary-ink'
          : 'border-border bg-surface text-ink-muted hover:border-border-strong hover:text-ink',
      )}
    >
      {children}
      {count !== undefined && (
        <span className="tabular font-mono text-micro opacity-80">{count}</span>
      )}
    </button>
  );
}

function CardHero({ card }: { card: CardItem }) {
  const [failed, setFailed] = useState(false);
  const url =
    card.image?.kind === 'url'
      ? card.image.url
      : card.image?.kind === 'file'
        ? parseFileValue(card.image.raw).find((f) => f.mime.startsWith('image/'))?.url
        : undefined;
  if (url && !failed)
    return (
      <div className="aspect-[16/9] w-full overflow-hidden bg-surface-2">
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      </div>
    );
  return (
    <div
      aria-hidden
      className="grid h-20 w-full place-items-center bg-primary-soft text-xl font-extrabold tracking-tight text-primary-ink"
    >
      {initialsOf(card.title)}
    </div>
  );
}

export function CardsBlock({ block }: { block: Cards }) {
  const open = useRecordOpener(block.id, block.record);
  const flash = useFlashClass();
  const { density, layout } = useViewTheme();
  const [state, setState] = useState<CardFilterState>(EMPTY_CARD_FILTER);
  const [sort, setSort] = useState<{ index: number; dir: 'asc' | 'desc' } | null>(
    block.defaultSort,
  );
  const [page, setPage] = useState(1);

  const filtered = useMemo(
    () =>
      sortCards(
        filterCards(block.cards, state, {
          today: block.today,
          weekFrom: block.week.from,
          weekTo: block.week.to,
        }),
        sort,
      ),
    [block.cards, block.today, block.week.from, block.week.to, state, sort],
  );
  const { shown, more } = pageOf(filtered, page, block.pageSize);
  const groups = block.groupLabel ? groupCards(shown) : [{ group: null, cards: shown }];
  const counts = useMemo(() => {
    const out = new Map<string, number>();
    for (const c of block.cards)
      if (c.status) out.set(c.status.label, (out.get(c.status.label) ?? 0) + 1);
    return out;
  }, [block.cards]);

  // Cambiar un filtro vuelve a la primera página.
  // biome-ignore lint/correctness/useExhaustiveDependencies: el efecto reacciona al filtro.
  useEffect(() => setPage(1), [state, sort]);

  // Carga sola al llegar al final (paging: 'infinite').
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (block.paging !== 'infinite' || more === 0 || !sentinel.current) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setPage((p) => p + 1);
    });
    io.observe(sentinel.current);
    return () => io.disconnect();
  }, [block.paging, more]);

  const operator = layout === 'operator';
  const hasFilters = block.chips.length > 0 || block.searchable || block.sortOptions.length > 0;
  const active = state.status || state.when || state.mine || state.query;

  return (
    <Card
      title={block.title}
      source={`${filtered.length === block.total ? block.total : `${filtered.length} de ${block.total}`} · ${block.source}`}
    >
      {hasFilters && (
        <div className="view-no-print mb-4 space-y-3">
          {(block.searchable || block.sortOptions.length > 0) && (
            <div className="flex flex-wrap items-center gap-2">
              {block.searchable && (
                <label
                  className={clsx(
                    'flex min-w-0 flex-1 basis-48 items-center gap-2 rounded-pill border border-border bg-surface-2/70 px-4 transition-colors focus-within:border-border-strong focus-within:bg-surface',
                    operator ? 'h-14' : 'h-10',
                  )}
                >
                  <Search className="h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
                  <input
                    type="search"
                    value={state.query}
                    onChange={(e) => setState({ ...state, query: e.target.value })}
                    placeholder="Buscar"
                    aria-label={`Buscar en ${block.title}`}
                    className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
                  />
                </label>
              )}
              {block.sortOptions.length > 0 && (
                <div className="flex items-center gap-1">
                  <label className="sr-only" htmlFor={`${block.id}-orden`}>
                    Ordenar por
                  </label>
                  <select
                    id={`${block.id}-orden`}
                    value={sort?.index ?? ''}
                    onChange={(e) =>
                      setSort(
                        e.target.value === ''
                          ? null
                          : {
                              index: Number(e.target.value),
                              dir: block.sortOptions[Number(e.target.value)]?.dir ?? 'desc',
                            },
                      )
                    }
                    className="h-10 rounded-pill border border-border bg-surface px-3 text-xs font-semibold text-ink-muted outline-none focus-visible:border-border-strong"
                  >
                    <option value="">Orden de siempre</option>
                    {block.sortOptions.map((o, i) => (
                      <option key={o.label} value={i}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  {sort && (
                    <button
                      type="button"
                      aria-label={sort.dir === 'asc' ? 'Orden ascendente' : 'Orden descendente'}
                      onClick={() => setSort({ ...sort, dir: sort.dir === 'asc' ? 'desc' : 'asc' })}
                      className="grid h-10 w-10 place-items-center rounded-pill border border-border bg-surface text-ink-muted transition-colors hover:text-ink"
                    >
                      {sort.dir === 'asc' ? (
                        <ArrowUpAZ className="h-4 w-4" aria-hidden />
                      ) : (
                        <ArrowDownAZ className="h-4 w-4" aria-hidden />
                      )}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          {block.chips.length > 0 && (
            <div className="scroll-slim -mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
              {block.chips.includes('status') &&
                block.statusOptions.map((o) => (
                  <Chip
                    key={o.label}
                    active={state.status === o.label}
                    count={counts.get(o.label) ?? 0}
                    onClick={() =>
                      setState({ ...state, status: state.status === o.label ? null : o.label })
                    }
                  >
                    {o.label}
                  </Chip>
                ))}
              {(['today', 'week'] as const)
                .filter((c) => block.chips.includes(c))
                .map((c) => (
                  <Chip
                    key={c}
                    active={state.when === c}
                    onClick={() => setState({ ...state, when: state.when === c ? null : c })}
                  >
                    {CHIP_LABEL[c]}
                  </Chip>
                ))}
              {block.chips.includes('mine') && (
                <Chip active={state.mine} onClick={() => setState({ ...state, mine: !state.mine })}>
                  {CHIP_LABEL.mine}
                </Chip>
              )}
              {active && (
                <button
                  type="button"
                  onClick={() => setState(EMPTY_CARD_FILTER)}
                  className="shrink-0 px-2 text-xs font-semibold text-primary hover:underline"
                >
                  Quitar filtros
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {filtered.length === 0 ? (
        <EmptyState
          icon={<LayoutGrid className="h-5 w-5" aria-hidden />}
          title={active ? 'Nada con esos filtros' : 'Todavía no hay registros'}
          hint={
            active
              ? 'Quita un filtro para ver más.'
              : 'Cada registro nuevo aparece aquí como una tarjeta.'
          }
        />
      ) : (
        <div className="space-y-5">
          {groups.map((g) => (
            <section key={g.group ?? '_'} aria-label={g.group ?? undefined}>
              {block.groupLabel && (
                <h3 className="mb-2.5 flex items-center gap-2 text-xs font-bold text-ink">
                  {g.group}
                  <span className="tabular rounded-pill bg-surface-2 px-2 py-0.5 font-mono text-micro font-semibold text-ink-muted">
                    {g.cards.length}
                  </span>
                </h3>
              )}
              <ul
                className={clsx(
                  'grid grid-cols-1',
                  operator ? 'gap-3' : 'sm:grid-cols-2 xl:grid-cols-3',
                  density === 'compact' ? 'gap-2.5' : 'gap-4',
                )}
              >
                {g.cards.map((card) => (
                  <li
                    key={card.id}
                    className={clsx(
                      flash(block.id, card.id),
                      'group relative flex flex-col overflow-hidden rounded-card border shadow-card transition-all duration-150',
                      card.alert ? 'border-rose/50 bg-rose-soft' : 'border-border bg-surface',
                      open &&
                        'hover:-translate-y-0.5 hover:border-border-strong hover:shadow-pop focus-within:ring-2 focus-within:ring-primary/40',
                    )}
                  >
                    {block.cards.some((c) => c.image) && <CardHero card={card} />}
                    <div className="flex flex-1 flex-col p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          {open ? (
                            <button
                              type="button"
                              onClick={() => open(card.id)}
                              className="block min-w-0 max-w-full text-left text-base font-bold leading-snug text-ink outline-none after:absolute after:inset-0 after:content-['']"
                            >
                              {card.title}
                            </button>
                          ) : (
                            <p className="min-w-0 text-base font-bold leading-snug text-ink">
                              {card.title}
                            </p>
                          )}
                          {card.subtitle && (
                            <p className="mt-0.5 truncate text-xs text-ink-muted">
                              {card.subtitle}
                            </p>
                          )}
                        </div>
                        {card.status && (
                          <StatusChip value={card.status.label} tone={card.status.tone} />
                        )}
                      </div>
                      {card.data.length > 0 && (
                        <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-t border-border/70 pt-3">
                          {card.data.map((d) => (
                            <div key={d.label} className="min-w-0">
                              <dt className="text-micro text-ink-faint">{d.label}</dt>
                              <dd className="truncate text-xs font-semibold text-ink">
                                <RichValue kind={d.kind} raw={d.raw} text={d.value} size={28} />
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
            </section>
          ))}
          {more > 0 &&
            (block.paging === 'infinite' ? (
              <div ref={sentinel} className="py-3 text-center text-micro text-ink-faint">
                Cargando más…
              </div>
            ) : (
              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={() => setPage(page + 1)}
                  className="h-10 rounded-pill border border-border bg-surface px-5 text-xs font-semibold text-ink transition-colors hover:border-border-strong"
                >
                  Ver más ({more})
                </button>
              </div>
            ))}
        </div>
      )}
      {block.total > block.cards.length && (
        <p className="mt-3 text-micro text-ink-faint">
          Se muestran {block.cards.length} de {block.total}.
        </p>
      )}
    </Card>
  );
}
