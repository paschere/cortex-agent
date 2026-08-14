'use client';

import { Panel } from '@/components/ui/panel';
import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Building2, ChevronRight, Loader2, Lock, Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { focusStats } from '../_lib/view';
import { DigestionPanel, KnowsPanel, useDigest } from './Digestion';
import { GrowthPanel } from './GrowthPanel';
import { type IndexItem, IndexList } from './Index';
import { IntakeChooser } from './Intake';
import { SOURCE_LABEL } from './RelationsGraph';
import { SpaceDialog } from './SpaceDialog';
import { SpaceTools } from './SpaceTools';
import { Analysis } from './analysis/Analysis';
import { MemoryBench } from './bench/MemoryBench';
import { BrainField, type FieldFlare } from './field/BrainField';
import { type FieldSeed, LOBE_NAME } from './field/field-math';
import { num, plural } from './format';
import { FragmentReader } from './reader/FragmentReader';
import type {
  BrainStats,
  FragmentHealth,
  IntakeKey,
  KnowledgeShape,
  ProbeResult,
  SpaceSummary,
  StaleDocument,
} from './types';

/**
 * Brain Knowledge.
 *
 * THE SHAPE OF THE SCREEN, AND WHY. The old page was a stack of panels with a
 * drawing of a brain at the top: the drawing was an illustration and the lists
 * underneath were the product. This inverts that. The cortex is now the map you
 * navigate — spaces are hills, you walk into one and its documents become the
 * hills, you walk into a document and the map flattens into that document's own
 * ribbon of fragments. Three depths, one object, and it is drawn from the
 * corpus rather than from constants: elevation is fragments, position is what
 * the material is made of.
 *
 * AND IT IS NEVER THE ONLY DOOR. Beside the map, at every depth, is the same
 * set of things as a list you can filter by typing and walk with the arrow
 * keys. Not a fallback — a peer, wired to the same state, so pointing at a row
 * lights the hill and the other way round. A screen whose navigation lives
 * inside a picture is unusable to anybody on a keyboard and slower than a
 * filing cabinet for anybody who already knows the name of what they want.
 *
 * THE FIRST THING ON SCREEN IS THE BENCH. Not the map. The most useful thing
 * here is being able to type a real question and see exactly which fragments
 * Cortex would retrieve, in what order, with what score, without spending an
 * answer — so it sits open by default in the right-hand column, beside the map,
 * and running it lights the map where the answer lives. That is the whole
 * product in one view: ask it something, watch which part of the memory
 * responds, go and read the actual fragment.
 */

type Tab = 'ask' | 'index';

