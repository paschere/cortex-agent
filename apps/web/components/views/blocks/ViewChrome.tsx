'use client';

import type { ViewBrand } from '@/lib/branding/shape';
import type { FilterState } from '@/lib/views/filter-param';
import type { ComputedFilterBarItem, ComputedTheme, Tone } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { ChevronDown, Loader2, Search, SlidersHorizontal, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { BrandMark } from './brand';
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

/** El color para dibujar del tono que eligió la vista; el acento es la marca. */
const ACCENT_FILL: Record<Tone, string | undefined> = {
  primary: undefined,
  emerald: 'var(--emerald)',
  amber: 'var(--amber)',
  sky: 'var(--sky)',
  rose: 'var(--rose)',
};

/**
 * LA PORTADA DE UNA VISTA: logo y nombre de la empresa, título, subtítulo, el
 * estado en vivo y los controles de quien la mira.
 *
 *   - `plain`: una cabecera sobria, del ancho de la página.
 *   - `hero`: una banda grande con un resplandor del color de la marca (o del
 *     tono que eligió la vista) y, si hay, la imagen de portada `https:`.
 *
 * `showBrand` la apaga donde el logo ya está arriba (el enlace público lo
 * lleva en su barra). Al imprimir, los controles desaparecen y queda una
 * línea con la hora de los datos.
 */
export function ViewCover({
  title,
  subtitle,
  theme,
  brand,
  showBrand = true,
  status,
  actions,
  printedAt,
}: {
  title: string;
  subtitle?: string | null;
  theme: ComputedTheme | undefined;
  brand?: ViewBrand | null;
  showBrand?: boolean;
  /** «En vivo · hace 12 s», los avisos, imprimir. */
  status?: React.ReactNode;
  /** Lo de quien administra (compartir, versiones, editar). */
  actions?: React.ReactNode;
  /** «Datos al …», sólo en papel. */
  printedAt?: string | null;
}) {
  const hero = theme?.header === 'hero';
  const cover = hero && theme?.cover?.startsWith('https://') ? theme.cover : null;
  const [coverFailed, setCoverFailed] = useState(false);
  const accentFill = ACCENT_FILL[theme?.accent ?? 'primary'];
  const mark = showBrand && brand;
  const eyebrow = mark ? (
    <div className="flex min-w-0 items-center gap-3">
      <BrandMark brand={brand} size={hero ? 'md' : 'lg'} />
      {hero && <span className="truncate text-sm font-bold text-ink">{brand.name}</span>}
    </div>
  ) : null;
  const print = printedAt ? (
    <p className="view-print-only mt-2 text-micro text-ink-faint">
      Datos al {printedAt.replace(/\.$/, '')}.
    </p>
  ) : null;

  if (!hero)
    return (
      <header className="view-block mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="flex min-w-0 items-start gap-4">
          {eyebrow}
          <div className="min-w-0">
            {mark && (
              <p className="truncate text-micro font-bold uppercase tracking-field text-primary">
                {brand.name}
              </p>
            )}
            <h1
              className={clsx(
                'page-heading text-xl font-extrabold tracking-tight text-ink sm:text-display',
                mark && 'mt-1',
              )}
            >
              {title}
            </h1>
            {subtitle && (
              <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-ink-muted">{subtitle}</p>
            )}
            {print}
          </div>
        </div>
        {(status || actions) && (
          <div className="view-no-print flex flex-wrap items-center gap-2 sm:justify-end">
            {status}
            {actions}
          </div>
        )}
      </header>
    );

  return (
    <header
      className="view-block view-card relative mb-6 overflow-hidden rounded-card border border-border shadow-card"
      style={accentFill ? ({ '--view-fill': accentFill } as React.CSSProperties) : undefined}
    >
      <div aria-hidden className="view-hero-glow absolute inset-0" />
      <span aria-hidden className="view-brand-stripe absolute inset-x-0 top-0 h-1.5" />
      <div
        className={clsx(
          'relative grid',
          cover && !coverFailed && 'md:grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)]',
        )}
      >
        <div className="flex min-w-0 flex-col justify-end gap-3 p-5 pt-7 sm:p-9 sm:pt-10">
          {eyebrow}
          <h1 className="text-xl font-extrabold tracking-tight text-ink sm:text-display">
            {title}
          </h1>
          {subtitle && (
            <p className="max-w-2xl text-sm leading-relaxed text-ink-muted sm:text-base">
              {subtitle}
            </p>
          )}
          {print}
          {(status || actions) && (
            <div className="view-no-print mt-1 flex flex-wrap items-center gap-2">
              {status}
              {actions}
            </div>
          )}
        </div>
        {cover && !coverFailed && (
          <div className="relative order-first aspect-[16/7] md:order-none md:aspect-auto md:min-h-[14rem]">
            <img
              src={cover}
              alt=""
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              onError={() => setCoverFailed(true)}
              className="absolute inset-0 h-full w-full object-cover"
            />
            <span
              aria-hidden
              className="absolute inset-y-0 left-0 hidden w-24 bg-gradient-to-r from-surface/80 to-transparent md:block"
            />
          </div>
        )}
      </div>
    </header>
  );
}

/** Lo que dice si la vista está al día: un punto que late y cuándo se actualizó. */
export function LiveStatus({ failing, label }: { failing: boolean; label: string }) {
  return (
    <span
      className={clsx(
        'inline-flex h-8 items-center gap-2 rounded-pill border px-3 text-micro font-semibold',
        failing
          ? 'border-amber/30 bg-amber-soft text-amber'
          : 'border-border bg-surface text-ink-muted shadow-card',
      )}
    >
      <span
        aria-hidden
        className={clsx(
          'relative h-2 w-2 rounded-pill',
          failing ? 'bg-amber' : 'view-live-dot bg-emerald text-emerald',
        )}
      />
      {label}
    </span>
  );
}

/** El esqueleto de una vista mientras llegan los datos. */
export function ViewSkeleton({ blocks = 6 }: { blocks?: number }) {
  const widths = [
    'md:col-span-2',
    'md:col-span-2',
    'md:col-span-2',
    'md:col-span-3',
    'md:col-span-3',
    'md:col-span-6',
  ];
  return (
    <div aria-busy="true" aria-label="Cargando la vista">
      <div className="mb-6 flex items-center gap-4">
        <span className="view-skeleton h-14 w-14 rounded-sm" />
        <div className="flex-1 space-y-2">
          <span className="view-skeleton block h-3 w-28 rounded-pill" />
          <span className="view-skeleton block h-7 w-2/3 max-w-md rounded-pill" />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-6 md:gap-5">
        {Array.from({ length: blocks }, (_, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: marcadores fijos.
            key={i}
            className={clsx(
              'rounded-card border border-border bg-surface p-5 shadow-card',
              widths[i % widths.length],
            )}
          >
            <span className="view-skeleton block h-3 w-24 rounded-pill" />
            <span
              className={clsx(
                'view-skeleton mt-4 block rounded-sm',
                i < 3 ? 'h-9 w-3/4' : 'h-36 w-full',
              )}
            />
            {i < 3 && <span className="view-skeleton mt-4 block h-8 w-full rounded-sm" />}
          </div>
        ))}
      </div>
    </div>
  );
}

const CONTROL =
  'h-10 w-full rounded-pill border border-border-strong bg-surface px-4 text-sm text-ink outline-none transition-colors duration-150 placeholder:text-ink-faint focus:border-primary focus-visible:ring-2 focus-visible:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-60';

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
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  const set = (id: string, value: FilterState[string] | null) => {
    if (!onChange) return;
    const next = { ...state };
    if (value) next[id] = value;
    else delete next[id];
    onChange(next);
  };
  const count = Object.keys(state).length;
  return (
    <search
      aria-label="Filtros de la vista"
      className="view-no-print mb-5 flex flex-col gap-3 rounded-card border border-border bg-surface p-3 shadow-card sm:flex-row sm:flex-wrap sm:items-end sm:p-4"
    >
      {/* En el teléfono la barra se pliega: los filtros se abren con un toque. */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={panelId}
        className="flex h-10 items-center gap-2 rounded-pill px-2 text-sm font-bold text-ink sm:hidden"
      >
        <SlidersHorizontal className="h-4 w-4 text-primary" aria-hidden /> Filtros
        {count > 0 && (
          <span className="tabular rounded-pill bg-primary-soft px-2 py-0.5 font-mono text-micro text-primary-ink">
            {count}
          </span>
        )}
        {pending && <Loader2 className="h-3.5 w-3.5 animate-spin text-ink-faint" aria-hidden />}
        <ChevronDown
          className={clsx(
            'ml-auto h-4 w-4 text-ink-faint transition-transform duration-150',
            expanded && 'rotate-180',
          )}
          aria-hidden
        />
      </button>
      <div
        id={panelId}
        className={clsx(expanded ? 'flex' : 'hidden', 'flex-col gap-3 px-1 pb-1 sm:contents')}
      >
        <span className="hidden h-10 items-center gap-1.5 self-end pr-1 text-xs font-bold text-ink lg:inline-flex">
          <SlidersHorizontal className="h-4 w-4 text-primary" aria-hidden /> Filtros
        </span>
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
          <div className="flex min-h-10 items-center gap-2 sm:ml-auto">
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
      </div>
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
          className="pointer-events-none absolute left-3.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint"
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
          className={clsx(CONTROL, 'pl-9')}
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
      className="view-no-print mb-5 flex max-w-full gap-1 overflow-x-auto rounded-pill border border-border bg-surface-2/70 p-1 [scrollbar-width:none] sm:inline-flex [&::-webkit-scrollbar]:hidden"
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
              'relative inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-pill px-4 py-1.5 text-sm font-semibold transition-all duration-150',
              selected ? 'bg-surface text-ink shadow-card' : 'text-ink-muted hover:text-ink',
            )}
          >
            <span
              aria-hidden
              className={clsx(
                'h-1.5 w-1.5 rounded-pill transition-opacity duration-150',
                TONE_BAR[accent],
                selected ? 'opacity-100' : 'opacity-0',
              )}
            />
            {p.title}
          </button>
        );
      })}
    </div>
  );
}
