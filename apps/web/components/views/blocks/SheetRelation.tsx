'use client';

import { clsx } from 'clsx';
import { Check, Loader2, Plus, WifiOff, X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SubmitTarget } from '../ViewCanvas';
import { type RelationOption, parseRelation, rememberChosen, useRelationSource } from './RelationPicker';

const fold = (t: string) =>
  t
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/**
 * ELEGIR UNA FILA DE OTRA TABLA DENTRO DE UNA CELDA DE LA HOJA.
 *
 * Un combobox compacto con búsqueda (sin tildes ni mayúsculas) que reutiliza las
 * opciones de relación de las vistas y de las pantallas de aplicación
 * (`useRelationSource`): el servidor decide qué tabla es y qué filas ve el rol.
 * Flechas para moverse, Enter elige, Esc cancela. En una celda la lista flota
 * fija bajo la celda (no la recorta el desplazamiento de la hoja); en la hoja
 * de edición del teléfono y en «Nueva fila» va en línea.
 *
 * «+ Crear «texto»»: si lo escrito no existe y el rol puede agregar filas en la
 * tabla destino, se crea ahí mismo (con el mismo camino de «+ Agregar» de los
 * formularios: idempotente, sin duplicar por nombre ni NIT) y queda elegida.
 */

export const relationValue = (o: { id: string; label: string }) =>
  JSON.stringify({ id: o.id, label: o.label });

export function relationLabel(value: string | number | null | undefined): string {
  return parseRelation(value === null || value === undefined ? '' : String(value))?.label ?? '';
}

interface Props {
  target: SubmitTarget;
  blockId: string;
  field: string;
  label: string;
  /** El valor actual (`{"id","label"}`), para marcarlo en la lista. */
  current?: string;
  required?: boolean;
  initialQuery?: string;
  /** `null` = vaciar la relación. */
  onPick: (option: RelationOption | null) => void;
  onCancel: () => void;
  /** En línea (hoja de edición, fila nueva) en vez de flotante bajo la celda. */
  inline?: boolean;
}

