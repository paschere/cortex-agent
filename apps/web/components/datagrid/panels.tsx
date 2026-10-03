'use client';

import type {
  GridColumn,
  GridFilter,
  GridFilterOp,
  GridLayout,
  GridSort,
  GridView,
} from '@/components/datagrid/types';
import { asList, isNumericType } from '@/lib/datagrid/format';
import {
  defaultOperator,
  operatorNeedsValue,
  operatorsFor,
  orderedColumns,
} from '@/lib/datagrid/view';
import { clsx } from 'clsx';
import {
  ArrowDown,
  ArrowUp,
  Bookmark,
  CalendarDays,
  Check,
  Copy,
  Eye,
  EyeOff,
  GripVertical,
  LayoutGrid,
  Pencil,
  Plus,
  Share2,
  SquareKanban,
  Table2,
  Trash2,
  X,
} from 'lucide-react';
import { useId, useState } from 'react';
import { OptionChip } from './cells';
import { TYPE_ICON, ghostButton, inputClass, menuItem, selectClass } from './primitives';

type SetView = (update: (v: GridView) => GridView) => void;

function PanelTitle({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2">
      <h3 className="text-xs font-bold text-ink">{children}</h3>
      {aside}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filtros
// ---------------------------------------------------------------------------

function FilterValue({
  column,
  filter,
  onChange,
}: {
  column: GridColumn;
  filter: GridFilter;
  onChange: (value: unknown) => void;
}) {
  const t = column.type;
  const op = filter.op;
  if (!operatorNeedsValue(op)) return null;
  const isDate = t === 'date' || t === 'datetime';
  if (op === 'between') {
    const [a, b] = Array.isArray(filter.value) ? filter.value : ['', ''];
    const type = isDate ? 'date' : 'text';
    return (
      <div className="flex items-center gap-1.5">
        <input
          type={type}
          inputMode={isDate ? undefined : 'decimal'}
          value={String(a ?? '')}
          onChange={(e) => onChange([e.target.value, b ?? ''])}
          aria-label="Desde"
          placeholder="Desde"
          className={clsx(inputClass, 'tabular')}
        />
        <span className="text-micro text-ink-faint">y</span>
        <input
          type={type}
          inputMode={isDate ? undefined : 'decimal'}
          value={String(b ?? '')}
          onChange={(e) => onChange([a ?? '', e.target.value])}
          aria-label="Hasta"
          placeholder="Hasta"
          className={clsx(inputClass, 'tabular')}
        />
      </div>
    );
  }
  if (op === 'last_days' || op === 'next_days')
    return (
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={0}
          max={3650}
          value={String(filter.value ?? '')}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
          aria-label="Días"
          className={clsx(inputClass, 'tabular w-24')}
        />
        <span className="text-micro text-ink-muted">días</span>
      </div>
    );
  if (op === 'in' || op === 'not_in') {
    const list = asList(filter.value);
    return (
      // biome-ignore lint/a11y/useSemanticElements: opciones como botones-píldora; el patrón ARIA radio/radiogroup es el que describen.
      <div role="group" className="flex flex-wrap gap-1.5" aria-label="Valores">
        {(column.options ?? []).map((o) => {
          const on = list.includes(o.value);
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(on ? list.filter((x) => x !== o.value) : [...list, o.value])}
              className={clsx(
                'rounded-pill p-0.5',
                on ? 'ring-2 ring-primary' : 'opacity-60 hover:opacity-100',
              )}
            >
              <OptionChip option={o} value={o.value} />
            </button>
          );
        })}
      </div>
    );
  }
  if (t === 'boolean')
    return (
      <select
        value={filter.value === false || filter.value === 'false' ? 'false' : 'true'}
        onChange={(e) => onChange(e.target.value === 'true')}
        aria-label="Valor"
        className={selectClass}
      >
        <option value="true">Sí</option>
        <option value="false">No</option>
      </select>
    );
  return (
    <input
      type={isDate ? 'date' : 'text'}
      inputMode={isNumericType(t) ? 'decimal' : undefined}
      value={String(filter.value ?? '')}
      onChange={(e) => onChange(e.target.value)}
      aria-label="Valor"
      placeholder={isNumericType(t) ? '0' : 'Escribe…'}
      className={clsx(inputClass, (isNumericType(t) || isDate) && 'tabular')}
    />
  );
}

