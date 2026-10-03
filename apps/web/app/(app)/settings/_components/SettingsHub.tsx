'use client';

import { Panel } from '@/components/ui/panel';
import type { HubEntry } from '@/lib/settings/hub';
import {
  SETTINGS_GROUPS,
  type SettingsGroupId,
  entryForAnchor,
  searchSettings,
} from '@/lib/settings/registry';
import { chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import { ChevronDown, ChevronRight, ExternalLink, Search, SearchX, X } from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { SettingsNav } from './SettingsNav';
import { SETTINGS_ICONS } from './settings-icons';

/**
 * EL RECIBIDOR DE AJUSTES.
 *
 * Recibe de la página ya resuelto lo que esta persona puede ver (rol y módulos
 * aplicados en el servidor) y se encarga de dos cosas: buscar y plegar. Nada de
 * lo que guarda vive aquí; cada control en línea sigue siendo el formulario de
 * siempre, que habla con su propia ruta.
 *
 * DOS MODOS:
 *   · sin búsqueda, cinco grupos con índice a la izquierda (anclas, sin
 *     JavaScript siguen funcionando);
 *   · con búsqueda, una sola lista ordenada por relevancia, y el índice pasa a
 *     decir de qué grupo salió cada resultado.
 */

const GROUP_LABEL = new Map<SettingsGroupId, string>(SETTINGS_GROUPS.map((g) => [g.id, g.label]));

export function SettingsHub({
  entries,
  inline,
  hiddenByModule,
  hiddenByRole,
  modulesHref,
  initialQuery = '',
}: {
  entries: HubEntry[];
  /** Los controles en línea, ya armados en el servidor, por clave de `inline`. */
  inline: Partial<Record<NonNullable<HubEntry['inline']>, ReactNode>>;
  hiddenByModule: number;
  hiddenByRole: number;
  modulesHref: string;
  initialQuery?: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);

  const searching = query.trim().length > 0;
  const results = useMemo(() => searchSettings(entries, query), [entries, query]);

  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const e of results) out[e.group] = (out[e.group] ?? 0) + 1;
    return out;
  }, [results]);

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Los enlaces viejos (`/settings#correo`, `#resumen`…) siguen llevando a su
  // control y lo abren si estaba plegado.
  useEffect(() => {
    function fromHash() {
      const hash = window.location.hash.replace(/^#/, '');
      if (!hash) return;
      const entry = entryForAnchor(hash);
      if (!entry) return;
      setQuery('');
      setOpen((prev) => new Set(prev).add(entry.id));
      window.setTimeout(() => {
        document.getElementById(`ajuste-${entry.id}`)?.scrollIntoView({ block: 'start' });
      }, 50);
    }
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, []);

  // «/» enfoca el buscador, como en el resto del producto.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      const typing =
        t &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.tagName === 'SELECT' ||
          t.isContentEditable);
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const groups = SETTINGS_GROUPS.map((g) => ({
    ...g,
    entries: entries.filter((e) => e.group === g.id),
  })).filter((g) => g.entries.length > 0);

  const navSections = groups.map((g) => ({ id: `grupo-${g.id}`, label: g.label }));
  const navCounts = searching
    ? Object.fromEntries(groups.map((g) => [`grupo-${g.id}`, counts[g.id] ?? 0]))
    : undefined;

  const rowProps = (entry: HubEntry, showGroup: boolean) => ({
    entry,
    showGroup,
    isOpen: open.has(entry.id) || (searching && Boolean(entry.inline) && results.length <= 2),
    onToggle: () => toggle(entry.id),
    body: entry.inline ? inline[entry.inline] : null,
  });

  return (
    <div className="space-y-6">
      {/* ---- El buscador ---------------------------------------------------- */}
      <search className="relative block">
        <label htmlFor="buscar-ajuste" className="sr-only">
          Busca un ajuste
        </label>
        <Search
          className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint"
          aria-hidden
        />
        <input
          id="buscar-ajuste"
          ref={inputRef}
          type="search"
          value={query}
          autoComplete="off"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQuery('');
          }}
          placeholder="Busca un ajuste: tema, plan, WhatsApp, voz, personas…"
          className="w-full rounded-pill border border-border bg-surface py-3 pl-11 pr-11 text-sm text-ink shadow-card placeholder:text-ink-faint focus:border-primary/40 focus:outline-none focus:ring-4 focus:ring-primary/10 [&::-webkit-search-cancel-button]:hidden"
        />
        {query ? (
          <button
            type="button"
            onClick={() => {
              setQuery('');
              inputRef.current?.focus();
            }}
            aria-label="Borrar la búsqueda"
            className="absolute right-2.5 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-pill text-ink-faint hover:bg-surface-2 hover:text-ink"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        ) : (
          <kbd className="pointer-events-none absolute right-4 top-1/2 hidden -translate-y-1/2 rounded-sm border border-border px-1.5 text-micro font-semibold text-ink-faint sm:block">
            /
          </kbd>
        )}
      </search>

      <div className="grid gap-6 lg:grid-cols-[210px_minmax(0,1fr)] lg:gap-8">
        <SettingsNav sections={navSections} counts={navCounts} />

        <div className="min-w-0 space-y-10">
          {searching ? (
            <section aria-label="Resultados de la búsqueda" className="space-y-3">
              <output className="block text-sm text-ink-muted" aria-live="polite">
                {results.length === 0
                  ? null
                  : results.length === 1
                    ? '1 ajuste'
                    : `${results.length} ajustes`}
              </output>
              {results.length === 0 ? (
                <Panel className="px-6 py-10 text-center">
                  <SearchX className="mx-auto h-6 w-6 text-ink-faint" aria-hidden />
                  <p className="mt-3 text-sm font-semibold text-ink">
                    No hay ajustes que se llamen así
                  </p>
                  <p className="mx-auto mt-1 max-w-md text-sm text-ink-muted">
                    Prueba con otra palabra (por ejemplo «plan», «voz» o «correo»), o pregúntale a
                    Cortex en el chat: él sabe dónde está cada cosa.
                  </p>
                  <button
                    type="button"
                    onClick={() => setQuery('')}
                    className="mt-4 text-sm font-semibold text-primary hover:underline"
                  >
                    Ver todos los ajustes
                  </button>
                </Panel>
              ) : (
                <Panel>
                  <ul className="divide-y divide-border">
                    {results.map((entry) => (
                      <EntryRow key={entry.id} {...rowProps(entry, true)} />
                    ))}
                  </ul>
                </Panel>
              )}
            </section>
          ) : (
            groups.map((g) => (
              <section key={g.id} id={`grupo-${g.id}`} className="scroll-mt-6">
                <div className="mb-3 px-1">
                  <h2 className="text-base font-bold text-ink">{g.label}</h2>
                  <p className="mt-0.5 text-sm text-ink-muted">{g.blurb}</p>
                </div>
                <Panel>
                  <ul className="divide-y divide-border">
                    {g.entries.map((entry) => (
                      <EntryRow key={entry.id} {...rowProps(entry, false)} />
                    ))}
                  </ul>
                </Panel>
              </section>
            ))
          )}

          {/* ---- Lo que no se ve, dicho ------------------------------------- */}
          {(hiddenByModule > 0 || hiddenByRole > 0) && (
            <footer className="space-y-1 px-1 text-sm text-ink-muted">
              {hiddenByModule > 0 && (
                <p>
                  {hiddenByModule === 1
                    ? '1 ajuste oculto porque su módulo está apagado.'
                    : `${hiddenByModule} ajustes ocultos porque su módulo está apagado.`}{' '}
                  <Link href={modulesHref} className="font-semibold text-primary hover:underline">
                    Ver módulos
                  </Link>
                </p>
              )}
              {hiddenByRole > 0 && (
                <p className="text-ink-faint">
                  Los ajustes de administración de la empresa los ve quien administra el espacio.
                </p>
              )}
            </footer>
          )}
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// Una fila
// ===========================================================================