export function RelationCombo({
  target,
  blockId,
  field,
  label,
  current,
  required,
  initialQuery = '',
  onPick,
  onCancel,
  inline,
}: Props) {
  const source = useRelationSource(target, blockId, field);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState(initialQuery);
  const [options, setOptions] = useState<RelationOption[]>([]);
  const [state, setState] = useState<'loading' | 'idle' | 'error'>('loading');
  const [offline, setOffline] = useState(false);
  const [active, setActive] = useState(0);
  const [box, setBox] = useState<{ left: number; top: number; width: number; max: number; up: boolean } | null>(null);
  const searchRef = useRef(source.search);
  searchRef.current = source.search;
  const currentId = parseRelation(current ?? '')?.id ?? null;
  const canClear = !required && Boolean(currentId);
  // El índice 0 es «Vaciar» cuando se puede y no se está buscando.
  const clearRow = canClear && !q.trim();
  const rows: Array<RelationOption | null> = clearRow ? [null, ...options] : options;
  const typed = q.replace(/\s+/g, ' ').trim();
  const showCreate =
    source.canCreate &&
    !offline &&
    state === 'idle' &&
    typed.length >= 2 &&
    !options.some((o) => fold(o.label) === fold(typed));
  const createIndex = showCreate ? rows.length : -1;
  const total = rows.length + (showCreate ? 1 : 0);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const creatingRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    if (initialQuery) inputRef.current?.setSelectionRange(initialQuery.length, initialQuery.length);
  }, [initialQuery]);

  // Busca al abrir y al escribir (con una pausa corta); una respuesta vieja se descarta.
  useEffect(() => {
    const ctl = new AbortController();
    setState('loading');
    const t = window.setTimeout(
      async () => {
        try {
          const res = await searchRef.current(q, ctl.signal);
          if (ctl.signal.aborted) return;
          setOptions(res.options);
          setOffline(res.offline);
          setActive(0);
          setState('idle');
        } catch (err) {
          if ((err as { name?: string }).name === 'AbortError') return;
          setState('error');
        }
      },
      q ? 150 : 0,
    );
    return () => {
      window.clearTimeout(t);
      ctl.abort();
    };
  }, [q]);

  // Posición de la lista flotante: bajo la celda, o encima si abajo no cabe.
  useLayoutEffect(() => {
    if (inline) return;
    const place = () => {
      const r = inputRef.current?.getBoundingClientRect();
      if (!r) return;
      const below = window.innerHeight - r.bottom - 8;
      const up = below < 160 && r.top > below;
      const max = Math.max(120, Math.min(280, up ? r.top - 8 : below));
      const width = Math.max(r.width, 256);
      setBox({
        left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)),
        top: up ? r.top : r.bottom,
        width,
        max,
        up,
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [inline]);

  // Mantiene la opción activa a la vista.
  useEffect(() => {
    document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, listId]);

  const create = async () => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    setCreateError(null);
    try {
      const made = await source.create(typed);
      rememberChosen(made);
      onPick(made);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'No se pudo agregar ahora.');
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  const choose = (i: number) => {
    if (i === createIndex) return void create();
    if (i < 0 || i >= rows.length) return;
    const o = rows[i] ?? null;
    if (o) rememberChosen(o);
    onPick(o);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(total - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      choose(active);
    } else if (e.key === 'Tab') {
      // Con algo escrito, Tab elige lo marcado; si no, sólo sale.
      if (q.trim() && (rows[active] || active === createIndex)) {
        e.preventDefault();
        choose(active);
      } else onCancel();
    }
  };

  const list = (
    <ul
      id={listId}
      role="listbox"
      aria-label={`Opciones de ${label}`}
      // La lista no le quita el foco al buscador al tocarla.
      onMouseDown={(e) => e.preventDefault()}
      className={clsx(
        'scroll-slim overflow-auto rounded-sm border border-border bg-surface py-1 text-xs shadow-pop',
        inline ? 'mt-2 max-h-52' : 'fixed z-[66]',
      )}
      style={
        inline
          ? undefined
          : box
            ? {
                left: box.left,
                width: box.width,
                maxHeight: box.max,
                ...(box.up ? { bottom: window.innerHeight - box.top } : { top: box.top }),
              }
            : { visibility: 'hidden' }
      }
    >
      {state === 'loading' && rows.length === 0 && (
        <li className="flex items-center gap-2 px-3 py-2 text-ink-faint">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Buscando…
        </li>
      )}
      {state === 'error' && <li className="px-3 py-2 text-rose">No se pudo buscar. Inténtalo otra vez.</li>}
      {state === 'idle' && rows.length === 0 && !showCreate && (
        <li className="px-3 py-2 text-ink-faint">{q.trim() ? `Nada con «${q.trim()}».` : 'No hay filas para elegir.'}</li>
      )}
      {offline && (
        <li className="flex items-center gap-1.5 px-3 py-1 text-micro text-amber">
          <WifiOff className="h-3 w-3" aria-hidden /> Sin señal: lista guardada
        </li>
      )}
      {rows.map((o, i) => (
        <li
          key={o?.id ?? '__clear'}
          id={`${listId}-${i}`}
          role="option"
          aria-selected={o ? o.id === currentId : false}
          onMouseEnter={() => setActive(i)}
          onClick={() => choose(i)}
          className={clsx(
            'flex cursor-pointer items-center gap-2 px-3 py-1.5',
            i === active ? 'bg-primary-soft text-ink' : 'text-ink-muted',
          )}
        >
          {o ? (
            <>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold text-ink">{o.label}</span>
                {o.detail && <span className="block truncate text-micro text-ink-faint">{o.detail}</span>}
              </span>
              {o.id === currentId && <Check className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />}
            </>
          ) : (
            <span className="flex items-center gap-1.5 text-ink-faint">
              <X className="h-3.5 w-3.5" aria-hidden /> Vaciar
            </span>
          )}
        </li>
      ))}
      {showCreate && (
        <li
          id={`${listId}-${createIndex}`}
          role="option"
          aria-selected={false}
          onMouseEnter={() => setActive(createIndex)}
          onClick={() => void create()}
          className={clsx(
            'flex cursor-pointer items-center gap-2 border-t border-border/60 px-3 py-1.5 font-semibold text-primary',
            active === createIndex ? 'bg-primary-soft' : '',
          )}
        >
          {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Plus className="h-3.5 w-3.5" aria-hidden />}
          <span className="min-w-0 flex-1 truncate">Crear «{typed}»</span>
        </li>
      )}
      {createError && <li className="px-3 py-1.5 text-micro text-rose">{createError}</li>}
    </ul>
  );

  return (
    <>
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={total ? `${listId}-${active}` : undefined}
        aria-label={`Elegir ${label}`}
        value={q}
        placeholder={inline ? `Buscar ${label.toLowerCase()}` : parseRelation(current ?? '')?.label || 'Buscar…'}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => onCancel()}
        autoComplete="off"
        className={
          inline
            ? 'h-11 w-full rounded-sm border border-border bg-surface px-3 text-base text-ink outline-none focus-visible:ring-2 focus-visible:ring-primary/30'
            : 'h-full w-full rounded-none border-0 bg-surface px-2 text-xs text-ink outline-none ring-2 ring-inset ring-primary placeholder:text-ink-muted'
        }
      />
      {inline ? list : typeof document !== 'undefined' ? createPortal(list, document.body) : null}
    </>
  );
}

/** Campo de relación en una hoja de edición o formulario: muestra lo elegido y abre la búsqueda en línea. */
export function RelationField({
  target,
  blockId,
  field,
  label,
  value,
  required,
  onChange,
}: {
  target: SubmitTarget;
  blockId: string;
  field: string;
  label: string;
  /** `{"id","label"}` o vacío. */
  value: string;
  required?: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const chosen = parseRelation(value);
  return (
    <div>
      {open ? (
        <RelationCombo
          inline
          target={target}
          blockId={blockId}
          field={field}
          label={label}
          current={value}
          required={required}
          onPick={(o) => {
            onChange(o ? relationValue(o) : '');
            setOpen(false);
            queueMicrotask(() => btn.current?.focus());
          }}
          onCancel={() => setOpen(false)}
        />
      ) : (
        <button
          ref={btn}
          type="button"
          onClick={() => setOpen(true)}
          aria-haspopup="listbox"
          aria-label={`${label}: ${chosen?.label ?? 'sin elegir'}. Cambiar`}
          className="mt-1 flex h-11 w-full items-center justify-between rounded-sm border border-border bg-surface px-3 text-left text-sm font-normal normal-case tracking-normal text-ink hover:bg-surface-2 sm:h-10"
        >
          <span className={clsx('truncate', !chosen && 'text-ink-faint')}>{chosen?.label ?? 'Elegir…'}</span>
          <span className="text-micro text-ink-faint">Buscar</span>
        </button>
      )}
    </div>
  );
}
