'use client';

import type { GridColumn, GridView } from '@/components/datagrid/types';
import {
  type QuickInput,
  columnFilterOf,
  isOptionColumn,
  quickFilterFor,
  quickInputOf,
  replaceColumnFilter,
} from '@/lib/datagrid/column-filter';
import { isNumericType } from '@/lib/datagrid/format';
import { clsx } from 'clsx';
import { ListFilter } from 'lucide-react';
import { useRef, useState } from 'react';
import { Popover, ghostButton, primaryButton } from './primitives';

/**
 * El embudo del encabezado: filtro rápido de UNA columna. Escribe el mismo
 * filtro que el panel «Filtros» (ver `lib/datagrid/column-filter.ts`), así que
 * aparece como ficha arriba y se quita desde ahí o desde aquí.
 */

const inputCls =
  'h-9 w-full rounded-sm border border-border bg-surface px-2.5 text-xs text-ink placeholder:text-ink-faint focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20';

export function ColumnFilterButton({
  column,
  view,
  setView,
  people,
}: {
  column: GridColumn;
  view: GridView;
  setView: (update: (v: GridView) => GridView) => void;
  people?: string[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const current = columnFilterOf(view.filters, column.key);
  const active = Boolean(current && quickFilterFor(column, quickInputOf(column, current)));
  const [draft, setDraft] = useState<QuickInput>({});

  const choices: Array<{ value: string; label: string }> = isOptionColumn(column)
    ? (column.options ?? []).map((o) => ({ value: o.value, label: o.label ?? o.value }))
    : column.type === 'person'
      ? (people ?? []).map((p) => ({ value: p, label: p }))
      : [];

  const apply = (input: QuickInput) =>
    setView((v) => ({
      ...v,
      filters: replaceColumnFilter(v.filters, column.key, quickFilterFor(column, input)),
    }));

  const numeric = isNumericType(column.type);
  const dated = column.type === 'date' || column.type === 'datetime';

  return (
    <>
      <button
        ref={ref}
        type="button"
        tabIndex={-1}
        onClick={() => {
          setDraft(quickInputOf(column, current));
          setOpen((o) => !o);
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Filtrar ${column.label}`}
        title={`Filtrar ${column.label}`}
        className={clsx(
          'mr-1 grid h-6 w-6 shrink-0 place-items-center rounded-pill hover:bg-surface hover:text-primary',
          active
            ? 'bg-primary-soft text-primary'
            : 'text-ink-faint opacity-0 focus-visible:opacity-100 group-hover/h:opacity-100',
        )}
      >
        <ListFilter className="h-3 w-3" aria-hidden />
      </button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={ref}
        width={260}
        align="end"
        label={`Filtrar ${column.label}`}
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            apply(draft);
            setOpen(false);
          }}
        >
          <p className="text-micro font-semibold text-ink-muted">{column.label}</p>
          {choices.length > 0 ? (
            <div className="scroll-slim flex max-h-56 flex-col gap-0.5 overflow-y-auto">
              {choices.map((c) => {
                const on = (draft.list ?? []).includes(c.value);
                return (
                  <label
                    key={c.value}
                    className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-ink hover:bg-surface-2"
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => {
                        const list = on
                          ? (draft.list ?? []).filter((x) => x !== c.value)
                          : [...(draft.list ?? []), c.value];
                        setDraft({ ...draft, list });
                        apply({ ...draft, list });
                      }}
                      className="h-4 w-4 accent-[rgb(var(--primary))]"
                    />
                    <span className="truncate">{c.label}</span>
                  </label>
                );
              })}
            </div>
          ) : column.type === 'boolean' ? (
            <div className="flex gap-1.5">
              {[
                { label: 'Sí', v: true },
                { label: 'No', v: false },
              ].map((o) => (
                <button
                  key={o.label}
                  type="button"
                  aria-pressed={draft.bool === o.v}
                  onClick={() => {
                    const bool = draft.bool === o.v ? null : o.v;
                    setDraft({ bool });
                    apply({ bool });
                  }}
                  className={clsx(
                    ghostButton,
                    'flex-1 justify-center border border-border',
                    draft.bool === o.v && 'border-primary/30 bg-primary-soft text-primary-ink',
                  )}
                >
                  {o.label}
                </button>
              ))}
            </div>
          ) : numeric || dated ? (
            <div className="grid grid-cols-2 gap-2">
              <input
                className={inputCls}
                inputMode={numeric ? 'decimal' : undefined}
                type={numeric ? 'text' : 'date'}
                aria-label="Desde"
                placeholder="Desde"
                value={draft.min ?? ''}
                onChange={(e) => setDraft({ ...draft, min: e.target.value })}
              />
              <input
                className={inputCls}
                inputMode={numeric ? 'decimal' : undefined}
                type={numeric ? 'text' : 'date'}
                aria-label="Hasta"
                placeholder="Hasta"
                value={draft.max ?? ''}
                onChange={(e) => setDraft({ ...draft, max: e.target.value })}
              />
            </div>
          ) : (
            <input
              className={inputCls}
              aria-label={`Contiene en ${column.label}`}
              placeholder="Contiene…"
              value={draft.text ?? ''}
              onChange={(e) => setDraft({ ...draft, text: e.target.value })}
            />
          )}
          <div className="flex items-center gap-2">
            {active ? (
              <button
                type="button"
                className={ghostButton}
                onClick={() => {
                  apply({});
                  setDraft({});
                  setOpen(false);
                }}
              >
                Quitar
              </button>
            ) : null}
            {choices.length === 0 && column.type !== 'boolean' ? (
              <button type="submit" className={clsx(primaryButton, 'ml-auto')}>
                Aplicar
              </button>
            ) : null}
          </div>
        </form>
      </Popover>
    </>
  );
}
