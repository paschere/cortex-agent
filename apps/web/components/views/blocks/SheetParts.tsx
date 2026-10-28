'use client';

import type { ComputedBlock, Tone } from '@cortex/agent-tools';
import { type RangeStats, savedAgo } from '@cortex/agent-tools/src/views/sheet-edit';
import { formatSheetNumber } from '@cortex/agent-tools/src/views/sheet-math';
import { type PasteField, normalizePasteCell } from '@cortex/agent-tools/src/views/sheet-paste';
import * as Dialog from '@radix-ui/react-dialog';
import { clsx } from 'clsx';
import {
  AlignLeft,
  AlertCircle,
  CalendarDays,
  Check,
  CheckSquare,
  CircleDollarSign,
  Copy,
  Hash,
  Link2,
  Loader2,
  Lock,
  MoveRight,
  Paperclip,
  Redo2,
  Sigma,
  Type,
  Undo2,
  X,
  ChevronsUpDown,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SubmitTarget } from '../ViewCanvas';
import { RelationField } from './SheetRelation';
import { StatusChip } from './theme';

export type SheetBlockData = Extract<ComputedBlock, { type: 'sheet' }>;
export type SheetRow = SheetBlockData['rows'][number] & {
  /** Fila fantasma del final de un grupo o de la hoja: escribir en ella crea la fila. */
  ghost?: true;
  /** Fila recién creada que el servidor todavía no devolvió. */
  fresh?: true;
};
export type SheetCol = SheetBlockData['columns'][number];

// ---------------------------------------------------------------------------
// Ícono por tipo de columna
// ---------------------------------------------------------------------------

export function ColIcon({ col }: { col: SheetCol }) {
  const cls = 'h-3 w-3 shrink-0 text-ink-faint/80';
  if (col.readonly) return <Sigma className={cls} aria-hidden />;
  switch (col.type) {
    case 'number':
      return <Hash className={cls} aria-hidden />;
    case 'money':
      return <CircleDollarSign className={cls} aria-hidden />;
    case 'date':
      return <CalendarDays className={cls} aria-hidden />;
    case 'select':
      return <ChevronsUpDown className={cls} aria-hidden />;
    case 'relation':
      return <Link2 className={cls} aria-hidden />;
    case 'checkbox':
      return <CheckSquare className={cls} aria-hidden />;
    case 'file':
      return <Paperclip className={cls} aria-hidden />;
    case 'longtext':
      return <AlignLeft className={cls} aria-hidden />;
    default:
      return <Type className={cls} aria-hidden />;
  }
}

export function LockedHint() {
  return <Lock className="h-3 w-3 shrink-0 text-ink-faint/60" aria-hidden />;
}

// ---------------------------------------------------------------------------
// Menú flotante anclado a un elemento (no lo recorta el desplazamiento de la hoja)
// ---------------------------------------------------------------------------

export function FloatingMenu({
  anchor,
  onClose,
  label,
  minWidth = 192,
  children,
  align = 'left',
}: {
  anchor: HTMLElement | null;
  onClose: () => void;
  label: string;
  minWidth?: number;
  children: React.ReactNode;
  align?: 'left' | 'right';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ left: number; top: number; max: number; up: boolean; width: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const r = anchor?.getBoundingClientRect();
      if (!r) return;
      const below = window.innerHeight - r.bottom - 8;
      const up = below < 200 && r.top > below;
      const width = Math.max(minWidth, r.width);
      const left = align === 'right' ? r.right - width : r.left;
      setBox({
        left: Math.max(8, Math.min(left, window.innerWidth - width - 8)),
        top: up ? r.top : r.bottom,
        max: Math.max(120, Math.min(320, up ? r.top - 8 : below)),
        up,
        width,
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor, minWidth, align]);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (t && (ref.current?.contains(t) || anchor?.contains(t))) return;
      onClose();
    };
    document.addEventListener('mousedown', down);
    return () => document.removeEventListener('mousedown', down);
  }, [anchor, onClose]);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className="scroll-slim fixed z-[66] overflow-auto rounded-sm border border-border bg-surface py-1 text-xs shadow-pop"
      style={
        box
          ? {
              left: box.left,
              width: box.width,
              maxHeight: box.max,
              ...(box.up ? { bottom: window.innerHeight - box.top } : { top: box.top }),
            }
          : { visibility: 'hidden' }
      }
    >
      {children}
    </div>,
    document.body,
  );
}

