'use client';

import type { FilterState } from '@/lib/views/filter-param';
import type { ComputedFilterBarItem, ComputedTheme, Tone } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { Loader2, Search, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { TONE_BAR } from './theme';

/**
 * LO QUE RODEA A LOS BLOQUES: la cabecera grande, la barra de filtros y las
 * pestañas de las páginas.
 *
 * La barra no filtra aquí: avisa qué se eligió (`onChange`) y quien la monta
 * (LiveViewCanvas) pide al servidor la vista recalculada con `?f=`. Sin
 * `onChange` —la vista previa del lienzo, Inicio— se pinta apagada: se ve
 * cómo va a quedar, pero no promete un filtro que no puede aplicar.
 *
 * Las pestañas son un `tablist` de verdad: flechas, Inicio y Fin las recorren
 * y la elegida queda en la dirección (`?p=`) para poder compartirla.
 */

const ACCENT_BAND: Record<Tone, string> = {
  primary: 'from-primary-soft',
  emerald: 'from-emerald-soft',
  amber: 'from-amber-soft',
  sky: 'from-sky-soft',
  rose: 'from-rose-soft',
};

export function ViewHero({
  title,
  subtitle,
  theme,
}: {
  title: string;
  subtitle?: string | null;
  theme: ComputedTheme;
}) {
  const cover = theme.cover?.startsWith('https://') ? theme.cover : null;
  const [coverFailed, setCoverFailed] = useState(false);
  return (
    <header
      className={clsx(
        'mb-5 overflow-hidden rounded-card border border-border bg-gradient-to-br to-surface shadow-card',
        ACCENT_BAND[theme.accent],
      )}
    >
      <div
        className={clsx(
          'grid gap-0',
          cover && !coverFailed && 'md:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)]',
        )}
      >
        <div className="flex flex-col justify-end gap-2 p-5 sm:p-8">
          <span className={clsx('h-1 w-10 rounded-pill', TONE_BAR[theme.accent])} aria-hidden />
          <h1 className="text-xl font-bold tracking-tight text-ink sm:text-display">{title}</h1>
          {subtitle && (
            <p className="max-w-2xl text-sm leading-relaxed text-ink-muted sm:text-base">
              {subtitle}
            </p>
          )}
        </div>
        {cover && !coverFailed && (
          <div className="relative order-first aspect-[16/7] md:order-none md:aspect-auto md:min-h-[12rem]">
            <img
              src={cover}
              alt=""
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              onError={() => setCoverFailed(true)}
              className="absolute inset-0 h-full w-full object-cover"
            />
          </div>
        )}
      </div>
    </header>
  );
}

const CONTROL =
  'w-full rounded-sm border border-border-strong bg-surface px-3 py-1.5 text-sm text-ink outline-none transition-colors duration-150 placeholder:text-ink-faint focus:border-primary focus-visible:ring-2 focus-visible:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-60';

export function FilterBar({
  items,
  state,
  onChange,
  pending,
}: {
  items: ComputedFilterBarItem[];
  state: FilterState;
  /** Sin él, la barra se pinta apagada (vista previa). */
  onChange?: (next: FilterState) => void;
  pending?: boolean;
}) {
  const disabled = !onChange;
  const active = Object.keys(state).length > 0;
  const set = (id: string, value: FilterState[string] | null) => {
    if (!onChange) return;
    const next = { ...state };
    if (value) next[id] = value;
    else delete next[id];
    onChange(next);
  };
  return (
    <search
      aria-label="Filtros de la vista"
      className="mb-4 flex flex-col gap-3 rounded-card border border-border bg-surface p-3 shadow-card sm:flex-row sm:flex-wrap sm:items-end sm:p-4"
    >
      {items.map((item) => {
        const value = state[item.id];
        if (item.kind === 'select')
          return (
            <Labeled key={item.id} label={item.label} className="sm:w-48">
              <select
                disabled={disabled}
                value={value?.kind === 'select' ? value.value : ''}
                onChange={(e) =>
                  set(item.id, e.target.value ? { kind: 'select', value: e.target.value } : null)
                }
                className={CONTROL}
              >
                <option value="">Todas</option>
                {value?.kind === 'select' &&
                  !item.options.some((o) => o.toLowerCase() === value.value.toLowerCase()) && (
                    <option value={value.value}>{value.value}</option>
                  )}
                {item.options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </Labeled>
          );
        if (item.kind === 'date_range') {
          const range = value?.kind === 'date_range' ? value : { from: null, to: null };
          const put = (from: string | null, to: string | null) =>
            set(item.id, from || to ? { kind: 'date_range', from, to } : null);
          return (
            <fieldset key={item.id} className="min-w-0 sm:w-auto">
              <legend className="field-label mb-1">{item.label}</legend>
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="date"
                  aria-label={`${item.label}: desde`}
                  disabled={disabled}
                  value={range.from ?? ''}
                  max={range.to ?? undefined}
                  onChange={(e) => put(e.target.value || null, range.to)}
                  className={CONTROL}
                />
                <input
                  type="date"
                  aria-label={`${item.label}: hasta`}
                  disabled={disabled}
                  value={range.to ?? ''}
                  min={range.from ?? undefined}
                  onChange={(e) => put(range.from, e.target.value || null)}
                  className={CONTROL}
                />
              </div>
            </fieldset>
          );
        }
        return (
          <SearchControl
            key={item.id}
            label={item.label}
            disabled={disabled}
            value={value?.kind === 'search' ? value.value : ''}
            onCommit={(q) => set(item.id, q ? { kind: 'search', value: q } : null)}
          />
        );
      })}
      {(pending || (active && !disabled) || disabled) && (
        <div className="flex min-h-[2.125rem] items-center gap-2 sm:ml-auto">
          {pending && (
            <output className="inline-flex items-center gap-1 text-micro text-ink-faint">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Filtrando…
            </output>
          )}
          {active && !disabled && (
            <button
              type="button"
              onClick={() => onChange?.({})}
              className="inline-flex items-center gap-1 rounded-pill px-2.5 py-1 text-xs font-semibold text-primary transition-colors hover:bg-primary-soft"
            >
              <X className="h-3.5 w-3.5" aria-hidden /> Quitar filtros
            </button>
          )}
          {disabled && (
            <span className="text-micro text-ink-faint">
              Los filtros funcionan en la vista guardada.
            </span>
          )}
        </div>
      )}
    </search>
  );
}

function Labeled({
  label,
  className,
  children,
}: { label: string; className?: string; children: React.ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: el control llega como hijo.
    <label className={clsx('block min-w-0', className)}>
      <span className="field-label mb-1 block">{label}</span>
      {children}
    </label>
  );
}

/** Busca al escribir, sin pedir una vista por tecla: espera a que la persona pare. */
function SearchControl({
  label,
  value,
  disabled,
  onCommit,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onCommit: (q: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const timer = useRef<number | null>(null);
  const id = useId();
  useEffect(() => setDraft(value), [value]);
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );
  const schedule = (q: string) => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => onCommit(q.trim()), 450);
  };
  return (
    <div className="min-w-0 sm:w-56">
      <label htmlFor={id} className="field-label mb-1 block">
        {label}
      </label>
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint"
          aria-hidden
        />
        <input
          id={id}
          type="search"
          disabled={disabled}
          value={draft}
          maxLength={80}
          placeholder="Buscar…"
          onChange={(e) => {
            setDraft(e.target.value);
            schedule(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              if (timer.current) window.clearTimeout(timer.current);
              onCommit(draft.trim());
            }
          }}
          className={clsx(CONTROL, 'pl-8')}
        />
      </div>
    </div>
  );
}

export function PageTabs({
  pages,
  current,
  onSelect,
  accent,
  idBase,
}: {
  pages: Array<{ id: string; title: string }>;
  current: string;
  onSelect: (id: string) => void;
  accent: Tone;
  /** Prefijo de ids para atar cada pestaña con su panel. */
  idBase: string;
}) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const move = (to: number) => {
    const page = pages[(to + pages.length) % pages.length];
    if (!page) return;
    onSelect(page.id);
    refs.current.get(page.id)?.focus();
  };
  const at = pages.findIndex((p) => p.id === current);
  return (
    <div
      role="tablist"
      aria-label="Páginas de la vista"
      className="-mx-1 mb-4 flex gap-1 overflow-x-auto border-b border-border px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {pages.map((p) => {
        const selected = p.id === current;
        return (
          <button
            key={p.id}
            ref={(el) => {
              if (el) refs.current.set(p.id, el);
              else refs.current.delete(p.id);
            }}
            type="button"
            role="tab"
            id={`${idBase}-tab-${p.id}`}
            aria-selected={selected}
            aria-controls={`${idBase}-panel`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(p.id)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight') move(at + 1);
              else if (e.key === 'ArrowLeft') move(at - 1);
              else if (e.key === 'Home') move(0);
              else if (e.key === 'End') move(pages.length - 1);
              else return;
              e.preventDefault();
            }}
            className={clsx(
              'relative shrink-0 whitespace-nowrap rounded-t-sm px-2.5 py-2 text-sm sm:px-3 font-semibold transition-colors duration-150',
              selected ? 'text-ink' : 'text-ink-muted hover:text-ink',
            )}
          >
            {p.title}
            <span
              aria-hidden
              className={clsx(
                'absolute inset-x-2 -bottom-px h-0.5 rounded-pill transition-opacity duration-150',
                TONE_BAR[accent],
                selected ? 'opacity-100' : 'opacity-0',
              )}
            />
          </button>
        );
      })}
    </div>
  );
}
