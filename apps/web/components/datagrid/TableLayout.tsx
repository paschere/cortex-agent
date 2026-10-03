'use client';

import type { GridAggregate, GridColumn, GridRow, GridView } from '@/components/datagrid/types';
import { AGGREGATES, aggregate, aggregateOf, formatAggregate } from '@/lib/datagrid/aggregate';
import { asBoolean, formatValue, isNumericType } from '@/lib/datagrid/format';
import type { GridGroup } from '@/lib/datagrid/view';
import { clsx } from 'clsx';
import { ArrowDown, ArrowUp, ChevronRight, PanelRightOpen, Plus } from 'lucide-react';
import Link from 'next/link';
import {
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { CellEditor, CellValue, OptionChip } from './cells';
import { Popover, TYPE_ICON, useStable } from './primitives';

/**
 * LA TABLA: encabezado y primera columna fijos, miles de filas sin pesar.
 *
 * VENTANEO A MANO. Solo se dibujan las filas que caben en pantalla más unas
 * cuantas de colchón (todas de la misma altura, así que la cuenta es una
 * división). Con 5.000 guías el DOM tiene ~40 filas, no 5.000.
 *
 * TECLADO como en una hoja de cálculo: flechas para moverse, Enter o F2 para
 * editar (o abrir, en la primera columna si no se edita), escribir sobre una
 * celda la reemplaza, Esc cancela, Tab guarda y sigue a la derecha, Supr la
 * vacía, Espacio marca la fila. El foco vive en la grilla y la celda activa se
 * anuncia con `aria-activedescendant`.
 */

export const ROW_H = 40;
const HEADER_H = 40;
const FOOTER_H = 40;
const CHECK_W = 44;
const ADD_W = 48;
const OVERSCAN = 10;

export const DEFAULT_WIDTH: Record<GridColumn['type'], number> = {
  text: 180,
  long_text: 260,
  number: 110,
  money: 150,
  percent: 110,
  date: 130,
  datetime: 180,
  select: 150,
  status: 150,
  multi_select: 200,
  person: 170,
  boolean: 96,
  link: 200,
  email: 210,
  phone: 150,
};

export function columnWidth(col: GridColumn, view: Pick<GridView, 'widths'>): number {
  return view.widths?.[col.key] ?? col.width ?? DEFAULT_WIDTH[col.type] ?? 160;
}

type Item =
  | { kind: 'group'; group: GridGroup; collapsed: boolean }
  | { kind: 'row'; row: GridRow; index: number };

export interface TableLayoutProps {
  gridId: string;
  columns: GridColumn[];
  rows: GridRow[];
  groups: GridGroup[] | null;
  view: GridView;
  setView: (update: (v: GridView) => GridView) => void;
  selected: Set<string>;
  onToggleRow: (id: string, index: number, range: boolean) => void;
  onToggleAll: () => void;
  canEdit: boolean;
  onCellEdit: (rowId: string, key: string, value: unknown) => void;
  onOpenRow: ((row: GridRow) => void) | null;
  onAddColumn: (() => void) | null;
  onCreateInGroup: ((group: GridGroup) => void) | null;
  onEndReached?: () => void;
  height: string;
  people?: string[];
  noun: { one: string; many: string };
  totalLabel: string;
  onCopy?: (text: string) => void;
}

export function TableLayout(props: TableLayoutProps) {
  const { gridId, columns, rows, groups, view, setView, selected, canEdit, height } = props;

  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<{ row: number; col: number } | null>(null);
  const [editing, setEditing] = useState<{ row: number; col: number; seed?: string } | null>(null);
  const [liveWidths, setLiveWidths] = useState<Record<string, number> | null>(null);

  const widthOf = useCallback(
    (c: GridColumn) => liveWidths?.[c.key] ?? columnWidth(c, view),
    [liveWidths, view],
  );
  const widths = useMemo(() => columns.map(widthOf), [columns, widthOf]);
  const offsets = useMemo(() => {
    const out: number[] = [];
    let x = CHECK_W;
    for (const w of widths) {
      out.push(x);
      x += w;
    }
    return out;
  }, [widths]);
  const totalWidth = CHECK_W + widths.reduce((a, b) => a + b, 0) + (props.onAddColumn ? ADD_W : 0);

  // Filas y cabeceras de grupo en una sola lista, que es lo que se ventanea.
  const { items, rowPos, flatRows } = useMemo(() => {
    const items: Item[] = [];
    const rowPos: number[] = [];
    const flatRows: GridRow[] = [];
    if (groups) {
      for (const group of groups) {
        const isCollapsed = collapsed.has(group.key);
        items.push({ kind: 'group', group, collapsed: isCollapsed });
        if (isCollapsed) continue;
        for (const row of group.rows) {
          rowPos.push(items.length);
          items.push({ kind: 'row', row, index: flatRows.length });
          flatRows.push(row);
        }
      }
    } else {
      for (const row of rows) {
        rowPos.push(items.length);
        items.push({ kind: 'row', row, index: flatRows.length });
        flatRows.push(row);
      }
    }
    return { items, rowPos, flatRows };
  }, [rows, groups, collapsed]);

  // Medir la ventana y seguir el scroll sin re-pintar más de una vez por cuadro.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewport(el.clientHeight));
    ro.observe(el);
    setViewport(el.clientHeight);
    return () => ro.disconnect();
  }, []);
  const frame = useRef(0);
  const onScroll = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      setScrollTop(scroller.current?.scrollTop ?? 0);
    });
  };

  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(items.length, Math.ceil((scrollTop + viewport) / ROW_H) + OVERSCAN);
  const { onEndReached } = props;
  useEffect(() => {
    if (onEndReached && end >= items.length - 20 && items.length > 0) onEndReached();
  }, [end, items.length, onEndReached]);

  // Si la vista cambia, la celda activa puede quedar fuera.
  useEffect(() => {
    setActive((a) => (a && (a.row >= flatRows.length || a.col >= columns.length) ? null : a));
    setEditing(null);
  }, [flatRows.length, columns.length]);

  const cellId = (row: number, col: number) => `${gridId}-c-${row}-${col}`;

  const ensureVisible = useCallback(
    (row: number, col: number) => {
      const el = scroller.current;
      if (!el) return;
      const pos = rowPos[row];
      if (pos === undefined) return;
      const top = pos * ROW_H;
      const bottom = top + ROW_H;
      const usable = el.clientHeight - HEADER_H - FOOTER_H;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (bottom > el.scrollTop + usable) el.scrollTop = bottom - usable;
      if (col > 0) {
        const left = offsets[col] ?? 0;
        const right = left + (widths[col] ?? 0);
        const stickyRight = CHECK_W + (widths[0] ?? 0);
        if (left - stickyRight < el.scrollLeft) el.scrollLeft = Math.max(0, left - stickyRight);
        else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth;
      }
    },
    [rowPos, offsets, widths],
  );

  const isEditable = useCallback(
    (row: GridRow | undefined, col: GridColumn | undefined) =>
      Boolean(canEdit && row && col && col.editable !== false && !row.locked),
    [canEdit],
  );

  const move = useCallback(
    (row: number, col: number) => {
      const r = Math.max(0, Math.min(row, flatRows.length - 1));
      const c = Math.max(0, Math.min(col, columns.length - 1));
      setActive({ row: r, col: c });
      ensureVisible(r, c);
    },
    [flatRows.length, columns.length, ensureVisible],
  );

  const focusGrid = () => scroller.current?.focus({ preventScroll: true });

  const commit = (row: number, col: number, value: unknown, moveTo?: 'next' | 'prev' | 'down') => {
    const r = flatRows[row];
    const c = columns[col];
    setEditing(null);
    if (r && c) props.onCellEdit(r.id, c.key, value);
    if (moveTo === 'down') move(row + 1, col);
    else if (moveTo === 'next')
      move(col + 1 < columns.length ? row : row + 1, col + 1 < columns.length ? col + 1 : 0);
    else if (moveTo === 'prev')
      move(col > 0 ? row : row - 1, col > 0 ? col - 1 : columns.length - 1);
    requestAnimationFrame(focusGrid);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editing) return;
    if (!flatRows.length) return;
    const a = active ?? { row: 0, col: 0 };
    const row = flatRows[a.row];
    const col = columns[a.col];
    const page = Math.max(1, Math.floor((viewport - HEADER_H - FOOTER_H) / ROW_H) - 1);
    const mod = e.metaKey || e.ctrlKey;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        move(mod ? flatRows.length - 1 : a.row + 1, a.col);
        return;
      case 'ArrowUp':
        e.preventDefault();
        move(mod ? 0 : a.row - 1, a.col);
        return;
      case 'ArrowRight':
        e.preventDefault();
        move(a.row, mod ? columns.length - 1 : a.col + 1);
        return;
      case 'ArrowLeft':
        e.preventDefault();
        move(a.row, mod ? 0 : a.col - 1);
        return;
      case 'Home':
        e.preventDefault();
        move(mod ? 0 : a.row, 0);
        return;
      case 'End':
        e.preventDefault();
        move(mod ? flatRows.length - 1 : a.row, columns.length - 1);
        return;
      case 'PageDown':
        e.preventDefault();
        move(a.row + page, a.col);
        return;
      case 'PageUp':
        e.preventDefault();
        move(a.row - page, a.col);
        return;
      case 'Tab':
        if (!active) return;
        if ((e.shiftKey && a.col === 0) || (!e.shiftKey && a.col === columns.length - 1)) return;
        e.preventDefault();
        move(a.row, a.col + (e.shiftKey ? -1 : 1));
        return;
      case 'Enter':
      case 'F2':
        e.preventDefault();
        if (!active) {
          move(0, 0);
          return;
        }
        if (isEditable(row, col)) {
          if (col?.type === 'boolean') {
            if (row) props.onCellEdit(row.id, col.key, !(asBoolean(row.values[col.key]) ?? false));
          } else setEditing({ row: a.row, col: a.col });
        } else if (a.col === 0 && row && props.onOpenRow) props.onOpenRow(row);
        return;
      case ' ':
        e.preventDefault();
        if (!row) return;
        if (col?.type === 'boolean' && isEditable(row, col) && !e.shiftKey)
          props.onCellEdit(row.id, col.key, !(asBoolean(row.values[col.key]) ?? false));
        else props.onToggleRow(row.id, a.row, e.shiftKey);
        return;
      case 'Delete':
      case 'Backspace':
        if (row && col && isEditable(row, col) && !col.required) {
          e.preventDefault();
          props.onCellEdit(row.id, col.key, col.type === 'multi_select' ? [] : null);
        }
        return;
      case 'Escape':
        if (selected.size) props.onToggleAll();
        return;
      default:
        if (mod && (e.key === 'c' || e.key === 'C') && row && col) {
          props.onCopy?.(formatValue(col, row.values[col.key]));
          return;
        }
        if (
          e.key.length === 1 &&
          !mod &&
          !e.altKey &&
          active &&
          isEditable(row, col) &&
          col &&
          !['select', 'status', 'multi_select', 'boolean', 'date', 'datetime'].includes(col.type)
        ) {
          e.preventDefault();
          setEditing({ row: a.row, col: a.col, seed: e.key });
        }
    }
  };

  const onCellClick = (rowIndex: number, colIndex: number, e: React.MouseEvent) => {
    const row = flatRows[rowIndex];
    const col = columns[colIndex];
    const wasActive = active?.row === rowIndex && active.col === colIndex;
    setActive({ row: rowIndex, col: colIndex });
    focusGrid();
    if (e.detail === 2 || (wasActive && e.detail === 1)) {
      if (isEditable(row, col)) {
        if (col?.type === 'boolean') {
          if (row && e.detail === 1)
            props.onCellEdit(row.id, col.key, !(asBoolean(row.values[col.key]) ?? false));
        } else setEditing({ row: rowIndex, col: colIndex });
      } else if (e.detail === 2 && row && props.onOpenRow) props.onOpenRow(row);
    }
  };

  // --- Ancho de columnas ------------------------------------------------------
  const startResize = (col: GridColumn, e: ReactPointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widthOf(col);
    let latest = startW;
    const onMove = (ev: PointerEvent) => {
      latest = Math.max(64, Math.min(800, startW + ev.clientX - startX));
      setLiveWidths({ [col.key]: latest });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setLiveWidths(null);
      setView((v) => ({ ...v, widths: { ...(v.widths ?? {}), [col.key]: Math.round(latest) } }));
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const toggleSort = (key: string, add: boolean) =>
    setView((v) => {
      const current = v.sort.find((s) => s.key === key);
      const others = add ? v.sort.filter((s) => s.key !== key) : [];
      if (!current) return { ...v, sort: [...others, { key, dir: 'asc' }] };
      if (current.dir === 'asc')
        return {
          ...v,
          sort: add
            ? v.sort.map((s) => (s.key === key ? { ...s, dir: 'desc' } : s))
            : [{ key, dir: 'desc' }],
        };
      return { ...v, sort: others };
    });

  const stableClick = useStable(onCellClick);
  const stableCommit = useStable(commit);
  const stableCancel = useStable(() => {
    setEditing(null);
    requestAnimationFrame(focusGrid);
  });

  const allSelected = flatRows.length > 0 && flatRows.every((r) => selected.has(r.id));
  const someSelected = !allSelected && flatRows.some((r) => selected.has(r.id));
  const activeCell = active ? cellId(active.row, active.col) : undefined;

  return (
    // biome-ignore format: `role` y `tabIndex` en la línea del elemento, para que la supresión de abajo los cubra.
    // biome-ignore lint/a11y/useSemanticElements lint/a11y/noNoninteractiveTabindex: grilla ARIA ventaneada (patrón WAI «grid»): una <table> no admite filas posicionadas, y el contenedor es el que recibe el foco; la celda activa va por aria-activedescendant.
    <div role="grid" tabIndex={0}
      ref={scroller}
      aria-label={`Tabla de ${props.noun.many}`}
      aria-rowcount={flatRows.length + 1}
      aria-colcount={columns.length + 1}
      aria-multiselectable
      aria-activedescendant={activeCell}
      onKeyDown={onKeyDown}
      onFocus={(e) => {
        if (e.target === scroller.current && !active && flatRows.length)
          setActive({ row: 0, col: 0 });
      }}
      onScroll={onScroll}
      className="relative overflow-auto overscroll-contain rounded-card border border-border bg-surface shadow-card focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
      style={{ height }}
    >
      <div style={{ width: totalWidth, minWidth: '100%' }}>
        {/* Encabezado */}
        {/* biome-ignore lint/a11y/useSemanticElements: parte de la grilla ARIA ventaneada. */}
        <div role="rowgroup" className="sticky top-0 z-30">
          {/* biome-ignore lint/a11y/useSemanticElements lint/a11y/useFocusableInteractive: fila de la grilla ARIA; el foco lo lleva la grilla (aria-activedescendant). */}
          <div
            role="row"
            aria-rowindex={1}
            className="flex border-b border-border bg-surface-2"
            style={{ height: HEADER_H }}
          >
            {/* biome-ignore lint/a11y/useSemanticElements: encabezado de la grilla ARIA ventaneada. */}
            <div
              role="columnheader"
              className="sticky left-0 z-40 grid shrink-0 place-items-center border-r border-border bg-surface-2"
              style={{ width: CHECK_W }}
            >
              <input
                type="checkbox"
                aria-label={
                  allSelected ? 'Quitar la selección' : `Marcar las ${flatRows.length} filas`
                }
                checked={allSelected}
                ref={(el) => {
                  if (el) el.indeterminate = someSelected;
                }}
                onChange={props.onToggleAll}
                className="h-4 w-4 cursor-pointer accent-[rgb(var(--primary))]"
              />
            </div>
            {columns.map((col, i) => {
              const sort = view.sort.findIndex((s) => s.key === col.key);
              const dir = sort >= 0 ? view.sort[sort]?.dir : undefined;
              const Icon = TYPE_ICON[col.type];
              const numeric = isNumericType(col.type);
              return (
                // biome-ignore lint/a11y/useSemanticElements: encabezado de la grilla ARIA ventaneada.
                <div
                  role="columnheader"
                  key={col.key}
                  aria-colindex={i + 2}
                  aria-sort={
                    dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : undefined
                  }
                  className={clsx(
                    'group/h relative flex shrink-0 items-center border-r border-border bg-surface-2',
                    i === 0 && 'sticky z-40 shadow-[1px_0_0_rgb(var(--border))]',
                  )}
                  style={{ width: widths[i], ...(i === 0 ? { left: CHECK_W } : {}) }}
                >
                  <button
                    type="button"
                    tabIndex={-1}
                    title={`${col.description ? `${col.description}\n` : ''}Ordenar por ${col.label} (Mayús para sumar otro orden)`}
                    onClick={(e) => toggleSort(col.key, e.shiftKey)}
                    className={clsx(
                      'flex h-full min-w-0 flex-1 items-center gap-1.5 px-3 text-micro font-semibold text-ink-muted hover:text-ink',
                      numeric && 'flex-row-reverse text-right',
                    )}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden />
                    <span className="truncate">{col.label}</span>
                    {col.required ? (
                      <span className="text-rose" aria-hidden>
                        *
                      </span>
                    ) : null}
                    {dir ? (
                      <span className="inline-flex shrink-0 items-center text-primary">
                        {dir === 'asc' ? (
                          <ArrowUp className="h-3 w-3" aria-hidden />
                        ) : (
                          <ArrowDown className="h-3 w-3" aria-hidden />
                        )}
                        {view.sort.length > 1 ? (
                          <span className="tabular text-micro">{sort + 1}</span>
                        ) : null}
                      </span>
                    ) : null}
                  </button>
                  {/* biome-ignore lint/a11y/useSemanticElements: separador que se arrastra o se mueve con flechas. */}
                  <div
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={`Ancho de ${col.label}`}
                    aria-valuenow={widths[i]}
                    tabIndex={0}
                    onPointerDown={(e) => startResize(col, e)}
                    onDoubleClick={() =>
                      setView((v) => {
                        const { [col.key]: _drop, ...rest } = v.widths ?? {};
                        return { ...v, widths: rest };
                      })
                    }
                    onKeyDown={(e) => {
                      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                      e.preventDefault();
                      e.stopPropagation();
                      const w = Math.max(
                        64,
                        Math.min(800, (widths[i] ?? 120) + (e.key === 'ArrowRight' ? 16 : -16)),
                      );
                      setView((v) => ({ ...v, widths: { ...(v.widths ?? {}), [col.key]: w } }));
                    }}
                    className="absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize opacity-0 hover:opacity-100 focus-visible:opacity-100 group-hover/h:opacity-60"
                  >
                    <span className="mx-auto block h-full w-0.5 bg-primary" />
                  </div>
                </div>
              );
            })}
            {props.onAddColumn ? (
              // biome-ignore lint/a11y/useSemanticElements: encabezado de la grilla ARIA ventaneada.
              <div
                role="columnheader"
                className="grid shrink-0 place-items-center bg-surface-2"
                style={{ width: ADD_W }}
              >
                <button
                  type="button"
                  onClick={props.onAddColumn}
                  className="grid h-7 w-7 place-items-center rounded-pill text-ink-muted hover:bg-surface hover:text-primary"
                  aria-label="Agregar columna"
                  title="Agregar columna"
                >
                  <Plus className="h-4 w-4" aria-hidden />
                </button>
              </div>
            ) : null}
          </div>
        </div>

        {/* Cuerpo ventaneado */}
        {/* biome-ignore lint/a11y/useSemanticElements: parte de la grilla ARIA ventaneada. */}
        <div role="rowgroup" className="relative" style={{ height: items.length * ROW_H }}>
          {items.slice(start, end).map((item, k) => {
            const pos = start + k;
            if (item.kind === 'group')
              return (
                <GroupHeader
                  key={`g:${item.group.key}`}
                  group={item.group}
                  collapsed={item.collapsed}
                  top={pos * ROW_H}
                  columns={columns}
                  widths={widths}
                  view={view}
                  onToggle={() =>
                    setCollapsed((s) => {
                      const next = new Set(s);
                      if (next.has(item.group.key)) next.delete(item.group.key);
                      else next.add(item.group.key);
                      return next;
                    })
                  }
                  onCreate={
                    props.onCreateInGroup ? () => props.onCreateInGroup?.(item.group) : null
                  }
                  groupColumn={columns.find((c) => c.key === view.groupBy) ?? null}
                />
              );
            const rowIndex = item.index;
            return (
              <Row
                key={item.row.id}
                gridId={gridId}
                row={item.row}
                index={rowIndex}
                top={pos * ROW_H}
                columns={columns}
                widths={widths}
                selected={selected.has(item.row.id)}
                activeCol={active?.row === rowIndex ? active.col : -1}
                editing={editing?.row === rowIndex ? editing : null}
                canEdit={canEdit}
                people={props.people}
                onCellClick={stableClick}
                onToggle={props.onToggleRow}
                onOpen={props.onOpenRow}
                onCommit={stableCommit}
                onCancel={stableCancel}
              />
            );
          })}
        </div>

        {/* Pie con cifras */}
        <Footer
          columns={columns}
          widths={widths}
          rows={rows}
          view={view}
          setView={setView}
          totalLabel={props.totalLabel}
          hasAdd={Boolean(props.onAddColumn)}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Una fila
// ---------------------------------------------------------------------------

const Row = memo(function Row({
  gridId,
  row,
  index,
  top,
  columns,
  widths,
  selected,
  activeCol,
  editing,
  canEdit,
  people,
  onCellClick,
  onToggle,
  onOpen,
  onCommit,
  onCancel,
}: {
  gridId: string;
  row: GridRow;
  index: number;
  top: number;
  columns: GridColumn[];
  widths: number[];
  selected: boolean;
  activeCol: number;
  editing: { col: number; seed?: string } | null;
  canEdit: boolean;
  people?: string[];
  onCellClick: (row: number, col: number, e: React.MouseEvent) => void;
  onToggle: (id: string, index: number, range: boolean) => void;
  onOpen: ((row: GridRow) => void) | null;
  onCommit: (row: number, col: number, value: unknown, move?: 'next' | 'prev' | 'down') => void;
  onCancel: () => void;
}) {
  const bg = selected ? 'bg-primary-soft' : 'bg-surface group-hover/r:bg-surface-2';
  return (
    // biome-ignore lint/a11y/useSemanticElements lint/a11y/useFocusableInteractive: fila de la grilla ARIA; el foco lo lleva la grilla (aria-activedescendant).
    <div
      role="row"
      aria-rowindex={index + 2}
      aria-selected={selected}
      className="group/r absolute left-0 flex border-b border-border"
      style={{ top, height: ROW_H, width: '100%' }}
    >
      {/* biome-ignore lint/a11y/useSemanticElements lint/a11y/useFocusableInteractive: celda de la grilla ARIA; el foco lo lleva la grilla (aria-activedescendant). */}
      <div
        role="gridcell"
        className={clsx(
          'sticky left-0 z-10 grid shrink-0 place-items-center border-r border-border',
          bg,
        )}
        style={{ width: CHECK_W }}
      >
        <input
          type="checkbox"
          tabIndex={-1}
          aria-label="Marcar fila"
          checked={selected}
          onChange={() => {}}
          onClick={(e) => {
            e.stopPropagation();
            onToggle(row.id, index, e.shiftKey);
          }}
          className="h-4 w-4 cursor-pointer accent-[rgb(var(--primary))]"
        />
      </div>
      {columns.map((col, i) => {
        const isActive = activeCol === i;
        const isEditing = editing?.col === i;
        const editable = canEdit && col.editable !== false && !row.locked;
        const numeric = isNumericType(col.type);
        const id = `${gridId}-c-${index}-${i}`;
        return (
          // biome-ignore lint/a11y/useSemanticElements lint/a11y/useFocusableInteractive: celda de la grilla ARIA; el foco lo lleva la grilla (aria-activedescendant).
          <div
            role="gridcell"
            key={col.key}
            id={id}
            aria-colindex={i + 2}
            aria-readonly={!editable || undefined}
            onClick={(e) => onCellClick(index, i, e)}
            onKeyDown={() => {}}
            className={clsx(
              'relative flex shrink-0 items-center border-r border-border px-3 text-xs text-ink',
              bg,
              i === 0 && 'sticky z-10 font-semibold shadow-[1px_0_0_rgb(var(--border))]',
              numeric && 'justify-end',
              isActive && 'z-[15] outline outline-2 -outline-offset-2 outline-primary',
              !editable && i !== 0 && 'text-ink-muted',
            )}
            style={{ width: widths[i], ...(i === 0 ? { left: CHECK_W } : {}) }}
          >
            <span className="min-w-0 flex-1 overflow-hidden">
              <span className={clsx('flex min-w-0', numeric && 'justify-end')}>
                <CellValue column={col} value={row.values[col.key]} compact />
              </span>
            </span>
            {i === 0 && onOpen ? (
              row.href ? (
                <Link
                  href={row.href}
                  tabIndex={-1}
                  onClick={(e) => e.stopPropagation()}
                  className="ml-1 grid h-6 w-6 shrink-0 place-items-center rounded-pill text-ink-faint opacity-0 hover:bg-surface hover:text-primary group-hover/r:opacity-100"
                  aria-label="Abrir"
                >
                  <PanelRightOpen className="h-3.5 w-3.5" aria-hidden />
                </Link>
              ) : (
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpen(row);
                  }}
                  className={clsx(
                    'ml-1 grid h-6 w-6 shrink-0 place-items-center rounded-pill text-ink-faint hover:bg-surface hover:text-primary group-hover/r:opacity-100',
                    isActive ? 'opacity-100' : 'opacity-0',
                  )}
                  aria-label="Abrir detalle"
                >
                  <PanelRightOpen className="h-3.5 w-3.5" aria-hidden />
                </button>
              )
            ) : null}
            {isEditing ? (
              <CellEditor
                column={col}
                value={row.values[col.key]}
                seed={editing?.seed}
                people={people}
                anchor={typeof document === 'undefined' ? null : document.getElementById(id)}
                onCommit={(value, move) => onCommit(index, i, value, move)}
                onCancel={onCancel}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Cabecera de grupo
// ---------------------------------------------------------------------------

function GroupHeader({
  group,
  collapsed,
  top,
  columns,
  widths,
  view,
  onToggle,
  onCreate,
  groupColumn,
}: {
  group: GridGroup;
  collapsed: boolean;
  top: number;
  columns: GridColumn[];
  widths: number[];
  view: GridView;
  onToggle: () => void;
  onCreate: (() => void) | null;
  groupColumn: GridColumn | null;
}) {
  const first = (widths[0] ?? 0) + CHECK_W;
  const isOption = groupColumn && (groupColumn.type === 'select' || groupColumn.type === 'status');
  return (
    // biome-ignore lint/a11y/useSemanticElements lint/a11y/useFocusableInteractive: fila de la grilla ARIA; el foco lo lleva la grilla (aria-activedescendant).
    <div
      role="row"
      className="absolute left-0 flex border-b border-border bg-canvas"
      style={{ top, height: ROW_H, width: '100%' }}
    >
      {/* biome-ignore lint/a11y/useSemanticElements lint/a11y/useFocusableInteractive: celda de la grilla ARIA; el foco lo lleva la grilla (aria-activedescendant). */}
      <div
        role="gridcell"
        aria-colspan={2}
        className="sticky left-0 z-10 flex shrink-0 items-center gap-2 bg-canvas pl-2 pr-2 shadow-[1px_0_0_rgb(var(--border))]"
        style={{ width: first }}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-pill px-1.5 py-1 text-left hover:bg-surface-2"
        >
          <ChevronRight
            className={clsx(
              'h-4 w-4 shrink-0 text-ink-muted transition-transform',
              !collapsed && 'rotate-90',
            )}
            aria-hidden
          />
          {isOption && group.key ? (
            <OptionChip
              option={groupColumn.options?.find((o) => o.value === group.key)}
              value={group.key}
            />
          ) : (
            <span
              className={clsx(
                'truncate text-xs font-bold',
                group.key ? 'text-ink' : 'text-ink-faint',
              )}
            >
              {group.label}
            </span>
          )}
          <span className="tabular shrink-0 text-micro text-ink-faint">{group.rows.length}</span>
        </button>
        {onCreate ? (
          <button
            type="button"
            onClick={onCreate}
            className="grid h-6 w-6 shrink-0 place-items-center rounded-pill text-ink-faint hover:bg-surface-2 hover:text-primary"
            aria-label={`Nueva fila en ${group.label}`}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
          </button>
        ) : null}
      </div>
      {columns.slice(1).map((col, j) => {
        const i = j + 1;
        const numeric = isNumericType(col.type);
        let text = '';
        if (numeric) {
          const kind = aggregateOf(col, view.aggregates);
          if (kind !== 'none')
            text = formatAggregate(col, kind, aggregate(group.rows, col.key, kind));
          if (text === '—') text = '';
        }
        return (
          // biome-ignore lint/a11y/useSemanticElements lint/a11y/useFocusableInteractive: celda de la grilla ARIA; el foco lo lleva la grilla (aria-activedescendant).
          <div
            role="gridcell"
            key={col.key}
            className="tabular flex shrink-0 items-center justify-end px-3 text-micro font-semibold text-ink-muted"
            style={{ width: widths[i] }}
          >
            {text}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pie: total de filas y la cifra elegida por columna numérica
// ---------------------------------------------------------------------------

function Footer({
  columns,
  widths,
  rows,
  view,
  setView,
  totalLabel,
  hasAdd,
}: {
  columns: GridColumn[];
  widths: number[];
  rows: GridRow[];
  view: GridView;
  setView: (update: (v: GridView) => GridView) => void;
  totalLabel: string;
  hasAdd: boolean;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: parte de la grilla ARIA ventaneada.
    <div role="rowgroup" className="sticky bottom-0 z-30">
      {/* biome-ignore lint/a11y/useSemanticElements lint/a11y/useFocusableInteractive: fila de la grilla ARIA; el foco lo lleva la grilla (aria-activedescendant). */}
      <div
        role="row"
        className="flex border-t border-border bg-surface-2"
        style={{ height: FOOTER_H }}
      >
        {/* biome-ignore lint/a11y/useSemanticElements lint/a11y/useFocusableInteractive: celda de la grilla ARIA; el foco lo lleva la grilla (aria-activedescendant). */}
        <div
          role="gridcell"
          className="sticky left-0 z-40 flex shrink-0 items-center bg-surface-2 px-3 shadow-[1px_0_0_rgb(var(--border))]"
          style={{ width: CHECK_W + (widths[0] ?? 0) }}
        >
          <span className="tabular truncate text-micro font-semibold text-ink-muted">
            {totalLabel}
          </span>
        </div>
        {columns.slice(1).map((col, j) => (
          // biome-ignore lint/a11y/useSemanticElements lint/a11y/useFocusableInteractive: celda de la grilla ARIA; el foco lo lleva la grilla (aria-activedescendant).
          <div
            role="gridcell"
            key={col.key}
            className="flex shrink-0 items-center justify-end border-r border-border px-1.5"
            style={{ width: widths[j + 1] }}
          >
            {isNumericType(col.type) ? (
              <AggregateCell
                column={col}
                rows={rows}
                kind={aggregateOf(col, view.aggregates)}
                setView={setView}
              />
            ) : null}
          </div>
        ))}
        {hasAdd ? <div className="shrink-0" style={{ width: ADD_W }} /> : null}
      </div>
    </div>
  );
}

function AggregateCell({
  column,
  rows,
  kind,
  setView,
}: {
  column: GridColumn;
  rows: GridRow[];
  kind: GridAggregate;
  setView: (update: (v: GridView) => GridView) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const value = useMemo(() => aggregate(rows, column.key, kind), [rows, column.key, kind]);
  const meta = AGGREGATES.find((a) => a.kind === kind);
  return (
    <>
      <button
        ref={ref}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`Cifra del pie de ${column.label}`}
        className="flex min-w-0 items-baseline gap-1.5 rounded-pill px-1.5 py-1 hover:bg-surface"
      >
        {kind === 'none' ? (
          <span className="text-micro text-ink-faint">Calcular</span>
        ) : (
          <>
            <span className="text-micro text-ink-faint">{meta?.short}</span>
            <span className="tabular truncate text-xs font-semibold text-ink">
              {formatAggregate(column, kind, value)}
            </span>
          </>
        )}
      </button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={ref}
        width={200}
        align="end"
        label={`Cifra de ${column.label}`}
      >
        <div role="menu" className="flex flex-col gap-0.5">
          {AGGREGATES.map((a) => (
            <button
              key={a.kind}
              type="button"
              role="menuitemradio"
              aria-checked={a.kind === kind}
              onClick={() => {
                setView((v) => ({
                  ...v,
                  aggregates: { ...(v.aggregates ?? {}), [column.key]: a.kind },
                }));
                setOpen(false);
              }}
              className={clsx(
                'flex items-center justify-between rounded-sm px-2.5 py-1.5 text-left text-xs hover:bg-surface-2',
                a.kind === kind && 'font-bold text-primary',
              )}
            >
              <span>{a.label}</span>
              {a.kind !== 'none' ? (
                <span className="tabular text-micro text-ink-muted">
                  {formatAggregate(column, a.kind, aggregate(rows, column.key, a.kind))}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}