export function KnowledgeBase({
  spaces,
  stats: serverStats,
  health,
  shape,
  stale,
  isAdmin,
  viewerName,
}: {
  spaces: SpaceSummary[];
  stats: BrainStats;
  health: FragmentHealth | null;
  shape: KnowledgeShape | null;
  stale: StaleDocument[];
  isAdmin: boolean;
  viewerName: string;
}) {
  const stats = useDigest(serverStats);

  // Where we are. Three depths, expressed as two ids rather than a tagged
  // union, because every transition between them is "set one, clear the other"
  // and a union would need a reducer to say the same thing.
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);

  const [tab, setTab] = useState<Tab>('ask');
  const [hovered, setHovered] = useState<string | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [source, setSource] = useState<IntakeKey | null>(null);
  const [creating, setCreating] = useState<'personal' | 'global' | null>(null);
  const [intake, setIntake] = useState<IntakeKey>('upload');

  const space = spaces.find((s) => s.id === spaceId) ?? null;
  const depth: 'cortex' | 'space' | 'document' = documentId
    ? 'document'
    : spaceId
      ? 'space'
      : 'cortex';

  /* ------------------------------------------------------------- the level */

  // One level down the map stops being spaces and becomes the documents inside
  // one. Both readings come from things the page already has: the space cards
  // carry their own fragment counts and intake mix, and the relations graph
  // carries per-document fragment counts and the ties between them.
  const graph = useQuery({
    queryKey: ['kb-graph', spaceId ?? 'all', 'all'],
    queryFn: async () => {
      const r = await fetch(`/api/kb/graph?spaceId=${spaceId}`);
      if (!r.ok) throw new Error('No se pudieron leer las relaciones.');
      return (await r.json()) as {
        nodes: Array<{ id: string; title: string; source: IntakeKey; chunks: number }>;
        semantic: Array<{ a: string; b: string; score: number }>;
        considered: number;
        total: number;
      };
    },
    enabled: depth === 'space',
  });

  const docs = useQuery({
    queryKey: ['kb-docs', spaceId],
    queryFn: async () => {
      const r = await fetch(`/api/kb/documents?spaceId=${spaceId}`);
      const j = await r.json();
      return (j.documents ?? []) as Array<{ id: string; title: string; status: string }>;
    },
    enabled: depth === 'space',
  });

  /* --------------------------------------------------------------- seeds */

  const seeds: FieldSeed[] = useMemo(() => {
    if (depth === 'cortex') {
      const visible = source ? spaces.filter((s) => s.intake[source] > 0) : spaces;
      return visible.map((s) => ({
        id: s.id,
        label: s.name,
        // Under a source filter the honest figure is documents of that source:
        // fragments are counted through a join on spaces, not on sources, so
        // there is no per-source fragment count to show and inventing one would
        // make every other figure on this page suspect.
        weight: source ? s.intake[source] : (s.chunkCount ?? s.documentCount),
        mix: source ? { [source]: 1 } : s.intake,
      }));
    }
    const nodes = graph.data?.nodes ?? [];
    const kept = source ? nodes.filter((n) => n.source === source) : nodes;
    const alive = new Set(kept.map((n) => n.id));
    // Ties are the semantic edges: two documents about the same subject get
    // drawn near each other, which is the one thing a relief map cannot say on
    // its own and the reason the graph is worth carrying up here at all.
    const ties = new Map<string, string[]>();
    for (const edge of graph.data?.semantic ?? []) {
      if (!alive.has(edge.a) || !alive.has(edge.b)) continue;
      ties.set(edge.a, [...(ties.get(edge.a) ?? []), edge.b]);
      ties.set(edge.b, [...(ties.get(edge.b) ?? []), edge.a]);
    }
    return kept.map((n) => ({
      id: n.id,
      label: n.title,
      weight: n.chunks,
      mix: { [n.source]: 1 },
      ties: ties.get(n.id) ?? [],
    }));
  }, [depth, spaces, source, graph.data]);

  /* -------------------------------------------------------------- the list */

  const items: IndexItem[] = useMemo(() => {
    if (depth === 'cortex') {
      const visible = source ? spaces.filter((s) => s.intake[source] > 0) : spaces;
      return visible.map((s) => ({
        id: s.id,
        label: s.name,
        sub: [
          s.kind === 'global' ? 'Común' : s.isMine ? 'Tuyo' : (s.ownerName ?? 'De otra persona'),
          plural(s.documentCount, 'documento', 'documentos'),
        ].join(' · '),
        weight: source ? s.intake[source] : (s.chunkCount ?? s.documentCount),
        badge:
          s.failedCount > 0
            ? { text: `${num(s.failedCount)} atascados`, tone: 'rose' as const }
            : s.pendingCount > 0
              ? { text: 'indexando', tone: 'amber' as const }
              : null,
      }));
    }
    // Every document, not only the ones with vectors: a file still being read
    // belongs in the list that says what is in this space, marked as not yet
    // retrievable. It simply raises no hill, because it is not memory yet.
    const chunksOf = new Map((graph.data?.nodes ?? []).map((n) => [n.id, n.chunks] as const));
    const sourceOf = new Map((graph.data?.nodes ?? []).map((n) => [n.id, n.source] as const));
    return (docs.data ?? [])
      .filter((d) => !source || sourceOf.get(d.id) === source)
      .map((d) => ({
        id: d.id,
        label: d.title,
        sub: chunksOf.has(d.id) ? 'en memoria' : 'sin fragmentos todavía',
        weight: chunksOf.get(d.id) ?? 0,
        badge:
          d.status === 'failed'
            ? { text: 'atascado', tone: 'rose' as const }
            : d.status !== 'ready'
              ? { text: 'indexando', tone: 'amber' as const }
              : null,
      }));
  }, [depth, spaces, source, graph.data, docs.data]);

  /* --------------------------------------------------------------- flare */

  // Where the last question landed. The map reads this before the results have
  // finished rendering underneath, which is the moment the two halves of the
  // screen stop being two things.
  const flare: FieldFlare | null = useMemo(() => {
    if (!probe) return null;
    const strength = new Map<string, number>();
    for (const fragment of probe.fragments) {
      if (fragment.verdict === 'dropped') continue;
      const key = depth === 'cortex' ? fragment.spaceId : fragment.documentId;
      const value = Math.max(0, Math.min(1, (fragment.cosine ?? 0.5) / 0.8));
      strength.set(key, Math.max(strength.get(key) ?? 0, value));
    }
    return strength.size > 0 ? { strength, query: probe.query } : null;
  }, [probe, depth]);

  const working = useMemo(() => {
    if (depth === 'cortex') {
      return new Set(spaces.filter((s) => s.pendingCount > 0).map((s) => s.id));
    }
    return new Set(stats.digesting.map((d) => d.id));
  }, [depth, spaces, stats.digesting]);

  /* ------------------------------------------------------------ navigation */

  // What you last walked into at each level, kept after you come back out so
  // the map can mark it. Coming back from reading a document to a range of
  // forty hills with no idea which one you were just inside is how a map loses
  // the thread. Two values rather than one because the two levels draw
  // different things and a document id means nothing on the map of spaces.
  const [lastSpace, setLastSpace] = useState<string | null>(null);
  const [lastDocument, setLastDocument] = useState<string | null>(null);

  const openFragment = useCallback((docId: string, index: number) => {
    setDocumentId(docId);
    setFocusIndex(index);
    setLastDocument(docId);
  }, []);

  const openDocument = useCallback((docId: string) => {
    setDocumentId(docId);
    setFocusIndex(null);
    setLastDocument(docId);
  }, []);

  const enter = useCallback(
    (id: string) => {
      if (depth === 'cortex') {
        setSpaceId(id);
        setLastSpace(id);
        setHovered(null);
        return;
      }
      openDocument(id);
    },
    [depth, openDocument],
  );

  // Coming back up from a document lands you on the space it lives in, even if
  // you arrived from a search across everything — otherwise "back" from a
  // fragment is a jump to the top of the whole corpus and the place you were
  // reading is gone.
  const landedSpace = useMemo(() => {
    if (!documentId || spaceId) return null;
    return probe?.fragments.find((f) => f.documentId === documentId)?.spaceId ?? null;
  }, [documentId, spaceId, probe]);

  const backFromDocument = useCallback(() => {
    setDocumentId(null);
    setFocusIndex(null);
    if (!spaceId && landedSpace) setSpaceId(landedSpace);
  }, [spaceId, landedSpace]);

  // A source filter that hides everything is a filter that has silently emptied
  // the screen. Clearing it when the level changes keeps that from happening on
  // the way down into a space that has nothing of that kind.
  // biome-ignore lint/correctness/useExhaustiveDependencies: depth is the trigger
  useEffect(() => setSource(null), [depth]);

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

  const view = focusStats(stats, source);
  const focusLabel = source ? { label: SOURCE_LABEL[source] } : null;
  const unit = depth === 'cortex' && source ? 'documentos' : 'fragmentos';

  return (
    <div className="space-y-4">
      <Panel className="overflow-hidden">
        <Breadcrumb
          spaceName={space?.name ?? null}
          documentOpen={depth === 'document'}
          onCortex={() => {
            setSpaceId(null);
            setDocumentId(null);
            setFocusIndex(null);
          }}
          onSpace={backFromDocument}
        />

        {depth === 'document' && documentId ? (
          // The map flattens into the document's own ribbon. Same idea one
          // level further down — where you are, how big each piece is, what has
          // never been used — so descending never changes the kind of thing you
          // are reading.
          <div className="animate-rise">
            <FragmentReader
              documentId={documentId}
              focusIndex={focusIndex}
              onBack={backFromDocument}
              backLabel={space ? `Volver a ${space.name}` : 'Volver al cerebro'}
            />
          </div>
        ) : (
          <div className="grid border-t border-border lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
            {/* ------------------------------------------------------- map */}
            <div className="border-b border-border px-5 py-4 lg:border-b-0 lg:border-r">
              <BrainField
                seeds={seeds}
                selectedId={depth === 'cortex' ? lastSpace : lastDocument}
                hoveredId={hovered}
                onSelect={enter}
                onHover={setHovered}
                flare={flare}
                working={working}
                unit={unit}
                caption={
                  depth === 'cortex'
                    ? 'Cada colina es un espacio. Lo alto es cuánto recuerda de eso.'
                    : 'Cada colina es un documento. Lo alto es en cuántos fragmentos quedó.'
                }
                emptyText={
                  depth === 'cortex'
                    ? 'Nada en memoria todavía. Dale el primer documento y aquí empieza a levantarse.'
                    : graph.isLoading
                      ? 'Leyendo lo que hay aquí…'
                      : 'Este espacio no tiene nada indexado todavía.'
                }
              />

              <SourceLegend
                stats={stats}
                active={source}
                onToggle={(key) => setSource((was) => (was === key ? null : key))}
              />
            </div>

            {/* ---------------------------------------------------- console */}
            <div className="flex min-h-0 flex-col lg:h-[600px]">
              <div className="flex items-center gap-1 border-b border-border px-4 pt-3">
                <TabButton on={tab === 'ask'} onClick={() => setTab('ask')}>
                  Preguntar
                </TabButton>
                <TabButton on={tab === 'index'} onClick={() => setTab('index')}>
                  Índice
                  <span className="tabular ml-1.5 text-micro opacity-70">
                    {num(items.length)}
                  </span>
                </TabButton>
                {(graph.isFetching || docs.isFetching) && depth === 'space' && (
                  <Loader2 className="ml-auto h-3.5 w-3.5 animate-spin text-ink-faint motion-reduce:animate-none" />
                )}
              </div>

              {tab === 'ask' ? (
                <MemoryBench
                  spaces={spaces}
                  scopeId={spaceId ?? ''}
                  onScopeChange={(id) => {
                    setSpaceId(id || null);
                    setDocumentId(null);
                  }}
                  onProbe={setProbe}
                  onOpenFragment={openFragment}
                />
              ) : (
                <>
                  <IndexList
                    items={items}
                    unit={unit}
                    placeholder={depth === 'cortex' ? 'Buscar un espacio…' : 'Buscar un documento…'}
                    selectedId={depth === 'cortex' ? lastSpace : lastDocument}
                    hoveredId={hovered}
                    onHover={setHovered}
                    onSelect={enter}
                    emptyText={
                      depth === 'cortex'
                        ? 'Todavía no hay espacios.'
                        : 'Este espacio está vacío. Métele algo abajo.'
                    }
                  />
                  {depth === 'cortex' && (
                    <div className="flex flex-wrap gap-2 border-t border-border px-4 py-3">
                      <button
                        type="button"
                        onClick={() => setCreating('personal')}
                        className="inline-flex items-center gap-1.5 rounded-pill border border-border px-3 py-1.5 text-xs font-semibold text-ink-muted transition-colors hover:border-border-strong hover:text-ink"
                      >
                        <Lock className="h-3.5 w-3.5" />
                        Nuevo espacio propio
                      </button>
                      {isAdmin && (
                        <button
                          type="button"
                          onClick={() => setCreating('global')}
                          className="inline-flex items-center gap-1.5 rounded-pill border border-border px-3 py-1.5 text-xs font-semibold text-ink-muted transition-colors hover:border-border-strong hover:text-ink"
                        >
                          <Building2 className="h-3.5 w-3.5" />
                          Nuevo espacio común
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </Panel>

      {/* ------------------------------------------------------ inside a space */}
      {depth === 'space' && space && (
        <SpaceTools
          space={space}
          allSpaces={spaces}
          intake={intake}
          onIntakeChange={setIntake}
          onLeave={() => setSpaceId(null)}
          onOpenDocument={openDocument}
        />
      )}

      {/* --------------------------------------------------------- the analysis */}
      {depth !== 'document' && (
        <Analysis
          health={health}
          shape={shape}
          stale={stale}
          onOpenDocument={openDocument}
          onOpenFragment={openFragment}
        />
      )}

      {/* ------------------------------------------------------------- the belt */}
      {depth === 'cortex' && (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <DigestionPanel stats={view} focus={focusLabel} />
            <KnowsPanel stats={view} focus={focusLabel} />
          </div>

          <IntakeChooser
            spaces={spaces}
            totals={stats.intake}
            highlight={source}
            onFeed={(id, key) => {
              setIntake(key);
              setSpaceId(id);
            }}
            onCreateSpace={() => setCreating('personal')}
          />

          <GrowthPanel stats={view} focus={source} />
        </>
      )}

      {creating && (
        <SpaceDialog kind={creating} onClose={() => setCreating(null)} viewerName={viewerName} />
      )}
    </div>
  );
}

/* -------------------------------------------------------------- furniture */

function Breadcrumb({
  spaceName,
  documentOpen,
  onCortex,
  onSpace,
}: {
  spaceName: string | null;
  documentOpen: boolean;
  onCortex: () => void;
  onSpace: () => void;
}) {
  const crumb = 'rounded-pill px-2 py-0.5 text-xs font-semibold transition-colors';
  return (
    <nav aria-label="Dónde estás" className="flex flex-wrap items-center gap-0.5 px-3 pt-3">
      <button
        type="button"
        onClick={onCortex}
        className={clsx(
          crumb,
          spaceName ? 'text-ink-faint hover:bg-surface-2 hover:text-ink' : 'text-ink',
        )}
      >
        Corteza
      </button>
      {spaceName && (
        <>
          <ChevronRight className="h-3 w-3 text-ink-faint" aria-hidden />
          <button
            type="button"
            onClick={onSpace}
            className={clsx(
              crumb,
              documentOpen ? 'text-ink-faint hover:bg-surface-2 hover:text-ink' : 'text-ink',
            )}
          >
            {spaceName}
          </button>
        </>
      )}
      {documentOpen && (
        <>
          <ChevronRight className="h-3 w-3 text-ink-faint" aria-hidden />
          <span className={clsx(crumb, 'text-ink')}>Fragmentos</span>
        </>
      )}
    </nav>
  );
}

function TabButton({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={clsx(
        '-mb-px border-b-2 px-3 pb-2 pt-1 text-xs font-semibold transition-colors',
        on ? 'border-primary text-primary' : 'border-transparent text-ink-faint hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}

/**
 * The four lobes, named — and still a filter.
 *
 * The relief places material by what it is made of, so the anatomy is doing
 * real work and has to be legible: without this, "why is that hill down there?"
 * has no answer. It doubles as the source filter the page has always had,
 * because the key of a plate is the one place it is natural to put it.
 */
function SourceLegend({
  stats,
  active,
  onToggle,
}: {
  stats: BrainStats;
  active: IntakeKey | null;
  onToggle: (key: IntakeKey) => void;
}) {
  const keys: IntakeKey[] = ['upload', 'meeting', 'drive', 'record'];
  return (
    <div className="mt-3 grid grid-cols-2 gap-1 border-t border-border pt-3 sm:grid-cols-4">
      {keys.map((key) => {
        const on = active === key;
        return (
          <button
            key={key}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(key)}
            className={clsx(
              'rounded-sm px-2 py-1.5 text-left transition-colors',
              on ? 'bg-primary-soft' : 'hover:bg-surface-2',
            )}
          >
            <span
              className={clsx(
                'block truncate text-micro font-semibold',
                on ? 'text-primary' : 'text-ink-muted',
              )}
            >
              {LOBE_NAME[key]}
            </span>
            <span className="stat-num block text-sm text-ink">{num(stats.indexed[key])}</span>
          </button>
        );
      })}
      <p className="col-span-full mt-0.5 text-micro text-ink-faint">
        {active
          ? `Solo ${LOBE_NAME[active].toLowerCase()}. Toca otra vez para ver todo.`
          : 'Cada cosa se dibuja sobre el lóbulo del que viene. Toca uno para ver solo eso.'}
      </p>
    </div>
  );
}

/** Kept from the old page: what a space is, said once, on a blank workspace. */
function FirstRun({ isAdmin, onCreate }: { isAdmin: boolean; onCreate: () => void }) {
  return (
    <Panel className="px-6 py-10 text-center">
      <p className="text-base font-bold text-ink">Este cerebro está vacío</p>
      <p className="mx-auto mt-1.5 max-w-lg text-sm leading-relaxed text-ink-muted">
        Aquí Cortex guarda lo que la empresa sabe: una tarifa, un instructivo, lo que se dijo en una
        llamada. Dale el primer documento y podrá citarlo cuando alguien pregunte.
      </p>
      <div className="mt-4 flex justify-center">
        <button
          type="button"
          onClick={onCreate}
          className="inline-flex items-center gap-1.5 rounded-pill bg-primary px-4 py-2 text-xs font-semibold text-white shadow-pop transition-colors hover:bg-primary-strong"
        >
          <Plus className="h-3.5 w-3.5" />
          Crear el primer espacio
        </button>
      </div>
      <p className="mx-auto mt-3 max-w-lg text-micro text-ink-faint">
        {isAdmin
          ? 'Un espacio propio es solo tuyo. Uno común lo lee toda la empresa.'
          : 'Un espacio propio es solo tuyo. Para uno común, pídeselo a un administrador.'}
      </p>
    </Panel>
  );
}

/** Still exported here: `SpaceTools` and the intake panels both use it. */
export function SpaceChip({ kind, label }: { kind: 'global' | 'personal'; label?: string }) {
  const Icon = kind === 'global' ? Building2 : Lock;
  return (
    <span
      className={clsx(
        'inline-flex shrink-0 items-center gap-1 rounded-pill px-2 py-0.5 text-micro font-bold',
        kind === 'global' ? 'bg-primary-soft text-primary' : 'bg-surface-2 text-ink-muted',
      )}
    >
      <Icon className="h-3 w-3" />
      {label ?? (kind === 'global' ? 'Común' : 'Propio')}
    </span>
  );
}