export function FilterPanel({
  columns,
  view,
  setView,
}: {
  columns: GridColumn[];
  view: GridView;
  setView: SetView;
}) {
  const filterable = columns;
  const update = (i: number, patch: Partial<GridFilter>) =>
    setView((v) => ({
      ...v,
      filters: v.filters.map((f, j) => (j === i ? { ...f, ...patch } : f)),
    }));
  const add = () => {
    const col = filterable[0];
    if (!col) return;
    setView((v) => ({
      ...v,
      filters: [...v.filters, { key: col.key, op: defaultOperator(col.type) }],
    }));
  };
  const any = view.match === 'any';
  return (
    <div>
      <PanelTitle
        aside={
          view.filters.length ? (
            <button
              type="button"
              className={ghostButton}
              onClick={() => setView((v) => ({ ...v, filters: [] }))}
            >
              Quitar todos
            </button>
          ) : null
        }
      >
        Filtros
      </PanelTitle>
      {view.filters.length > 1 ? (
        <div className="mb-3 flex items-center gap-2 text-micro text-ink-muted">
          Mostrar las filas que cumplen
          <div
            role="radiogroup"
            aria-label="Cómo se combinan"
            className="inline-flex rounded-pill bg-surface-2 p-0.5"
          >
            {(
              [
                ['all', 'todos'],
                ['any', 'alguno'],
              ] as const
            ).map(([m, label]) => (
              // biome-ignore lint/a11y/useSemanticElements: opciones como botones-píldora; el patrón ARIA radio/radiogroup es el que describen.
              <button
                role="radio"
                key={m}
                type="button"
                aria-checked={(m === 'any') === any}
                onClick={() => setView((v) => ({ ...v, match: m }))}
                className={clsx(
                  'rounded-pill px-2.5 py-1 text-micro font-semibold',
                  (m === 'any') === any ? 'bg-surface text-ink shadow-card' : 'text-ink-muted',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {view.filters.length === 0 ? (
        <p className="mb-3 text-xs text-ink-muted">
          Sin filtros. Agrega uno para ver solo lo que te importa: por estado, por fecha, por valor.
        </p>
      ) : (
        <ul className="mb-3 flex flex-col gap-3">
          {view.filters.map((f, i) => {
            const col = columns.find((c) => c.key === f.key);
            if (!col) return null;
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: un filtro no tiene identidad propia.
              <li key={i} className="rounded-sm border border-border bg-surface-2/50 p-2.5">
                <div className="mb-2 flex items-center gap-1.5">
                  {i > 0 ? (
                    <span className="w-6 shrink-0 text-micro font-semibold text-ink-faint">
                      {any ? 'o' : 'y'}
                    </span>
                  ) : null}
                  <select
                    value={f.key}
                    aria-label="Columna"
                    onChange={(e) => {
                      const next = columns.find((c) => c.key === e.target.value);
                      if (next)
                        update(i, {
                          key: next.key,
                          op: defaultOperator(next.type),
                          value: undefined,
                        });
                    }}
                    className={clsx(selectClass, 'min-w-0 flex-1')}
                  >
                    {filterable.map((c) => (
                      <option key={c.key} value={c.key}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                  <select
                    value={f.op}
                    aria-label="Condición"
                    onChange={(e) => {
                      const op = e.target.value as GridFilterOp;
                      const keep =
                        operatorNeedsValue(op) && (op === 'between') === (f.op === 'between');
                      update(i, {
                        op,
                        value: keep ? f.value : col.type === 'boolean' ? true : undefined,
                      });
                    }}
                    className={clsx(selectClass, 'min-w-0 flex-1')}
                  >
                    {operatorsFor(col.type).map((o) => (
                      <option key={o.op} value={o.op}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() =>
                      setView((v) => ({ ...v, filters: v.filters.filter((_, j) => j !== i) }))
                    }
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-pill text-ink-faint hover:bg-surface-2 hover:text-ink"
                    aria-label={`Quitar filtro de ${col.label}`}
                  >
                    <X className="h-4 w-4" aria-hidden />
                  </button>
                </div>
                <FilterValue column={col} filter={f} onChange={(value) => update(i, { value })} />
              </li>
            );
          })}
        </ul>
      )}
      <button type="button" onClick={add} className={ghostButton}>
        <Plus className="h-4 w-4" aria-hidden />
        Agregar filtro
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ordenar
// ---------------------------------------------------------------------------

export function dirLabels(col: GridColumn): [string, string] {
  if (isNumericType(col.type)) return ['Menor a mayor', 'Mayor a menor'];
  if (col.type === 'date' || col.type === 'datetime')
    return ['Antiguas primero', 'Recientes primero'];
  if (col.type === 'select' || col.type === 'status') return ['En orden', 'Al revés'];
  if (col.type === 'boolean') return ['No primero', 'Sí primero'];
  return ['A → Z', 'Z → A'];
}

export function SortPanel({
  columns,
  view,
  setView,
}: {
  columns: GridColumn[];
  view: GridView;
  setView: SetView;
}) {
  const used = new Set(view.sort.map((s) => s.key));
  const free = columns.filter((c) => !used.has(c.key));
  const set = (sort: GridSort[]) => setView((v) => ({ ...v, sort }));
  return (
    <div>
      <PanelTitle
        aside={
          view.sort.length ? (
            <button type="button" className={ghostButton} onClick={() => set([])}>
              Quitar orden
            </button>
          ) : null
        }
      >
        Ordenar
      </PanelTitle>
      {view.sort.length === 0 ? (
        <p className="mb-3 text-xs text-ink-muted">
          En el orden en que llegaron. Elige una columna; puedes sumar otra para desempatar.
        </p>
      ) : (
        <ol className="mb-3 flex flex-col gap-2">
          {view.sort.map((s, i) => {
            const col = columns.find((c) => c.key === s.key);
            if (!col) return null;
            const [asc, desc] = dirLabels(col);
            return (
              <li key={s.key} className="flex items-center gap-1.5">
                <span className="tabular w-5 shrink-0 text-micro text-ink-faint">{i + 1}.</span>
                <select
                  value={s.key}
                  aria-label="Columna"
                  onChange={(e) =>
                    set(view.sort.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))
                  }
                  className={clsx(selectClass, 'min-w-0 flex-1')}
                >
                  {[col, ...free].map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                    </option>
                  ))}
                </select>
                <select
                  value={s.dir}
                  aria-label="Dirección"
                  onChange={(e) =>
                    set(
                      view.sort.map((x, j) =>
                        j === i ? { ...x, dir: e.target.value as 'asc' | 'desc' } : x,
                      ),
                    )
                  }
                  className={clsx(selectClass, 'min-w-0 flex-1')}
                >
                  <option value="asc">{asc}</option>
                  <option value="desc">{desc}</option>
                </select>
                <button
                  type="button"
                  disabled={i === 0}
                  onClick={() => {
                    const next = [...view.sort];
                    const [moved] = next.splice(i, 1);
                    if (moved) next.splice(i - 1, 0, moved);
                    set(next);
                  }}
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-pill text-ink-faint hover:bg-surface-2 hover:text-ink disabled:opacity-30"
                  aria-label="Subir prioridad"
                >
                  <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => set(view.sort.filter((_, j) => j !== i))}
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-pill text-ink-faint hover:bg-surface-2 hover:text-ink"
                  aria-label={`Quitar orden por ${col.label}`}
                >
                  <X className="h-4 w-4" aria-hidden />
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {free.length ? (
        <label className="flex items-center gap-2">
          <Plus className="h-4 w-4 text-ink-muted" aria-hidden />
          <select
            value=""
            aria-label="Agregar orden por"
            onChange={(e) => {
              if (e.target.value) set([...view.sort, { key: e.target.value, dir: 'asc' }]);
            }}
            className={clsx(selectClass, 'flex-1')}
          >
            <option value="">{view.sort.length ? 'Luego por…' : 'Ordenar por…'}</option>
            {free.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agrupar
// ---------------------------------------------------------------------------

export const GROUPABLE = new Set([
  'text',
  'select',
  'status',
  'multi_select',
  'person',
  'boolean',
  'date',
  'datetime',
  'number',
]);

export function GroupPanel({
  columns,
  view,
  setView,
  close,
}: {
  columns: GridColumn[];
  view: GridView;
  setView: SetView;
  close: () => void;
}) {
  const groupable = columns.filter((c) => GROUPABLE.has(c.type));
  return (
    <div>
      <PanelTitle>Agrupar por</PanelTitle>
      <div role="radiogroup" aria-label="Agrupar por" className="flex flex-col gap-0.5">
        {[null, ...groupable].map((c) => {
          const on = (view.groupBy ?? null) === (c?.key ?? null);
          const Icon = c ? TYPE_ICON[c.type] : X;
          return (
            // biome-ignore lint/a11y/useSemanticElements: opciones como botones-píldora; el patrón ARIA radio/radiogroup es el que describen.
            <button
              role="radio"
              key={c?.key ?? '__none'}
              type="button"
              aria-checked={on}
              onClick={() => {
                setView((v) => ({ ...v, groupBy: c?.key ?? null }));
                close();
              }}
              className={clsx(menuItem, on && 'bg-primary-soft text-primary-ink')}
            >
              <Icon className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden />
              <span className="flex-1">{c ? c.label : 'Sin agrupar'}</span>
              {on ? <Check className="h-3.5 w-3.5 text-primary" aria-hidden /> : null}
            </button>
          );
        })}
      </div>
      {groupable.some((c) => c.type === 'date' || c.type === 'datetime') ? (
        <p className="mt-2 text-micro text-ink-faint">Las fechas se agrupan por mes.</p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Columnas: ver/ocultar, orden (arrastrando o con flechas), anchos
// ---------------------------------------------------------------------------

export function ColumnsPanel({
  columns,
  view,
  setView,
}: {
  columns: GridColumn[];
  view: GridView;
  setView: SetView;
}) {
  const ordered = orderedColumns(columns, view);
  const hidden = new Set(view.hidden);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const movable = ordered.filter((c) => !c.pinned);

  const move = (key: string, to: number) => {
    const keys = movable.map((c) => c.key).filter((k) => k !== key);
    keys.splice(Math.max(0, Math.min(to, keys.length)), 0, key);
    setView((v) => ({ ...v, order: keys }));
  };

  return (
    <div>
      <PanelTitle
        aside={
          <button
            type="button"
            className={ghostButton}
            onClick={() =>
              setView((v) => ({ ...v, hidden: [], order: undefined, widths: undefined }))
            }
          >
            Restablecer
          </button>
        }
      >
        Columnas
      </PanelTitle>
      <ul className="flex flex-col gap-0.5">
        {ordered
          .filter((c) => c.pinned)
          .map((c) => {
            const Icon = TYPE_ICON[c.type];
            return (
              <li
                key={c.key}
                className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-ink-muted"
              >
                <span className="w-4" />
                <Icon className="h-3.5 w-3.5 text-ink-faint" aria-hidden />
                <span className="flex-1 truncate">{c.label}</span>
                <span className="text-micro text-ink-faint">Fija</span>
              </li>
            );
          })}
        {movable.map((c, i) => {
          const Icon = TYPE_ICON[c.type];
          const isHidden = hidden.has(c.key);
          return (
            <li
              key={c.key}
              draggable
              onDragStart={(e) => {
                setDragKey(c.key);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', c.key);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setOverKey(c.key);
              }}
              onDragLeave={() => setOverKey((k) => (k === c.key ? null : k))}
              onDrop={(e) => {
                e.preventDefault();
                if (dragKey && dragKey !== c.key) move(dragKey, i);
                setDragKey(null);
                setOverKey(null);
              }}
              onDragEnd={() => {
                setDragKey(null);
                setOverKey(null);
              }}
              className={clsx(
                'group flex items-center gap-2 rounded-sm px-1.5 py-1 text-xs',
                overKey === c.key && dragKey !== c.key && 'bg-primary-soft',
                dragKey === c.key && 'opacity-50',
              )}
            >
              <GripVertical className="h-4 w-4 shrink-0 cursor-grab text-ink-faint" aria-hidden />
              <Icon className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden />
              <span className={clsx('flex-1 truncate', isHidden ? 'text-ink-faint' : 'text-ink')}>
                {c.label}
              </span>
              <span className="flex items-center opacity-60 group-hover:opacity-100 group-focus-within:opacity-100">
                <button
                  type="button"
                  disabled={i === 0}
                  onClick={() => move(c.key, i - 1)}
                  className="grid h-7 w-7 place-items-center rounded-pill hover:bg-surface-2 disabled:opacity-30"
                  aria-label={`Mover ${c.label} a la izquierda`}
                >
                  <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                </button>
                <button
                  type="button"
                  disabled={i === movable.length - 1}
                  onClick={() => move(c.key, i + 1)}
                  className="grid h-7 w-7 place-items-center rounded-pill hover:bg-surface-2 disabled:opacity-30"
                  aria-label={`Mover ${c.label} a la derecha`}
                >
                  <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                </button>
              </span>
              <button
                type="button"
                aria-pressed={!isHidden}
                onClick={() =>
                  setView((v) => ({
                    ...v,
                    hidden: isHidden ? v.hidden.filter((k) => k !== c.key) : [...v.hidden, c.key],
                  }))
                }
                className="grid h-7 w-7 place-items-center rounded-pill text-ink-muted hover:bg-surface-2 hover:text-ink"
                aria-label={isHidden ? `Mostrar ${c.label}` : `Ocultar ${c.label}`}
              >
                {isHidden ? (
                  <EyeOff className="h-3.5 w-3.5" aria-hidden />
                ) : (
                  <Eye className="h-3.5 w-3.5" aria-hidden />
                )}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-micro text-ink-faint">
        Arrastra para reordenar. El ancho se cambia desde el borde del encabezado.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Diseño: tabla, tablero, tarjetas, calendario
// ---------------------------------------------------------------------------

export const LAYOUTS: Array<{ id: GridLayout; label: string; icon: typeof Table2; hint: string }> =
  [
    { id: 'table', label: 'Tabla', icon: Table2, hint: 'Filas y columnas, con totales.' },
    {
      id: 'board',
      label: 'Tablero',
      icon: SquareKanban,
      hint: 'Tarjetas por estado; arrástralas.',
    },
    { id: 'cards', label: 'Tarjetas', icon: LayoutGrid, hint: 'Una ficha por fila.' },
    { id: 'calendar', label: 'Calendario', icon: CalendarDays, hint: 'Por fecha, mes a mes.' },
  ];

export function boardColumns(columns: GridColumn[]): GridColumn[] {
  return columns.filter((c) => (c.type === 'select' || c.type === 'status') && c.options?.length);
}
export function dateColumns(columns: GridColumn[]): GridColumn[] {
  return columns.filter((c) => c.type === 'date' || c.type === 'datetime');
}

export function LayoutPanel({
  columns,
  view,
  setView,
}: {
  columns: GridColumn[];
  view: GridView;
  setView: SetView;
}) {
  const boardCols = boardColumns(columns);
  const dateCols = dateColumns(columns);
  const keyCols = view.layout === 'board' ? boardCols : view.layout === 'calendar' ? dateCols : [];
  const selectId = useId();
  return (
    <div>
      <PanelTitle>Diseño</PanelTitle>
      <div role="radiogroup" aria-label="Diseño" className="grid grid-cols-2 gap-2">
        {LAYOUTS.map((l) => {
          const disabled =
            (l.id === 'board' && !boardCols.length) || (l.id === 'calendar' && !dateCols.length);
          const on = view.layout === l.id;
          return (
            // biome-ignore lint/a11y/useSemanticElements: opciones como botones-píldora; el patrón ARIA radio/radiogroup es el que describen.
            <button
              role="radio"
              key={l.id}
              type="button"
              aria-checked={on}
              disabled={disabled}
              onClick={() =>
                setView((v) => {
                  const pool = l.id === 'board' ? boardCols : l.id === 'calendar' ? dateCols : [];
                  const keep = pool.some((c) => c.key === v.layoutKey);
                  return {
                    ...v,
                    layout: l.id,
                    layoutKey: keep ? v.layoutKey : (pool[0]?.key ?? null),
                  };
                })
              }
              className={clsx(
                'flex flex-col items-start gap-1 rounded-sm border p-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-40',
                on ? 'border-primary bg-primary-soft' : 'border-border hover:bg-surface-2',
              )}
            >
              <l.icon
                className={clsx('h-4 w-4', on ? 'text-primary' : 'text-ink-muted')}
                aria-hidden
              />
              <span className="text-xs font-bold text-ink">{l.label}</span>
              <span className="text-micro leading-snug text-ink-muted">
                {disabled
                  ? l.id === 'board'
                    ? 'Necesita una columna de opciones.'
                    : 'Necesita una columna de fecha.'
                  : l.hint}
              </span>
            </button>
          );
        })}
      </div>
      {keyCols.length > 1 ? (
        <div className="mt-3">
          <label htmlFor={selectId} className="field-label mb-1 block">
            {view.layout === 'board' ? 'Columnas del tablero según' : 'Fecha que usa el calendario'}
          </label>
          <select
            id={selectId}
            value={view.layoutKey ?? keyCols[0]?.key ?? ''}
            onChange={(e) => setView((v) => ({ ...v, layoutKey: e.target.value }))}
            className={clsx(selectClass, 'w-full')}
          >
            {keyCols.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Vistas guardadas
// ---------------------------------------------------------------------------

export function ViewsPanel({
  views,
  current,
  dirty,
  canSave,
  canDelete,
  onApply,
  onSave,
  onRename,
  onDelete,
  onReset,
  onCopyLink,
}: {
  views: GridView[];
  current: GridView;
  dirty: boolean;
  canSave: boolean;
  canDelete: boolean;
  onApply: (view: GridView) => void;
  onSave: (input: { name: string; shared: boolean; asNew: boolean }) => Promise<void>;
  onRename: (view: GridView, name: string) => Promise<void>;
  onDelete: (view: GridView) => Promise<void>;
  onReset: () => void;
  onCopyLink: () => void;
}) {
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const active = views.find((v) => v.id && v.id === current.id);
  const nameId = useId();

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PanelTitle>Vistas guardadas</PanelTitle>
      <ul className="mb-3 flex flex-col gap-0.5">
        <li>
          <button
            type="button"
            onClick={onReset}
            className={clsx(menuItem, !current.id && !dirty && 'bg-surface-2')}
          >
            <Table2 className="h-3.5 w-3.5 text-ink-faint" aria-hidden />
            <span className="flex-1">Todo, sin filtros</span>
          </button>
        </li>
        {views.map((v) => (
          <li key={v.id} className="group flex items-center gap-1">
            {renaming === v.id ? (
              <form
                className="flex flex-1 items-center gap-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!renameText.trim()) return;
                  void run(async () => {
                    await onRename(v, renameText.trim());
                    setRenaming(null);
                  });
                }}
              >
                <input
                  value={renameText}
                  onChange={(e) => setRenameText(e.target.value)}
                  aria-label="Nuevo nombre"
                  maxLength={80}
                  className={inputClass}
                  // biome-ignore lint/a11y/noAutofocus: renombrar abre el campo para escribir.
                  autoFocus
                />
                <button
                  type="submit"
                  disabled={busy}
                  className={ghostButton}
                  aria-label="Guardar nombre"
                >
                  <Check className="h-4 w-4" aria-hidden />
                </button>
              </form>
            ) : confirmDelete === v.id ? (
              <div className="flex flex-1 items-center gap-2 rounded-sm bg-rose-soft px-2.5 py-1.5 text-xs text-rose">
                <span className="flex-1">¿Borrar «{v.name}»?</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await onDelete(v);
                      setConfirmDelete(null);
                    })
                  }
                  className="font-bold underline"
                >
                  Borrar
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(null)}
                  className="font-semibold"
                >
                  No
                </button>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => onApply(v)}
                  className={clsx(
                    menuItem,
                    'flex-1',
                    current.id === v.id && 'bg-primary-soft text-primary-ink',
                  )}
                >
                  <Bookmark className="h-3.5 w-3.5 text-ink-faint" aria-hidden />
                  <span className="flex-1 truncate">{v.name}</span>
                  {v.shared ? (
                    <span className="inline-flex items-center gap-1 text-micro text-ink-faint">
                      <Share2 className="h-3 w-3" aria-hidden />
                      Equipo
                    </span>
                  ) : null}
                </button>
                {v.canManage !== false && canSave ? (
                  <button
                    type="button"
                    onClick={() => {
                      setRenaming(v.id ?? null);
                      setRenameText(v.name ?? '');
                    }}
                    className="grid h-7 w-7 place-items-center rounded-pill text-ink-faint opacity-0 hover:bg-surface-2 hover:text-ink focus:opacity-100 group-hover:opacity-100"
                    aria-label={`Renombrar ${v.name}`}
                  >
                    <Pencil className="h-3.5 w-3.5" aria-hidden />
                  </button>
                ) : null}
                {v.canManage !== false && canDelete ? (
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(v.id ?? null)}
                    className="grid h-7 w-7 place-items-center rounded-pill text-ink-faint opacity-0 hover:bg-rose-soft hover:text-rose focus:opacity-100 group-hover:opacity-100"
                    aria-label={`Borrar ${v.name}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </button>
                ) : null}
              </>
            )}
          </li>
        ))}
      </ul>
      {canSave ? (
        <div className="border-t border-border pt-3">
          {active && dirty && active.canManage !== false ? (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  onSave({ name: active.name ?? '', shared: Boolean(active.shared), asNew: false }),
                )
              }
              className={clsx(menuItem, 'mb-2 font-semibold text-primary')}
            >
              <Check className="h-3.5 w-3.5" aria-hidden />
              Guardar cambios en «{active.name}»
            </button>
          ) : null}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim()) return;
              void run(async () => {
                await onSave({ name: name.trim(), shared, asNew: true });
                setName('');
              });
            }}
          >
            <label htmlFor={nameId} className="field-label mb-1 block">
              Guardar lo que ves como vista nueva
            </label>
            <div className="flex gap-2">
              <input
                id={nameId}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ej.: Novedades de esta semana"
                maxLength={80}
                className={inputClass}
              />
              <button
                type="submit"
                disabled={busy || !name.trim()}
                className="h-9 shrink-0 rounded-pill bg-primary px-3 text-xs font-bold text-white disabled:opacity-50"
              >
                Guardar
              </button>
            </div>
            <label className="mt-2 flex items-center gap-2 text-micro text-ink-muted">
              <input
                type="checkbox"
                checked={shared}
                onChange={(e) => setShared(e.target.checked)}
              />
              Que la vea todo el equipo
            </label>
          </form>
        </div>
      ) : null}
      <button type="button" onClick={onCopyLink} className={clsx(menuItem, 'mt-2')}>
        <Copy className="h-3.5 w-3.5 text-ink-faint" aria-hidden />
        Copiar enlace a esta vista
      </button>
    </div>
  );
}
