'use client';

import { Panel, PanelHead } from '@/components/ui/panel';
import { clsx } from 'clsx';
import { AlertTriangle, Building2, Loader2, Lock, Plus, Search, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { countBySource, focusStats } from '../_lib/view';
import { searchKnowledge } from '../actions';
import { BrainPanel, GrowthPanel } from './BrainPlate';
import { DigestionPanel, KnowsPanel, useDigest } from './Digestion';
import { IntakeChooser } from './Intake';
import { RelationsPanel, SOURCE_LABEL } from './RelationsGraph';
import { SpaceDetail } from './SpaceDetail';
import { SpaceDialog } from './SpaceDialog';
import { ago, hours, num, plural } from './format';
import type { BrainStats, IntakeKey, SearchResult, SpaceSummary } from './types';

/**
 * Brain Knowledge, read top to bottom as the thing it is: something that eats,
 * digests, and then remembers.
 *
 *   1. the belt — what went in, what is being worked on, what came out;
 *   2. what it knows, in counted figures;
 *   3. the four mouths;
 *   4. proof that the memory works — the same search Cortex runs;
 *   5. where the memory is kept.
 *
 * The old page opened with a search box over a grid of folders, which described
 * a file manager. This describes an organism with a digestive tract, because
 * that is what the product actually is.
 */
export function KnowledgeBase({
  spaces,
  stats: serverStats,
  isAdmin,
  viewerName,
}: {
  spaces: SpaceSummary[];
  stats: BrainStats;
  isAdmin: boolean;
  viewerName: string;
}) {
  const stats = useDigest(serverStats);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [intake, setIntake] = useState<IntakeKey>('upload');
  // Which lobe of the plate is pressed. Null is "todo".
  const [openRegion, setOpenRegion] = useState<IntakeKey | null>(null);
  const [creating, setCreating] = useState<'personal' | 'global' | null>(null);
  // A document opened from the ring: which space to walk into, and what to
  // point at once we are there.
  const [focusDoc, setFocusDoc] = useState<string | null>(null);

  const search = useKnowledgeSearch();
  const found = search.found;

  // Everything under the plate reads the focused view; the plate itself keeps
  // the whole reading, because it is the control and has to draw all four.
  const view = useMemo(() => focusStats(stats, openRegion), [stats, openRegion]);
  const focusLabel = openRegion ? { label: SOURCE_LABEL[openRegion] } : null;

  const company = useMemo(() => spaces.filter((s) => s.kind === 'global'), [spaces]);
  const mine = useMemo(() => spaces.filter((s) => s.kind === 'personal'), [spaces]);

  const openDocument = useCallback((spaceId: string, documentId: string) => {
    setFocusDoc(documentId);
    setSelectedId(spaceId);
  }, []);

  const selected = spaces.find((s) => s.id === selectedId) ?? null;

  if (selected) {
    return (
      <>
        <SpaceDetail
          space={selected}
          allSpaces={spaces}
          intake={intake}
          onIntakeChange={setIntake}
          onBack={() => {
            setSelectedId(null);
            setFocusDoc(null);
          }}
          viewerName={viewerName}
          focusDocumentId={focusDoc}
          found={found}
        />
        {creating && (
          <SpaceDialog kind={creating} onClose={() => setCreating(null)} viewerName={viewerName} />
        )}
      </>
    );
  }

  if (spaces.length === 0) {
    return (
      <>
        <FirstRun isAdmin={isAdmin} onCreate={() => setCreating('personal')} />
        {creating && (
          <SpaceDialog kind={creating} onClose={() => setCreating(null)} viewerName={viewerName} />
        )}
      </>
    );
  }

  // With a lobe pressed, a space with nothing from that source has nothing to
  // say about it and is left out rather than shown as an empty card.
  const inFocus = (list: SpaceSummary[]) =>
    openRegion ? list.filter((s) => s.intake[openRegion] > 0) : list;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <BrainPanel
          stats={stats}
          openRegion={openRegion}
          onOpenRegion={(key) => setOpenRegion((current) => (current === key ? null : key))}
          hits={search.query.trim() ? countBySource(search.results ?? []) : null}
          searching={search.running}
        />
        <KnowsPanel stats={view} focus={focusLabel} />
      </div>

      {/* The search sits between the two instruments it drives: type here and
          the lobe above and the ring below say where the answer lives, before
          anything is opened. */}
      <AskPanel spaces={spaces} search={search} onOpenDocument={openDocument} />

      <RelationsPanel
        {...(openRegion ? { source: openRegion } : {})}
        onOpenDocument={(target) => {
          if (target.spaceId) openDocument(target.spaceId, target.documentId);
        }}
        found={found}
        query={search.query}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <DigestionPanel stats={view} focus={focusLabel} />
        <GrowthPanel stats={view} focus={openRegion} />
      </div>

      <IntakeChooser
        spaces={spaces}
        totals={stats.intake}
        highlight={openRegion}
        onFeed={(spaceId, key) => {
          setIntake(key);
          setSelectedId(spaceId);
        }}
        onCreateSpace={() => setCreating('personal')}
      />

      <SpaceGroup
        title="Memoria de la empresa"
        blurb="La lee todo el mundo. Solo un administrador puede añadir."
        icon={Building2}
        spaces={inFocus(company)}
        focus={openRegion}
        onOpen={setSelectedId}
        action={
          isAdmin
            ? { label: 'Nuevo espacio común', onClick: () => setCreating('global') }
            : undefined
        }
        emptyText={
          openRegion
            ? `Ningún espacio común tiene ${SOURCE_LABEL[openRegion].toLowerCase()} todavía.`
            : 'Todavía no hay nada común. Lo que pongas aquí se lo responde Cortex a cualquiera.'
        }
      />

      <SpaceGroup
        title="Tu memoria"
        blurb="Solo tú la lees. La búsqueda de nadie más llega hasta aquí."
        icon={Lock}
        spaces={inFocus(mine)}
        focus={openRegion}
        onOpen={setSelectedId}
        action={{ label: 'Nuevo espacio propio', onClick: () => setCreating('personal') }}
        emptyText={
          openRegion
            ? `No tienes ${SOURCE_LABEL[openRegion].toLowerCase()} en tus espacios.`
            : 'Para tus notas de trabajo: las mañas de un cliente, un borrador que quieres que recuerde.'
        }
      />

      {creating && (
        <SpaceDialog kind={creating} onClose={() => setCreating(null)} viewerName={viewerName} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- search */

/** Long enough that a word is finished, short enough to feel like typing. */
const TYPING_PAUSE = 300;
/** One letter matches everything and means nothing. */
const MIN_QUERY = 2;

interface KnowledgeSearch {
  query: string;
  setQuery: (q: string) => void;
  scope: string;
  setScope: (id: string) => void;
  results: SearchResult[] | null;
  running: boolean;
  error: string | null;
  /** The documents the current results point at, for the plate and the ring. */
  found: Set<string>;
  clear: () => void;
}

/**
 * Search as you type, without the two ways that usually goes wrong.
 *
 * FIRST: it waits. A keystroke is not a question, so nothing is sent until the
 * typing stops — otherwise "tarifa" is six embeddings and six retrievals to
 * answer one.
 *
 * SECOND: only the newest answer is allowed to land. A server action cannot be
 * aborted from here, so instead every request carries a ticket and a reply
 * whose ticket is no longer the current one is dropped on arrival. Without
 * that, a slow "tar" comes back after a fast "tarifa" and quietly overwrites
 * it — the results on screen would be answering a question nobody asked any
 * more.
 *
 * And the screen never goes blank while it thinks: the previous results stay,
 * dimmed, because a blank panel reads as "nothing found".
 */
function useKnowledgeSearch(spaceId?: string): KnowledgeSearch {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState('');
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ticket = useRef(0);

  const where = spaceId ?? scope;

  useEffect(() => {
    const text = query.trim();
    if (text.length < MIN_QUERY) {
      // Abandoning the query abandons its answer too, in flight or not.
      ticket.current += 1;
      setResults(null);
      setError(null);
      setRunning(false);
      return;
    }

    ticket.current += 1;
    const mine = ticket.current;
    setRunning(true);
    const timer = setTimeout(async () => {
      const res = await searchKnowledge(text, where || undefined);
      // Somebody has typed since. This answer is about an older question.
      if (ticket.current !== mine) return;
      setRunning(false);
      if (res.ok) {
        setResults(res.results);
        setError(null);
      } else {
        setError(res.error);
      }
    }, TYPING_PAUSE);

    return () => clearTimeout(timer);
  }, [query, where]);

  const found = useMemo(() => new Set((results ?? []).map((r) => r.documentId)), [results]);

  const clear = useCallback(() => {
    ticket.current += 1;
    setQuery('');
    setResults(null);
    setError(null);
    setRunning(false);
  }, []);

  return { query, setQuery, scope, setScope, results, running, error, found, clear };
}

function AskPanel({
  spaces,
  search,
  onOpenDocument,
}: {
  spaces: SpaceSummary[];
  search: KnowledgeSearch;
  onOpenDocument: (spaceId: string, documentId: string) => void;
}) {
  const { query, setQuery, scope, setScope, results, running, error, clear } = search;
  const scopeName = spaces.find((s) => s.id === scope)?.name;
  const typing = query.trim().length > 0 && query.trim().length < MIN_QUERY;

  return (
    <Panel>
      <PanelHead
        title="Buscar dentro del cerebro"
        right={
          running ? (
            <span className="inline-flex items-center gap-1.5 text-ink-faint">
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              buscando
            </span>
          ) : (
            'la misma búsqueda que hace Cortex'
          )
        }
      />
      <p className="px-5 pt-1 text-[12.5px] text-ink-muted">
        Mientras escribes te marco arriba en qué fuente está y abajo en qué documentos. Si no sale
        aquí, Cortex tampoco lo sabe.
      </p>

      <div className="flex flex-wrap gap-2 px-5 pb-4 pt-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Tarifa de bodegaje, cómo se liquida una importación…"
            aria-label="Buscar en la memoria"
            className="h-9 w-full rounded-card border border-border bg-surface-2 pl-9 pr-9 text-[13px] text-ink placeholder:text-ink-faint focus:border-primary/40 focus:bg-surface"
          />
          {query && (
            <button
              type="button"
              onClick={clear}
              aria-label="Limpiar la búsqueda"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-card p-1 text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {spaces.length > 1 && (
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            aria-label="Dónde buscar"
            className="h-9 rounded-card border border-border bg-surface px-3 text-[12.5px] font-medium text-ink focus:border-border-strong"
          >
            <option value="">En todo lo que ves</option>
            {spaces.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {error && (
        <p className="mx-5 mb-4 rounded-card border border-rose/30 bg-rose-soft px-3 py-2 text-[12px] text-rose">
          {error}
        </p>
      )}

      {typing && !results && (
        <p className="px-5 pb-4 text-[12px] text-ink-faint">Escribe un poco más.</p>
      )}

      {results !== null && (
        // Dimmed rather than emptied while a newer answer is on its way: what
        // is on screen is still true, it is only about the previous keystroke.
        <div
          className={clsx(
            'border-t border-border transition-opacity duration-200',
            running && 'opacity-50',
          )}
          aria-busy={running}
        >
          {results.length === 0 ? (
            <p className="px-5 py-4 text-[12.5px] leading-relaxed text-ink-muted">
              No hay nada sobre eso{scopeName ? ` en ${scopeName}` : ''} todavía. Súbelo y en un
              minuto lo puede citar.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {results.map((r) => (
                <li key={`${r.documentId}-${r.chunkIndex}`}>
                  <button
                    type="button"
                    onClick={() => onOpenDocument(r.spaceId, r.documentId)}
                    className="block w-full px-5 py-3 text-left transition-colors hover:bg-surface-2"
                  >
                    <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                      <span className="min-w-0 truncate text-[12.5px] font-semibold text-ink">
                        {r.documentTitle}
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <SpaceChip kind={r.spaceKind} label={r.space} />
                        <span className="tabular text-[10.5px] text-ink-faint">
                          frag. {r.chunkIndex + 1}
                        </span>
                      </span>
                    </div>
                    <p className="line-clamp-3 text-[12.5px] leading-relaxed text-ink-muted">
                      {r.content}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------------- cards */

export function SpaceChip({ kind, label }: { kind: 'global' | 'personal'; label?: string }) {
  const Icon = kind === 'global' ? Building2 : Lock;
  return (
    <span
      className={clsx(
        'inline-flex shrink-0 items-center gap-1 rounded-card px-2 py-0.5 text-[10.5px] font-bold',
        kind === 'global' ? 'bg-primary-soft text-primary' : 'bg-surface-2 text-ink-muted',
      )}
    >
      <Icon className="h-3 w-3" />
      {label ?? (kind === 'global' ? 'Común' : 'Propio')}
    </span>
  );
}

function SpaceGroup({
  title,
  blurb,
  icon: Icon,
  spaces,
  focus,
  onOpen,
  action,
  emptyText,
}: {
  title: string;
  blurb: string;
  icon: typeof Building2;
  spaces: SpaceSummary[];
  /** The lobe in force, if any: the cards then count only that source. */
  focus?: IntakeKey | null;
  onOpen: (id: string) => void;
  action?: { label: string; onClick: () => void };
  emptyText: string;
}) {
  return (
    <section>
      <div className="mb-2.5 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-1.5 text-[14px] font-bold text-ink">
            <Icon className="h-4 w-4 text-ink-faint" />
            {title}
          </h2>
          <p className="mt-0.5 max-w-2xl text-[12px] text-ink-faint">{blurb}</p>
        </div>
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            className="inline-flex items-center gap-1.5 rounded-card border border-border px-3 py-1.5 text-[12px] font-semibold text-ink-muted transition-colors hover:border-border-strong hover:text-ink"
          >
            <Plus className="h-3.5 w-3.5" />
            {action.label}
          </button>
        )}
      </div>

      {spaces.length === 0 ? (
        <Panel className="px-5 py-5 text-[12.5px] text-ink-faint">{emptyText}</Panel>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {spaces.map((s) => (
            <SpaceCard key={s.id} space={s} focus={focus ?? null} onOpen={() => onOpen(s.id)} />
          ))}
        </div>
      )}
    </section>
  );
}

function SpaceCard({
  space,
  focus,
  onOpen,
}: { space: SpaceSummary; focus: IntakeKey | null; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="group block w-full text-left">
      <Panel className="flex h-full flex-col gap-2.5 p-4 transition-colors group-hover:border-border-strong group-hover:bg-surface-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-[13.5px] font-bold text-ink">{space.name}</div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <SpaceChip kind={space.kind} />
              {space.ownerName && (
                <span className="truncate text-[11px] text-ink-faint">
                  {space.isMine ? 'Tuyo' : space.ownerName}
                </span>
              )}
            </div>
          </div>
          {/* The fragment count is what the space is worth to an answer; the
              document count is only how it was filed. Under a lobe it is the
              documents of that source, because fragments cannot be split by
              source honestly. */}
          <div className="shrink-0 text-right">
            <div className="stat-num text-[22px] leading-none text-ink">
              {num(focus ? space.intake[focus] : (space.chunkCount ?? space.documentCount))}
            </div>
            <div className="field-label mt-1">
              {focus
                ? SOURCE_LABEL[focus].toLowerCase()
                : space.chunkCount !== null
                  ? 'fragmentos'
                  : 'documentos'}
            </div>
          </div>
        </div>

        {space.description && (
          <p className="line-clamp-2 text-[12px] leading-relaxed text-ink-muted">
            {space.description}
          </p>
        )}

        <div className="mt-auto flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-t border-border pt-2.5 text-[11.5px] text-ink-faint">
          <span>
            {plural(space.documentCount, 'documento', 'documentos')}
            {space.spokenSeconds > 0 && ` · ${hours(space.spokenSeconds)} escuchadas`}
            {space.lastAddedAt && ` · ${ago(space.lastAddedAt)}`}
          </span>
          {space.failedCount > 0 ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-rose">
              <AlertTriangle className="h-3 w-3" />
              <span className="tabular">{num(space.failedCount)}</span> atascados
            </span>
          ) : space.pendingCount > 0 ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-amber">
              <Loader2 className="h-3 w-3 animate-spin" />
              indexando <span className="tabular">{num(space.pendingCount)}</span>
            </span>
          ) : null}
        </div>
      </Panel>
    </button>
  );
}

/* -------------------------------------------------------------- empty state */

function FirstRun({ isAdmin, onCreate }: { isAdmin: boolean; onCreate: () => void }) {
  return (
    <Panel className="px-6 py-10 text-center">
      <p className="text-[15px] font-bold text-ink">Este cerebro está vacío</p>
      <p className="mx-auto mt-1.5 max-w-lg text-[13px] leading-relaxed text-ink-muted">
        Aquí Cortex guarda lo que la empresa sabe: una tarifa, un instructivo, lo que se dijo en una
        llamada. Dale el primer documento y podrá citarlo cuando alguien pregunte.
      </p>
      <div className="mt-4 flex justify-center">
        <button
          type="button"
          onClick={onCreate}
          className="inline-flex items-center gap-1.5 rounded-card bg-primary px-4 py-2 text-[12.5px] font-semibold text-white transition-colors hover:bg-primary-strong"
        >
          <Plus className="h-3.5 w-3.5" />
          Crear el primer espacio
        </button>
      </div>
      <p className="mx-auto mt-3 max-w-lg text-[11.5px] text-ink-faint">
        {isAdmin
          ? 'Un espacio propio es solo tuyo. Uno común lo lee toda la empresa.'
          : 'Un espacio propio es solo tuyo. Para uno común, pídeselo a un administrador.'}
      </p>
    </Panel>
  );
}