export function MenuItem({
  icon,
  children,
  onClick,
  hint,
  disabled,
}: {
  icon?: React.ReactNode;
  children: React.ReactNode;
  onClick: () => void;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-ink hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none disabled:opacity-40"
    >
      {icon}
      <span className="flex-1">{children}</span>
      {hint && <span className="font-mono text-micro text-ink-faint">{hint}</span>}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Estado como chip: cambio en un clic
// ---------------------------------------------------------------------------

export function StatusPicker({
  anchor,
  options,
  current,
  required,
  toneOf,
  label,
  onPick,
  onCancel,
}: {
  anchor: HTMLElement | null;
  options: string[];
  current: string;
  required?: boolean;
  toneOf: (v: string) => Tone | null;
  label: string;
  onPick: (value: string) => void;
  onCancel: () => void;
}) {
  const items = useMemo(() => (required ? options : ['', ...options]), [options, required]);
  const [active, setActive] = useState(Math.max(0, items.indexOf(current)));
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    listRef.current?.focus();
  }, []);
  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') setActive((a) => Math.min(items.length - 1, a + 1));
    else if (e.key === 'ArrowUp') setActive((a) => Math.max(0, a - 1));
    else if (e.key === 'Enter') onPick(items[active] ?? '');
    else if (e.key === 'Escape' || e.key === 'Tab') onCancel();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  return (
    <FloatingMenu anchor={anchor} onClose={onCancel} label={label} minWidth={176}>
      <ul
        ref={listRef}
        role="listbox"
        aria-label={label}
        aria-activedescendant={`status-opt-${active}`}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="outline-none"
      >
        {items.map((o, i) => (
          <li
            key={o || '__none'}
            id={`status-opt-${i}`}
            role="option"
            aria-selected={o === current}
            onMouseEnter={() => setActive(i)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(o)}
            className={clsx(
              'flex cursor-pointer items-center gap-2 px-3 py-1.5',
              i === active && 'bg-primary-soft/70',
            )}
          >
            <span className="min-w-0 flex-1">
              {o ? <StatusChip value={o} tone={toneOf(o)} /> : <span className="text-ink-faint">Sin valor</span>}
            </span>
            {o === current && <Check className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />}
          </li>
        ))}
      </ul>
    </FloatingMenu>
  );
}

// ---------------------------------------------------------------------------
// Una cifra que se mueve un instante cuando cambia
// ---------------------------------------------------------------------------

