'use client';

import type { GridColumn, GridRow } from '@/components/datagrid/types';
import { groupTotals } from '@/lib/datagrid/aggregate';
import {
  MONTHS_LONG,
  addDays,
  bogotaDay,
  dayKey,
  formatMoney,
  isEmptyValue,
  parseDateTime,
  toLocalInput,
} from '@/lib/datagrid/format';
import { type GridGroup, boardGroups } from '@/lib/datagrid/view';
import { clsx } from 'clsx';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import Link from 'next/link';
import { type DragEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { CellValue, OptionChip } from './cells';
import { Popover, ghostButton } from './primitives';

/**
 * Los otros diseños de la misma lista: tablero, tarjetas, calendario y la
 * lista del teléfono. Todos leen las mismas filas ya filtradas y escriben por
 * el mismo `onCellEdit`, así que mover una tarjeta es editar una celda.
 */

const DRAG_TYPE = 'application/x-cortex-row';

export function titleColumn(columns: GridColumn[]): GridColumn | undefined {
  return columns.find((c) => c.pinned) ?? columns.find((c) => c.primary) ?? columns[0];
}

function cardFields(columns: GridColumn[], exclude: string[]): GridColumn[] {
  const primary = columns.filter((c) => c.primary && !c.pinned && !exclude.includes(c.key));
  const pool = primary.length
    ? primary
    : columns.filter((c) => !c.pinned && !exclude.includes(c.key));
  return pool.slice(0, 4);
}

/** Muestra de a poco: las primeras N, y más cuando el final entra en pantalla. */
function useProgressive(total: number, step = 60) {
  const [limit, setLimit] = useState(step);
  const sentinel = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: otra lista (otro total) vuelve a empezar.
  useEffect(() => {
    setLimit(step);
  }, [total, step]);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || limit >= total) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setLimit((l) => Math.min(total, l + step));
    });
    io.observe(el);
    return () => io.disconnect();
  }, [limit, total, step]);
  return { limit, sentinel };
}

// ---------------------------------------------------------------------------
// Una tarjeta
// ---------------------------------------------------------------------------

