'use client';

import { clsx } from 'clsx';
import { Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { num } from './format';

/**
 * The other way in — and it is a peer of the map, not a courtesy.
 *
 * A screen where all the navigation lives inside a drawing locks out anybody on
 * a keyboard, anybody using a screen reader, and anybody who simply knows the
 * name of the thing they want and is in a hurry. That is not an accessibility
 * footnote; it is the difference between a demo and a tool. So everything the
 * relief map can do — see what is here, see how big each thing is, go into one
 * — is done here by typing, and the two are wired to the same state: what is
 * highlighted in this list is lit on the map, and the other way round.
 *
 * VOLUME. A space can hold thousands of documents. The list renders a bounded
 * window of them and says how many it is not showing, because the answer to
 * "there are four thousand" is a filter box, not four thousand rows of DOM.
 */

const RENDER_CAP = 150;

export interface IndexItem {
  id: string;
  label: string;
  /** One line under the name: where it lives, what it is. */
  sub?: string;
  /** The figure the map draws as elevation. */
  weight: number;
  /** Something to flag on the row — "indexando", "3 sin usar". */
  badge?: { text: string; tone: 'primary' | 'amber' | 'emerald' | 'rose' } | null;
}

const BADGE: Record<'primary' | 'amber' | 'emerald' | 'rose', string> = {
  primary: 'bg-primary-soft text-primary',
  amber: 'bg-amber-soft text-amber',
  emerald: 'bg-emerald-soft text-emerald',
  rose: 'bg-rose-soft text-rose',
};

export function IndexList({
  items,
  unit,
  placeholder,
  selectedId,
  hoveredId,
  onHover,
  onSelect,
  emptyText,
}: {
  items: IndexItem[];
  unit: string;
  placeholder: string;
  selectedId: string | null;
  hoveredId: string | null;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
  emptyText: string;
}) {
  const [filter, setFilter] = useState('');
  const [active, setActive] = useState(-1);
  const listRef = useRef<HTMLUListElement | null>(null);

  const matched = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const base = needle
      ? items.filter(
          (i) =>
            i.label.toLowerCase().includes(needle) || (i.sub ?? '').toLowerCase().includes(needle),
        )
      : items;
    return [...base].sort((a, b) => b.weight - a.weight);
  }, [items, filter]);

  const shown = matched.slice(0, RENDER_CAP);
  const hidden = matched.length - shown.length;
  const peak = Math.max(1, ...matched.map((i) => i.weight));

  // A filter that leaves the cursor pointing at row 40 of a list that now has
  // three rows is a cursor pointing at nothing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: filter is the trigger
  useEffect(() => setActive(-1), [filter]);

  function move(delta: number) {
    setActive((was) => {
      const next = Math.max(0, Math.min(shown.length - 1, was + delta));
      onHover(shown[next]?.id ?? null);
      listRef.current?.querySelectorAll('[data-row]')[next]?.scrollIntoView({ block: 'nearest' });
      return next;
    });
  }

  return (
    <div className="flex min-h-0 flex-col">
      <div className="px-4 pt-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={placeholder}
            aria-label={placeholder}
            className="h-8 w-full rounded-pill border border-border bg-surface-2 pl-8 pr-3 text-xs text-ink placeholder:text-ink-faint focus:border-primary/40 focus:bg-surface"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                move(1);
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                move(-1);
              } else if (e.key === 'Enter') {
                const target = shown[active] ?? shown[0];
                if (target) {
                  e.preventDefault();
                  onSelect(target.id);
                }
              }
            }}
          />
        </div>
        <p className="mt-1.5 text-micro text-ink-faint">
          {matched.length === items.length
            ? `${num(items.length)} en total · flechas para moverte, Enter para entrar`
            : `${num(matched.length)} de ${num(items.length)}`}
        </p>
      </div>

      {shown.length === 0 ? (
        <p className="px-4 py-5 text-xs leading-relaxed text-ink-muted">
          {filter ? `Nada que se llame «${filter}».` : emptyText}
        </p>
      ) : (
        <ul ref={listRef} className="mt-1 min-h-0 flex-1 overflow-y-auto scroll-slim">
          {shown.map((item, i) => {
            const on = selectedId === item.id;
            const near = hoveredId === item.id || active === i;
            return (
              <li key={item.id} data-row>
                <button
                  type="button"
                  onClick={() => onSelect(item.id)}
                  onPointerEnter={(e) => {
                    if (e.pointerType === 'mouse') onHover(item.id);
                  }}
                  onPointerLeave={(e) => {
                    if (e.pointerType === 'mouse') onHover(null);
                  }}
                  onFocus={() => onHover(item.id)}
                  className={clsx(
                    'flex w-full items-center gap-2.5 px-4 py-2 text-left transition-colors',
                    on ? 'bg-primary-soft' : near ? 'bg-surface-2' : 'hover:bg-surface-2',
                  )}
                >
                  {/* The same figure the map draws as height, drawn here as
                      length. One measure, two readings — so moving between the
                      picture and the list never feels like changing units. */}
                  <span className="h-6 w-1 shrink-0 overflow-hidden rounded-pill bg-surface-2">
                    <span
                      className="block w-full rounded-pill bg-primary"
                      style={{
                        height: `${Math.max(8, (item.weight / peak) * 100)}%`,
                        marginTop: 'auto',
                      }}
                    />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-semibold text-ink">
                      {item.label}
                    </span>
                    {item.sub && (
                      <span className="block truncate text-micro text-ink-faint">
                        {item.sub}
                      </span>
                    )}
                  </span>
                  {item.badge && (
                    <span
                      className={clsx(
                        'shrink-0 rounded-pill px-1.5 py-0.5 text-micro font-bold',
                        BADGE[item.badge.tone],
                      )}
                    >
                      {item.badge.text}
                    </span>
                  )}
                  <span className="shrink-0 text-right">
                    <span className="stat-num block text-xs text-ink">
                      {num(item.weight)}
                    </span>
                    <span className="block text-micro text-ink-faint">{unit}</span>
                  </span>
                </button>
              </li>
            );
          })}
          {hidden > 0 && (
            <li className="px-4 py-2.5 text-micro text-ink-faint">
              Y <span className="tabular">{num(hidden)}</span> más. Escribe arriba para encontrar
              uno.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