/** Pinta el texto y, si cambió respecto del anterior, lo anima brevemente (CSS; se apaga con prefers-reduced-motion). */
export function BumpText({ text, className }: { text: string; className?: string }) {
  const prev = useRef(text);
  const [bump, setBump] = useState(0);
  useEffect(() => {
    if (prev.current !== text) {
      prev.current = text;
      setBump((n) => n + 1);
    }
  }, [text]);
  return (
    <span key={bump} className={clsx(className, bump > 0 && 'sheet-bump')}>
      {text}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Guardado
// ---------------------------------------------------------------------------

export interface SaveState {
  state: 'idle' | 'saving' | 'saved' | 'error';
  at: number;
  error?: string;
}

export function SaveBadge({ save, onRetry }: { save: SaveState; onRetry?: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (save.state !== 'saved') return;
    const t = window.setInterval(() => setNow(Date.now()), 5000);
    setNow(Date.now());
    return () => window.clearInterval(t);
  }, [save.state, save.at]);
  if (save.state === 'idle') return null;
  return (
    <span
      role="status"
      aria-live="polite"
      className={clsx(
        'inline-flex items-center gap-1.5 text-micro',
        save.state === 'error' ? 'text-rose' : save.state === 'saving' ? 'text-ink-muted' : 'text-ink-faint',
      )}
    >
      {save.state === 'saving' && (
        <>
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Guardando…
        </>
      )}
      {save.state === 'saved' && (
        <>
          <Check className="h-3 w-3 text-emerald" aria-hidden /> Guardado {savedAgo(now - save.at)}
        </>
      )}
      {save.state === 'error' && (
        <>
          <AlertCircle className="h-3 w-3" aria-hidden /> {save.error ?? 'No se guardó'}
          {onRetry && (
            <button type="button" onClick={onRetry} className="font-semibold underline underline-offset-2">
              Reintentar
            </button>
          )}
        </>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Resumen de un rango
// ---------------------------------------------------------------------------

export function SummaryStrip({ stats, col, cells }: { stats: RangeStats; col: SheetCol | null; cells: number }) {
  const fmt = (n: number | null) => (n === null ? '—' : formatSheetNumber(n, col?.fmt ?? { kind: 'number' }));
  return (
    <div
      role="status"
      className="tabular flex flex-wrap items-center gap-x-4 gap-y-0.5 rounded-pill bg-primary-soft/70 px-3 py-1 font-mono text-micro text-ink"
    >
      <span className="font-sans text-ink-muted">{cells} celdas</span>
      {stats.numeric > 0 && (
        <>
          <span>
            <span className="font-sans text-ink-muted">Suma</span> {fmt(stats.sum)}
          </span>
          <span>
            <span className="font-sans text-ink-muted">Prom.</span> {fmt(stats.avg)}
          </span>
          <span>
            <span className="font-sans text-ink-muted">Cuenta</span> {stats.count}
          </span>
          <span>
            <span className="font-sans text-ink-muted">Mín</span> {fmt(stats.min)}
          </span>
          <span>
            <span className="font-sans text-ink-muted">Máx</span> {fmt(stats.max)}
          </span>
        </>
      )}
      {stats.numeric === 0 && (
        <span>
          <span className="font-sans text-ink-muted">Con valor</span> {stats.count}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Deshacer / rehacer en la barra
// ---------------------------------------------------------------------------

export function UndoRedoButtons({
  canUndo,
  canRedo,
  undoLabel,
  redoLabel,
  onUndo,
  onRedo,
}: {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel?: string;
  redoLabel?: string;
  onUndo: () => void;
  onRedo: () => void;
}) {
  const base =
    'inline-flex h-9 w-9 items-center justify-center rounded-pill border border-border text-ink-muted hover:text-ink disabled:opacity-35 disabled:hover:text-ink-muted';
  return (
    <span className="inline-flex gap-1" role="group" aria-label="Deshacer y rehacer">
      <button
        type="button"
        disabled={!canUndo}
        onClick={onUndo}
        className={base}
        aria-label={undoLabel ? `Deshacer: ${undoLabel}` : 'Deshacer'}
        title={`Deshacer${undoLabel ? `: ${undoLabel}` : ''} (Ctrl/Cmd+Z)`}
      >
        <Undo2 className="h-3.5 w-3.5" aria-hidden />
      </button>
      <button
        type="button"
        disabled={!canRedo}
        onClick={onRedo}
        className={base}
        aria-label={redoLabel ? `Rehacer: ${redoLabel}` : 'Rehacer'}
        title={`Rehacer${redoLabel ? `: ${redoLabel}` : ''} (Ctrl/Cmd+Mayús+Z)`}
      >
        <Redo2 className="h-3.5 w-3.5" aria-hidden />
      </button>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Barra de acciones en lote
// ---------------------------------------------------------------------------

export function BatchBar({
  count,
  busy,
  actions,
  canDuplicate,
  canChange,
  canMove,
  onAction,
  onDuplicate,
  onChange,
  onMove,
  onClear,
}: {
  count: number;
  busy: boolean;
  actions: SheetBlockData['actions'];
  canDuplicate: boolean;
  canChange: boolean;
  canMove: boolean;
  onAction: (a: SheetBlockData['actions'][number]) => void;
  onDuplicate: () => void;
  onChange: () => void;
  onMove: () => void;
  onClear: () => void;
}) {
  const btn =
    'inline-flex h-8 items-center gap-1.5 rounded-pill border border-border bg-surface px-3 text-xs font-semibold text-ink hover:bg-surface-2 disabled:opacity-50';
  return (
    <div
      role="toolbar"
      aria-label="Acciones sobre las filas elegidas"
      className="view-no-print mt-2 flex flex-wrap items-center gap-2 rounded-sm border border-primary/30 bg-primary-soft/60 px-3 py-2"
    >
      <span className="tabular font-mono text-xs font-semibold text-ink">
        {count} {count === 1 ? 'fila elegida' : 'filas elegidas'}
      </span>
      {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-ink-muted" aria-hidden />}
      <span className="ml-auto flex flex-wrap items-center gap-1.5">
        {actions.map((a) => (
          <button key={a.id} type="button" disabled={busy} onClick={() => onAction(a)} className={btn}>
            {a.label}
          </button>
        ))}
        {canChange && (
          <button type="button" disabled={busy} onClick={onChange} className={btn}>
            Cambiar un campo…
          </button>
        )}
        {canMove && (
          <button type="button" disabled={busy} onClick={onMove} className={btn}>
            <MoveRight className="h-3.5 w-3.5" aria-hidden /> Mover de grupo…
          </button>
        )}
        {canDuplicate && (
          <button type="button" disabled={busy} onClick={onDuplicate} className={btn} title="Ctrl/Cmd+D">
            <Copy className="h-3.5 w-3.5" aria-hidden /> Duplicar
          </button>
        )}
        <button type="button" onClick={onClear} className="inline-flex h-8 items-center gap-1 px-2 text-xs font-semibold text-ink-muted hover:text-ink">
          <X className="h-3.5 w-3.5" aria-hidden /> Quitar selección
        </button>
      </span>
    </div>
  );
}

/** Cambiar un campo (o mover de grupo) para todas las filas elegidas. */
export function BatchFieldDialog({
  fields,
  initialKey,
  count,
  blockId,
  target,
  title,
  onClose,
  onApply,
}: {
  fields: PasteField[];
  initialKey?: string;
  count: number;
  blockId: string;
  target?: SubmitTarget;
  title: string;
  onClose: () => void;
  onApply: (key: string, value: string) => Promise<string | null>;
}) {
  const [key, setKey] = useState(initialKey ?? fields[0]?.key ?? '');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = fields.find((f) => f.key === key);
  const input =
    'mt-1 h-10 w-full rounded-sm border border-border bg-surface px-2 text-sm font-normal normal-case tracking-normal text-ink';
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[64] bg-ink/40" />
        <Dialog.Content className="fixed inset-x-0 bottom-0 z-[65] max-h-[85vh] overflow-auto rounded-t-card border-t border-border bg-surface p-4 pb-6 shadow-card sm:inset-auto sm:left-1/2 sm:top-1/2 sm:w-[28rem] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-card sm:border">
          <Dialog.Title className="mb-1 text-sm font-semibold text-ink">{title}</Dialog.Title>
          <Dialog.Description className="mb-3 text-xs text-ink-muted">
            Se aplica a {count} {count === 1 ? 'fila' : 'filas'}. Se puede deshacer con Ctrl/Cmd+Z.
          </Dialog.Description>
          <label className="block text-micro font-semibold uppercase tracking-field text-ink-faint">
            Campo
            <select
              value={key}
              onChange={(e) => {
                setKey(e.target.value);
                setValue('');
                setError(null);
              }}
              className={input}
            >
              {fields.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          {field && (
            <div className="mt-3 block text-micro font-semibold uppercase tracking-field text-ink-faint">
              <span>Nuevo valor</span>
              {field.type === 'relation' && target ? (
                <RelationField
                  target={target}
                  blockId={blockId}
                  field={field.key}
                  label={field.label}
                  value={value}
                  onChange={setValue}
                />
              ) : field.type === 'select' || field.type === 'checkbox' ? (
                <select value={value} onChange={(e) => setValue(e.target.value)} className={input}>
                  <option value="">—</option>
                  {(field.type === 'checkbox' ? ['1', '0'] : field.options).map((o) => (
                    <option key={o} value={o}>
                      {field.type === 'checkbox' ? (o === '1' ? 'Sí' : 'No') : o}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type={field.type === 'date' ? 'date' : 'text'}
                  inputMode={field.type === 'number' || field.type === 'money' ? 'decimal' : undefined}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  className={input}
                />
              )}
            </div>
          )}
          {error && <p className="mt-3 text-xs text-rose">{error}</p>}
          <div className="mt-4 flex gap-2">
            <button type="button" onClick={onClose} className="h-11 flex-1 rounded-pill border border-border text-sm font-semibold text-ink-muted">
              Cancelar
            </button>
            <button
              type="button"
              disabled={busy || !field}
              onClick={async () => {
                if (!field) return;
                const n = normalizePasteCell(field, value);
                if (!n.ok) return setError(n.error);
                setBusy(true);
                const err = await onApply(field.key, n.value);
                setBusy(false);
                if (err) setError(err);
                else onClose();
              }}
              className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-pill bg-primary text-sm font-semibold text-white disabled:opacity-50"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} Aplicar
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
