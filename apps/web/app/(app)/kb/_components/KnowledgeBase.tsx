'use client';

import { Panel, PanelHead } from '@/components/ui/panel';
import { clsx } from 'clsx';
import { AlertTriangle, Building2, Loader2, Lock, Plus, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { searchKnowledge } from '../actions';
import { DigestionPanel, KnowsPanel, useDigest } from './Digestion';
import { IntakeChooser } from './Intake';
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
  const [creating, setCreating] = useState<'personal' | 'global' | null>(null);

  const company = useMemo(() => spaces.filter((s) => s.kind === 'global'), [spaces]);
  const mine = useMemo(() => spaces.filter((s) => s.kind === 'personal'), [spaces]);

  const selected = spaces.find((s) => s.id === selectedId) ?? null;

  if (selected) {
    return (
      <>
        <SpaceDetail
          space={selected}
          allSpaces={spaces}
          intake={intake}
          onIntakeChange={setIntake}
          onBack={() => setSelectedId(null)}
          viewerName={viewerName}
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

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <DigestionPanel stats={stats} />
        <KnowsPanel stats={stats} />
      </div>

      <IntakeChooser
        spaces={spaces}
        totals={stats.intake}
        onFeed={(spaceId, key) => {
          setIntake(key);
          setSelectedId(spaceId);
        }}
        onCreateSpace={() => setCreating('personal')}
      />

      <AskPanel spaces={spaces} onOpenSpace={setSelectedId} />

      <SpaceGroup
        title="Memoria de la empresa"
        blurb="La lee todo el mundo. Solo un administrador puede añadir."
        icon={Building2}
        spaces={company}
        onOpen={setSelectedId}
        action={
          isAdmin
            ? { label: 'Nuevo espacio común', onClick: () => setCreating('global') }
            : undefined
        }
        emptyText="Todavía no hay nada común. Lo que pongas aquí se lo responde Cortex a cualquiera."
      />

      <SpaceGroup
        title="Tu memoria"
        blurb="Solo tú la lees. La búsqueda de nadie más llega hasta aquí."
        icon={Lock}
        spaces={mine}
        onOpen={setSelectedId}
        action={{ label: 'Nuevo espacio propio', onClick: () => setCreating('personal') }}
        emptyText="Para tus notas de trabajo: las mañas de un cliente, un borrador que quieres que recuerde."
      />

      {creating && (
        <SpaceDialog kind={creating} onClose={() => setCreating(null)} viewerName={viewerName} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- search */

function AskPanel({
  spaces,
  onOpenSpace,
}: {
  spaces: SpaceSummary[];
  onOpenSpace: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState('');
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!query.trim()) return;
    setRunning(true);
    setError(null);
    const res = await searchKnowledge(query, scope || undefined);
    setRunning(false);
    if (res.ok) {
      setResults(res.results);
    } else {
      setResults(null);
      setError(res.error);
    }
  }

  const scopeName = spaces.find((s) => s.id === scope)?.name;

  return (
    <Panel>
      <PanelHead title="Pruébale la memoria" right="la misma búsqueda que hace Cortex" />
      <p className="px-5 pt-1 text-[12.5px] text-ink-muted">
        Si no sale aquí, Cortex tampoco lo sabe.
      </p>

      <div className="flex flex-wrap gap-2 px-5 pb-4 pt-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && run()}
            placeholder="Tarifa de bodegaje, cómo se liquida una importación…"
            className="h-9 w-full rounded-card border border-border bg-surface-2 pl-9 pr-3 text-[13px] text-ink placeholder:text-ink-faint focus:border-primary/40 focus:bg-surface"
          />
        </div>

        {spaces.length > 1 && (
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value)}
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

        <button
          type="button"
          onClick={run}
          disabled={running || !query.trim()}
          className="inline-flex h-9 items-center gap-1.5 rounded-card bg-primary px-4 text-[12.5px] font-semibold text-white transition-colors hover:bg-primary-strong disabled:opacity-40"
        >
          {running && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Buscar
        </button>
      </div>

      {error && (
        <p className="mx-5 mb-4 rounded-card border border-rose/30 bg-rose-soft px-3 py-2 text-[12px] text-rose">
          {error}
        </p>
      )}

      {results !== null && !error && (
        <div className="border-t border-border">
          {results.length === 0 ? (
            <p className="px-5 py-4 text-[12.5px] leading-relaxed text-ink-muted">
              No hay nada sobre eso{scopeName ? ` en ${scopeName}` : ''} todavía. Súbelo y en un
              minuto lo puede citar.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {results.map((r) => (
                <li key={`${r.documentId}-${r.chunkIndex}`} className="px-5 py-3">
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
                </li>
              ))}
            </ul>
          )}

          {results.length > 0 && (
            <div className="border-t border-border px-5 py-2.5">
              <button
                type="button"
                onClick={() => {
                  const first = spaces.find((s) => s.name === results[0]?.space);
                  if (first) onOpenSpace(first.id);
                }}
                className="rounded-card px-2 py-1 text-[11.5px] font-semibold text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
              >
                Abrir {results[0]?.space}
              </button>
            </div>
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
  onOpen,
  action,
  emptyText,
}: {
  title: string;
  blurb: string;
  icon: typeof Building2;
  spaces: SpaceSummary[];
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
            <SpaceCard key={s.id} space={s} onOpen={() => onOpen(s.id)} />
          ))}
        </div>
      )}
    </section>
  );
}

function SpaceCard({ space, onOpen }: { space: SpaceSummary; onOpen: () => void }) {
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
              document count is only how it was filed. */}
          <div className="shrink-0 text-right">
            <div className="stat-num text-[22px] leading-none text-ink">
              {num(space.chunkCount ?? space.documentCount)}
            </div>
            <div className="field-label mt-1">
              {space.chunkCount !== null ? 'fragmentos' : 'documentos'}
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
              digiriendo <span className="tabular">{num(space.pendingCount)}</span>
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
