'use client';

import type { GridColumn, GridOption } from '@/components/datagrid/types';
import {
  asBoolean,
  asList,
  editorText,
  foldText,
  formatValue,
  hrefFor,
  initials,
  isEmptyValue,
  isNumericType,
  optionFor,
  parseInput,
  personName,
} from '@/lib/datagrid/format';
import { DOT_TONE, chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import { Check, Minus } from 'lucide-react';
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Popover, inputClass } from './primitives';

/**
 * Cómo se ve una celda y cómo se edita, por tipo. La misma pieza sirve en la
 * tabla, en las tarjetas, en el tablero y en el detalle de una fila.
 */

// ---------------------------------------------------------------------------
// Ver
// ---------------------------------------------------------------------------

export function OptionChip({ option, value }: { option?: GridOption; value: string }) {
  const tone = option?.tone ?? 'neutral';
  return (
    <span className={clsx(chipClass(tone), 'max-w-full')}>
      <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', DOT_TONE[tone])} aria-hidden />
      <span className="truncate">{option?.label ?? option?.value ?? value}</span>
    </span>
  );
}

export function PersonChip({ name }: { name: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span
        aria-hidden
        className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-primary-soft text-micro font-bold leading-none text-primary-ink"
      >
        {initials(name)}
      </span>
      <span className="truncate">{name}</span>
    </span>
  );
}