function EntryRow({
  entry,
  showGroup,
  isOpen,
  onToggle,
  body,
}: {
  entry: HubEntry;
  showGroup: boolean;
  isOpen: boolean;
  onToggle: () => void;
  body: ReactNode;
}) {
  const Icon = SETTINGS_ICONS[entry.icon];
  const foldable = Boolean(entry.inline && entry.collapsed);
  const showBody = Boolean(entry.inline) && (!entry.collapsed || isOpen);
  const bodyId = `cuerpo-${entry.id}`;

  const head = (
    <>
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-card bg-primary-soft text-primary">
        <Icon className="h-[18px] w-[18px]" />
      </span>
      <span className="min-w-0 flex-1">
        {showGroup && (
          <span className="mb-0.5 block text-micro font-semibold uppercase tracking-wide text-ink-faint">
            {GROUP_LABEL.get(entry.group)}
          </span>
        )}
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="text-sm font-semibold text-ink">{entry.title}</span>
          {entry.soon && <span className={chipClass('neutral')}>Próximamente</span>}
          {entry.state && (
            <span className={`${chipClass(entry.state.tone)} max-w-full`}>{entry.state.text}</span>
          )}
        </span>
        <span className="mt-1 block text-sm leading-relaxed text-ink-muted">
          {entry.description}
        </span>
      </span>
    </>
  );

  const rowBase = 'flex w-full items-start gap-4 px-5 py-4 text-left sm:px-6 sm:py-5';

  return (
    <li id={`ajuste-${entry.id}`} className="relative scroll-mt-6">
      {entry.legacyAnchor && (
        <span id={entry.legacyAnchor} aria-hidden className="absolute -top-6 h-px w-px" />
      )}

      {foldable ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={isOpen}
          aria-controls={bodyId}
          className={clsx(rowBase, 'transition-colors hover:bg-surface-2')}
        >
          {head}
          <span className="mt-2 inline-flex shrink-0 items-center gap-1 text-sm font-semibold text-primary">
            <span className="hidden sm:inline">{isOpen ? 'Cerrar' : 'Ajustar'}</span>
            <ChevronDown
              className={clsx('h-4 w-4 transition-transform', isOpen && 'rotate-180')}
              aria-hidden
            />
          </span>
        </button>
      ) : entry.href ? (
        <Link
          href={entry.href}
          {...(entry.external ? { target: '_blank', rel: 'noreferrer' } : {})}
          className={clsx(rowBase, 'transition-colors hover:bg-surface-2')}
        >
          {head}
          <span className="mt-2 inline-flex shrink-0 items-center gap-1 text-sm font-semibold text-primary">
            <span className="hidden sm:inline">Abrir</span>
            {entry.external ? (
              <ExternalLink className="h-4 w-4" aria-hidden />
            ) : (
              <ChevronRight className="h-4 w-4" aria-hidden />
            )}
          </span>
        </Link>
      ) : (
        <div className={clsx(rowBase, entry.soon && 'opacity-80')}>{head}</div>
      )}

      {showBody && body && (
        <div id={bodyId} className="border-t border-border bg-canvas/60 px-5 py-5 sm:px-6 sm:py-6">
          {body}
        </div>
      )}
    </li>
  );
}