export function RowCard({
  row,
  columns,
  exclude = [],
  onOpen,
  selected,
  onToggle,
  draggable,
  onKeyMove,
  dense,
}: {
  row: GridRow;
  columns: GridColumn[];
  exclude?: string[];
  onOpen: ((row: GridRow) => void) | null;
  selected?: boolean;
  onToggle?: () => void;
  draggable?: boolean;
  onKeyMove?: (dir: -1 | 1) => void;
  dense?: boolean;
}) {
  const title = titleColumn(columns);
  const fields = cardFields(columns, [...exclude, title?.key ?? '']);
  const titleText = title ? row.values[title.key] : null;
  const body = (
    <>
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 text-xs font-bold text-ink">
          {title && !isEmptyValue(titleText) ? (
            <CellValue column={title} value={titleText} compact />
          ) : (
            <span className="text-ink-faint">Sin nombre</span>
          )}
        </span>
      </div>
      {fields.length ? (
        <dl className={clsx('mt-2 grid gap-x-3 gap-y-1.5', dense ? 'grid-cols-1' : 'grid-cols-2')}>
          {fields.map((f) => (
            <div key={f.key} className="min-w-0">
              <dt className="truncate text-micro text-ink-faint">{f.label}</dt>
              <dd className="min-w-0 text-xs text-ink">
                {isEmptyValue(row.values[f.key]) ? (
                  <span className="text-ink-faint">—</span>
                ) : (
                  <span className="flex min-w-0">
                    <CellValue column={f} value={row.values[f.key]} compact />
                  </span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </>
  );
  const shell = clsx(
    'group relative block w-full rounded-sm border bg-surface p-3 text-left shadow-card transition-colors',
    selected ? 'border-primary ring-1 ring-primary' : 'border-border hover:border-border-strong',
    draggable && 'cursor-grab active:cursor-grabbing',
  );
  return (
    <div
      className={shell}
      draggable={draggable}
      onDragStart={
        draggable
          ? (e) => {
              e.dataTransfer.setData(DRAG_TYPE, row.id);
              e.dataTransfer.setData('text/plain', row.id);
              e.dataTransfer.effectAllowed = 'move';
            }
          : undefined
      }
    >
      {onToggle ? (
        <input
          type="checkbox"
          checked={Boolean(selected)}
          onChange={onToggle}
          aria-label="Marcar"
          className="absolute right-2.5 top-2.5 z-10 h-4 w-4 accent-[rgb(var(--primary))]"
        />
      ) : null}
      {row.href ? (
        <Link href={row.href} className="block focus:outline-none">
          {body}
        </Link>
      ) : onOpen ? (
        <button
          type="button"
          onClick={() => onOpen(row)}
          onKeyDown={(e) => {
            if (onKeyMove && e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
              e.preventDefault();
              onKeyMove(e.key === 'ArrowLeft' ? -1 : 1);
            }
          }}
          title={onKeyMove ? 'Alt + flechas: mover de columna' : undefined}
          className="block w-full pr-5 text-left focus:outline-none"
        >
          {body}
        </button>
      ) : (
        <div className="pr-5">{body}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tablero
// ---------------------------------------------------------------------------

export function BoardLayout({
  columns,
  rows,
  groupColumn,
  canMove,
  onMove,
  onOpen,
  onCreateInGroup,
  height,
}: {
  columns: GridColumn[];
  rows: GridRow[];
  groupColumn: GridColumn;
  canMove: boolean;
  onMove: (row: GridRow, value: unknown) => void;
  onOpen: ((row: GridRow) => void) | null;
  onCreateInGroup: ((group: GridGroup) => void) | null;
  height: string;
}) {
  const groups = useMemo(() => boardGroups(rows, groupColumn), [rows, groupColumn]);
  const [over, setOver] = useState<string | null>(null);
  const [limits, setLimits] = useState<Record<string, number>>({});
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const moneyCol = columns.find((c) => c.type === 'money');

  const drop = (group: GridGroup, e: DragEvent) => {
    e.preventDefault();
    setOver(null);
    const id = e.dataTransfer.getData(DRAG_TYPE) || e.dataTransfer.getData('text/plain');
    const row = byId.get(id);
    if (!row) return;
    const current = row.values[groupColumn.key];
    if (String(current ?? '') === String(group.value ?? '')) return;
    onMove(row, group.value);
  };

  return (
    <div
      className="flex gap-3 overflow-x-auto pb-2"
      style={{ height }}
      aria-label={`Tablero por ${groupColumn.label}`}
    >
      {groups.map((g, gi) => {
        const limit = limits[g.key] ?? 40;
        const total = moneyCol ? groupTotals(g.rows, [moneyCol])[0]?.value : undefined;
        return (
          <section
            key={g.key || '__empty'}
            aria-label={`${g.label}: ${g.rows.length}`}
            onDragOver={
              canMove
                ? (e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    setOver(g.key);
                  }
                : undefined
            }
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node))
                setOver((k) => (k === g.key ? null : k));
            }}
            onDrop={canMove ? (e) => drop(g, e) : undefined}
            className={clsx(
              'flex w-[288px] shrink-0 flex-col rounded-card border bg-surface-2/60 transition-colors',
              over === g.key ? 'border-primary bg-primary-soft/60' : 'border-border',
            )}
          >
            <header className="flex items-center gap-2 px-3 pb-2 pt-3">
              {g.key ? (
                <OptionChip
                  option={groupColumn.options?.find((o) => o.value === g.key)}
                  value={g.key}
                />
              ) : (
                <span className="text-xs font-bold text-ink-faint">{g.label}</span>
              )}
              <span className="tabular text-micro text-ink-faint">{g.rows.length}</span>
              {total !== undefined && moneyCol ? (
                <span className="tabular ml-auto truncate text-micro font-semibold text-ink-muted">
                  {formatMoney(total, moneyCol.currency)}
                </span>
              ) : null}
              {onCreateInGroup ? (
                <button
                  type="button"
                  onClick={() => onCreateInGroup(g)}
                  className={clsx(
                    'grid h-6 w-6 shrink-0 place-items-center rounded-pill text-ink-faint hover:bg-surface hover:text-primary',
                    total === undefined && 'ml-auto',
                  )}
                  aria-label={`Nueva en ${g.label}`}
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden />
                </button>
              ) : null}
            </header>
            <div className="flex min-h-24 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
              {g.rows.slice(0, limit).map((r) => (
                <RowCard
                  key={r.id}
                  row={r}
                  columns={columns}
                  exclude={[groupColumn.key]}
                  onOpen={onOpen}
                  draggable={canMove && !r.locked}
                  dense
                  onKeyMove={
                    canMove && !r.locked
                      ? (dir) => {
                          const target = groups[gi + dir];
                          if (target) onMove(r, target.value);
                        }
                      : undefined
                  }
                />
              ))}
              {g.rows.length > limit ? (
                <button
                  type="button"
                  onClick={() => setLimits((l) => ({ ...l, [g.key]: limit + 60 }))}
                  className={clsx(ghostButton, 'justify-center')}
                >
                  Mostrar {Math.min(60, g.rows.length - limit)} más
                </button>
              ) : null}
              {!g.rows.length ? (
                <p className="px-2 py-6 text-center text-micro text-ink-faint">
                  {canMove ? 'Arrastra una tarjeta aquí.' : 'Nada aquí.'}
                </p>
              ) : null}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tarjetas y lista móvil
// ---------------------------------------------------------------------------

export function CardsLayout({
  columns,
  rows,
  onOpen,
  selected,
  onToggle,
  mobile,
}: {
  columns: GridColumn[];
  rows: GridRow[];
  onOpen: ((row: GridRow) => void) | null;
  selected: Set<string>;
  onToggle: ((id: string) => void) | null;
  mobile?: boolean;
}) {
  const { limit, sentinel } = useProgressive(rows.length, mobile ? 40 : 60);
  return (
    <div>
      <ul
        className={clsx(
          'grid gap-3',
          mobile ? 'grid-cols-1' : 'grid-cols-[repeat(auto-fill,minmax(260px,1fr))]',
        )}
      >
        {rows.slice(0, limit).map((r) => (
          <li key={r.id}>
            <RowCard
              row={r}
              columns={columns}
              onOpen={onOpen}
              selected={selected.has(r.id)}
              onToggle={onToggle ? () => onToggle(r.id) : undefined}
            />
          </li>
        ))}
      </ul>
      {limit < rows.length ? (
        <div ref={sentinel} className="py-6 text-center text-micro text-ink-faint">
          Cargando más…
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Calendario
// ---------------------------------------------------------------------------

const WEEKDAYS = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];

function monthOf(day: string): string {
  return day.slice(0, 7);
}

function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y ?? 2026, (m ?? 1) - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Mover una fecha a otro día; si tiene hora, conserva la hora de Bogotá. */
export function moveToDay(column: GridColumn, value: unknown, day: string): unknown {
  if (column.type === 'datetime' && typeof value === 'string' && value.includes('T')) {
    const local = toLocalInput(value);
    return parseDateTime(`${day}T${local.slice(11) || '09:00'}`) ?? day;
  }
  return day;
}

export function CalendarLayout({
  columns,
  rows,
  dateColumn,
  canMove,
  onMove,
  onOpen,
  mobile,
}: {
  columns: GridColumn[];
  rows: GridRow[];
  dateColumn: GridColumn;
  canMove: boolean;
  onMove: (row: GridRow, value: unknown) => void;
  onOpen: ((row: GridRow) => void) | null;
  mobile?: boolean;
}) {
  const today = bogotaDay(new Date());
  const [month, setMonth] = useState(() => monthOf(today));
  const [over, setOver] = useState<string | null>(null);
  const title = titleColumn(columns);

  const byDay = useMemo(() => {
    const map = new Map<string, GridRow[]>();
    let undated = 0;
    for (const r of rows) {
      const d = dayKey(r.values[dateColumn.key]);
      if (!d) {
        undated += 1;
        continue;
      }
      const list = map.get(d);
      if (list) list.push(r);
      else map.set(d, [r]);
    }
    return { map, undated };
  }, [rows, dateColumn.key]);
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);

  const first = `${month}-01`;
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y ?? 2026, m ?? 1, 0)).getUTCDate();
  const weekday = (new Date(`${first}T12:00:00Z`).getUTCDay() + 6) % 7;
  const cells: Array<string | null> = [
    ...Array.from({ length: weekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => addDays(first, i)),
  ];
  while (cells.length % 7) cells.push(null);
  const inMonth = [...byDay.map.entries()]
    .filter(([d]) => d.startsWith(month))
    .reduce((n, [, l]) => n + l.length, 0);

  const label = (r: GridRow) => {
    const v = title ? r.values[title.key] : null;
    return isEmptyValue(v) ? 'Sin nombre' : String(v);
  };

  const drop = (day: string, e: DragEvent) => {
    e.preventDefault();
    setOver(null);
    const id = e.dataTransfer.getData(DRAG_TYPE) || e.dataTransfer.getData('text/plain');
    const row = byId.get(id);
    if (!row || dayKey(row.values[dateColumn.key]) === day) return;
    onMove(row, moveToDay(dateColumn, row.values[dateColumn.key], day));
  };

  const header = (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <h3 className="text-base font-bold capitalize text-ink">
        {MONTHS_LONG[(m ?? 1) - 1]} {y}
      </h3>
      <span className="tabular text-micro text-ink-faint">
        {inMonth} en el mes
        {byDay.undated ? ` · ${byDay.undated} sin ${dateColumn.label.toLowerCase()}` : ''}
      </span>
      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          onClick={() => setMonth(shiftMonth(month, -1))}
          className={ghostButton}
          aria-label="Mes anterior"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </button>
        <button type="button" onClick={() => setMonth(monthOf(today))} className={ghostButton}>
          Hoy
        </button>
        <button
          type="button"
          onClick={() => setMonth(shiftMonth(month, 1))}
          className={ghostButton}
          aria-label="Mes siguiente"
        >
          <ChevronRight className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </div>
  );

  if (mobile) {
    const days = cells.filter((d): d is string => Boolean(d && byDay.map.get(d)?.length));
    return (
      <div>
        {header}
        {days.length ? (
          <ol className="flex flex-col gap-3">
            {days.map((d) => (
              <li key={d}>
                <p
                  className={clsx(
                    'tabular mb-1.5 text-micro font-semibold',
                    d === today ? 'text-primary' : 'text-ink-muted',
                  )}
                >
                  {Number(d.slice(8))} ·{' '}
                  {WEEKDAYS[(new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7]}
                </p>
                <div className="flex flex-col gap-2">
                  {byDay.map.get(d)?.map((r) => (
                    <RowCard
                      key={r.id}
                      row={r}
                      columns={columns}
                      exclude={[dateColumn.key]}
                      onOpen={onOpen}
                      dense
                    />
                  ))}
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="rounded-card border border-dashed border-border px-4 py-10 text-center text-xs text-ink-muted">
            Nada este mes.
          </p>
        )}
      </div>
    );
  }

  return (
    <div>
      {header}
      <div className="overflow-hidden rounded-card border border-border bg-surface shadow-card">
        <div className="grid grid-cols-7 border-b border-border bg-surface-2">
          {WEEKDAYS.map((w) => (
            <div key={w} className="px-2 py-2 text-micro font-semibold capitalize text-ink-muted">
              {w}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {cells.map((d, i) => {
            const list = d ? (byDay.map.get(d) ?? []) : [];
            return (
              <div
                key={d ?? `x${i}`}
                onDragOver={
                  d && canMove
                    ? (e) => {
                        e.preventDefault();
                        setOver(d);
                      }
                    : undefined
                }
                onDragLeave={() => setOver((o) => (o === d ? null : o))}
                onDrop={d && canMove ? (e) => drop(d, e) : undefined}
                className={clsx(
                  'min-h-[112px] border-b border-r border-border p-1.5',
                  !d && 'bg-surface-2/50',
                  over === d && d && 'bg-primary-soft',
                )}
              >
                {d ? (
                  <>
                    <span
                      className={clsx(
                        'tabular mb-1 inline-grid h-6 min-w-6 place-items-center rounded-pill px-1 text-micro font-semibold',
                        d === today ? 'bg-primary text-white' : 'text-ink-muted',
                      )}
                    >
                      {Number(d.slice(8))}
                    </span>
                    <div className="flex flex-col gap-1">
                      {list.slice(0, 3).map((r) => (
                        <CalendarChip
                          key={r.id}
                          label={label(r)}
                          row={r}
                          draggable={canMove && !r.locked}
                          onOpen={onOpen}
                        />
                      ))}
                      {list.length > 3 ? (
                        <MoreChip day={d} rows={list} label={label} onOpen={onOpen} />
                      ) : null}
                    </div>
                  </>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function CalendarChip({
  label,
  row,
  draggable,
  onOpen,
}: {
  label: string;
  row: GridRow;
  draggable: boolean;
  onOpen: ((row: GridRow) => void) | null;
}) {
  const inner: ReactNode = <span className="truncate">{label}</span>;
  const cls =
    'flex w-full min-w-0 items-center rounded-[8px] bg-primary-soft px-1.5 py-0.5 text-left text-micro font-semibold text-primary-ink hover:brightness-95';
  return (
    <div
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, row.id);
        e.dataTransfer.setData('text/plain', row.id);
      }}
    >
      {row.href ? (
        <Link href={row.href} className={cls}>
          {inner}
        </Link>
      ) : (
        <button type="button" className={cls} onClick={() => onOpen?.(row)} disabled={!onOpen}>
          {inner}
        </button>
      )}
    </div>
  );
}

function MoreChip({
  day,
  rows,
  label,
  onOpen,
}: {
  day: string;
  rows: GridRow[];
  label: (r: GridRow) => string;
  onOpen: ((row: GridRow) => void) | null;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={ref}
        type="button"
        onClick={() => setOpen(true)}
        className="tabular px-1.5 text-left text-micro font-semibold text-ink-muted hover:text-ink"
      >
        +{rows.length - 3} más
      </button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={ref}
        width={260}
        label={`Todo el ${day}`}
      >
        <p className="tabular mb-2 text-micro font-semibold text-ink-muted">{day}</p>
        <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
          {rows.map((r) => (
            <li key={r.id}>
              <CalendarChip label={label(r)} row={r} draggable={false} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      </Popover>
    </>
  );
}