export function CellValue({
  column,
  value,
  compact,
}: {
  column: GridColumn;
  value: unknown;
  /** En la tabla: una línea, sin envolver. */
  compact?: boolean;
}): ReactNode {
  if (isEmptyValue(value)) return <span className="text-ink-faint" aria-label="Vacío" />;
  switch (column.type) {
    case 'select':
    case 'status':
      return <OptionChip option={optionFor(column, value)} value={String(value)} />;
    case 'multi_select': {
      const list = asList(value);
      const shown = compact ? list.slice(0, 2) : list;
      return (
        <span className={clsx('flex min-w-0 gap-1', compact ? 'flex-nowrap' : 'flex-wrap')}>
          {shown.map((v) => (
            <OptionChip key={v} option={optionFor(column, v)} value={v} />
          ))}
          {list.length > shown.length ? (
            <span className="tabular self-center text-micro text-ink-faint">
              +{list.length - shown.length}
            </span>
          ) : null}
        </span>
      );
    }
    case 'boolean': {
      const b = asBoolean(value);
      return b ? (
        <span className="inline-flex items-center gap-1 text-emerald">
          <Check className="h-4 w-4" aria-hidden />
          <span className="sr-only">Sí</span>
        </span>
      ) : (
        <span className="inline-flex items-center text-ink-faint">
          <Minus className="h-4 w-4" aria-hidden />
          <span className="sr-only">No</span>
        </span>
      );
    }
    case 'person':
      return <PersonChip name={personName(value)} />;
    case 'link':
    case 'email':
    case 'phone': {
      const href = hrefFor(column, value);
      const text =
        column.type === 'link'
          ? String(value)
              .replace(/^https?:\/\/(www\.)?/, '')
              .replace(/\/$/, '')
          : String(value);
      if (!href) return <span className="truncate">{String(value)}</span>;
      return (
        <a
          href={href}
          {...(column.type === 'link' ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
          onClick={(e) => e.stopPropagation()}
          className={clsx(
            'truncate text-primary underline-offset-2 hover:underline',
            column.type === 'phone' && 'tabular',
          )}
        >
          {text}
        </a>
      );
    }
    default: {
      const text = formatValue(column, value);
      const numeric =
        isNumericType(column.type) || column.type === 'date' || column.type === 'datetime';
      return (
        <span
          className={clsx(
            compact ? 'block truncate' : 'whitespace-pre-wrap break-words',
            numeric && 'tabular',
          )}
          title={compact && text.length > 24 ? text : undefined}
        >
          {text}
        </span>
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Lista de opciones (una o varias), con teclado
// ---------------------------------------------------------------------------

export function OptionList({
  column,
  value,
  multi,
  onChange,
  onDone,
  onCancel,
}: {
  column: GridColumn;
  value: string[];
  multi: boolean;
  onChange: (next: string[]) => void;
  onDone: (next: string[]) => void;
  onCancel: () => void;
}) {
  const options = column.options ?? [];
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const shown = useMemo(() => {
    const q = foldText(query);
    return q ? options.filter((o) => foldText(o.label ?? o.value).includes(q)) : options;
  }, [options, query]);
  const showSearch = options.length > 7;

  const pick = (v: string) => {
    if (multi) {
      const next = value.includes(v) ? value.filter((x) => x !== v) : [...value, v];
      onChange(next);
    } else onDone([v]);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, shown.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const o = shown[active];
      if (multi) {
        if (e.metaKey || e.ctrlKey || !o) onDone(value);
        else pick(o.value);
      } else if (o) pick(o.value);
    } else if (e.key === ' ' && multi && !showSearch) {
      e.preventDefault();
      const o = shown[active];
      if (o) pick(o.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      onDone(value);
    }
  };

  return (
    <div onKeyDown={onKey}>
      {showSearch ? (
        <input
          data-autofocus=""
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          placeholder="Buscar opción…"
          aria-controls={listId}
          className={clsx(inputClass, 'mb-2')}
        />
      ) : null}
      {/* biome-ignore lint/a11y/useSemanticElements: lista de opciones con chips de color y búsqueda; un <select> no pinta chips ni filtra. */}
      <div
        role="listbox"
        id={listId}
        aria-multiselectable={multi || undefined}
        aria-label={column.label}
        tabIndex={showSearch ? -1 : 0}
        data-autofocus={showSearch ? undefined : ''}
        aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
        className="flex max-h-64 flex-col gap-0.5 overflow-y-auto focus:outline-none"
      >
        {shown.map((o, i) => {
          const selected = value.includes(o.value);
          return (
            // biome-ignore lint/a11y/useSemanticElements: lista de opciones con chips de color y búsqueda; un <select> no pinta chips ni filtra.
            <div
              role="option"
              key={o.value}
              id={`${listId}-${i}`}
              aria-selected={selected}
              tabIndex={-1}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(o.value)}
              onKeyDown={() => {}}
              className={clsx(
                'flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5',
                i === active && 'bg-surface-2',
              )}
            >
              {multi ? (
                <span
                  aria-hidden
                  className={clsx(
                    'grid h-4 w-4 shrink-0 place-items-center rounded-[5px] border',
                    selected ? 'border-primary bg-primary text-white' : 'border-border-strong',
                  )}
                >
                  {selected ? <Check className="h-3 w-3" /> : null}
                </span>
              ) : null}
              <OptionChip option={o} value={o.value} />
              {!multi && selected ? (
                <Check className="ml-auto h-3.5 w-3.5 text-primary" aria-hidden />
              ) : null}
            </div>
          );
        })}
        {!shown.length ? (
          <p className="px-2 py-2 text-micro text-ink-faint">Ninguna opción coincide.</p>
        ) : null}
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 border-t border-border pt-2">
        {!column.required && value.length ? (
          <button
            type="button"
            onClick={() => onDone([])}
            className="text-micro font-semibold text-ink-muted hover:text-ink"
          >
            Dejar vacío
          </button>
        ) : (
          <span />
        )}
        {multi ? (
          <button
            type="button"
            onClick={() => onDone(value)}
            className="rounded-pill bg-primary px-3 py-1 text-micro font-bold text-white"
          >
            Listo
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editar en la celda
// ---------------------------------------------------------------------------

function inputType(column: GridColumn): string {
  switch (column.type) {
    case 'date':
      return 'date';
    case 'datetime':
      return 'datetime-local';
    case 'email':
      return 'email';
    case 'phone':
      return 'tel';
    case 'link':
      return 'url';
    default:
      return 'text';
  }
}

/**
 * El editor de una celda. Enter guarda, Esc cancela, Tab guarda y sigue.
 * `seed` es la tecla que abrió el editor (escribir sobre una celda la reemplaza).
 */
export function CellEditor({
  column,
  value,
  seed,
  people,
  anchor,
  onCommit,
  onCancel,
}: {
  column: GridColumn;
  value: unknown;
  seed?: string;
  people?: string[];
  anchor: HTMLElement | null;
  onCommit: (value: unknown, move?: 'next' | 'prev' | 'down') => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(() => (seed !== undefined ? seed : editorText(column, value)));
  const [error, setError] = useState<string | null>(null);
  const [list, setList] = useState<string[]>(() =>
    column.type === 'multi_select' ? asList(value) : isEmptyValue(value) ? [] : [String(value)],
  );
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const anchorRef = useRef<HTMLElement | null>(anchor);
  anchorRef.current = anchor;
  const peopleId = useId();

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    if (seed === undefined && 'select' in el && el.type === 'text') el.select();
  }, [seed]);

  if (column.type === 'select' || column.type === 'status' || column.type === 'multi_select') {
    const multi = column.type === 'multi_select';
    return (
      <Popover
        open
        onClose={() => (multi ? onCommit(list) : onCancel())}
        anchorRef={anchorRef}
        width={260}
        label={`Elegir ${column.label}`}
      >
        <OptionList
          column={column}
          value={list}
          multi={multi}
          onChange={setList}
          onDone={(next) => onCommit(multi ? next : (next[0] ?? null))}
          onCancel={onCancel}
        />
      </Popover>
    );
  }

  const commit = (move?: 'next' | 'prev' | 'down') => {
    const parsed = parseInput(column, text);
    if (!parsed.ok) {
      setError(parsed.error);
      inputRef.current?.focus();
      return;
    }
    onCommit(parsed.value, move);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    } else if (e.key === 'Enter' && (column.type !== 'long_text' || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      commit('down');
    } else if (e.key === 'Tab') {
      e.preventDefault();
      commit(e.shiftKey ? 'prev' : 'next');
    }
  };

  const numeric = column.type === 'number' || column.type === 'money' || column.type === 'percent';
  return (
    <div className="absolute inset-0 z-20">
      {column.type === 'long_text' ? (
        <textarea
          ref={inputRef as React.RefObject<HTMLTextAreaElement>}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onKeyDown={onKey}
          onBlur={() => commit()}
          aria-label={column.label}
          aria-invalid={Boolean(error)}
          rows={5}
          className="absolute left-0 top-0 w-[max(100%,320px)] resize-y rounded-sm border-2 border-primary bg-surface p-2 text-xs text-ink shadow-pop focus:outline-none"
        />
      ) : (
        <input
          ref={inputRef as React.RefObject<HTMLInputElement>}
          type={inputType(column)}
          inputMode={numeric ? 'decimal' : undefined}
          value={text}
          list={column.type === 'person' && people?.length ? peopleId : undefined}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onKeyDown={onKey}
          onBlur={() => commit()}
          aria-label={column.label}
          aria-invalid={Boolean(error)}
          className={clsx(
            'h-full w-full min-w-0 rounded-[6px] border-2 border-primary bg-surface px-2 text-xs text-ink focus:outline-none',
            numeric && 'tabular text-right',
          )}
        />
      )}
      {column.type === 'person' && people?.length ? (
        <datalist id={peopleId}>
          {people.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="absolute left-0 top-full z-30 mt-1 w-max max-w-[280px] rounded-sm border border-rose/30 bg-rose-soft px-2 py-1 text-micro font-semibold text-rose shadow-pop"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Campo de formulario (nueva fila, editar en bloque, detalle)
// ---------------------------------------------------------------------------

/** El valor «crudo» de un formulario: texto, una opción, varias o sí/no. */
export type RawValue = string | string[] | boolean;

export function rawFromValue(column: GridColumn, value: unknown): RawValue {
  if (column.type === 'multi_select') return asList(value);
  if (column.type === 'boolean') return asBoolean(value) ?? false;
  if (column.type === 'select' || column.type === 'status')
    return isEmptyValue(value) ? '' : String(value);
  return editorText(column, value);
}

export function FieldInput({
  id,
  column,
  raw,
  onChange,
  error,
  people,
}: {
  id: string;
  column: GridColumn;
  raw: RawValue;
  onChange: (raw: RawValue) => void;
  error?: string | null;
  people?: string[];
}) {
  const peopleId = `${id}-people`;
  const t = column.type;
  if (t === 'boolean') {
    const on = raw === true;
    return (
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={on}
        onClick={() => onChange(!on)}
        className={clsx(
          'relative inline-flex h-6 w-11 items-center rounded-pill transition-colors',
          on ? 'bg-primary' : 'bg-border-strong',
        )}
      >
        <span
          className={clsx(
            'inline-block h-5 w-5 rounded-full bg-white shadow transition-transform',
            on ? 'translate-x-5' : 'translate-x-0.5',
          )}
        />
        <span className="sr-only">{on ? 'Sí' : 'No'}</span>
      </button>
    );
  }
  if (t === 'select' || t === 'status' || t === 'multi_select') {
    const multi = t === 'multi_select';
    const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
    const options = column.options ?? [];
    if (!options.length)
      return (
        <input
          id={id}
          value={Array.isArray(raw) ? raw.join(', ') : String(raw)}
          onChange={(e) =>
            onChange(multi ? e.target.value.split(',').map((s) => s.trim()) : e.target.value)
          }
          className={inputClass}
        />
      );
    return (
      <div
        id={id}
        role={multi ? 'group' : 'radiogroup'}
        aria-label={column.label}
        aria-invalid={Boolean(error)}
        className="flex flex-wrap gap-1.5"
      >
        {options.map((o) => {
          const selected = list.includes(o.value);
          return (
            <button
              key={o.value}
              type="button"
              role={multi ? 'checkbox' : 'radio'}
              aria-checked={selected}
              onClick={() =>
                onChange(
                  multi
                    ? selected
                      ? list.filter((x) => x !== o.value)
                      : [...list, o.value]
                    : selected && !column.required
                      ? ''
                      : o.value,
                )
              }
              className={clsx(
                'rounded-pill p-0.5 transition-shadow',
                selected ? 'ring-2 ring-primary' : 'opacity-70 hover:opacity-100',
              )}
            >
              <OptionChip option={o} value={o.value} />
            </button>
          );
        })}
      </div>
    );
  }
  const numeric = t === 'number' || t === 'money' || t === 'percent';
  if (t === 'long_text')
    return (
      <textarea
        id={id}
        value={String(raw)}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        aria-invalid={Boolean(error)}
        className={clsx(inputClass, 'h-auto py-2')}
      />
    );
  return (
    <>
      <input
        id={id}
        type={inputType(column)}
        inputMode={numeric ? 'decimal' : undefined}
        value={String(raw)}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={Boolean(error)}
        list={t === 'person' && people?.length ? peopleId : undefined}
        placeholder={t === 'money' ? '$ 0' : t === 'percent' ? '0 %' : undefined}
        className={clsx(inputClass, numeric && 'tabular')}
      />
      {t === 'person' && people?.length ? (
        <datalist id={peopleId}>
          {people.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
      ) : null}
    </>
  );
}
