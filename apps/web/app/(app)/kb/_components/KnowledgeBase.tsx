'use client';

import { Panel } from '@/components/ui/panel';
import { relativeTime } from '@/lib/relative-time';
import { clsx } from 'clsx';
import {
  AlertTriangle,
  BookOpen,
  Building2,
  FileText,
  Loader2,
  Lock,
  Plus,
  Search,
  Sparkles,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { searchKnowledge } from '../actions';
import { SpaceDetail } from './SpaceDetail';
import { SpaceDialog } from './SpaceDialog';
import type { SearchResult, SpaceSummary } from './types';

export function KnowledgeBase({
  spaces,
  isAdmin,
  viewerName,
}: {
  spaces: SpaceSummary[];
  isAdmin: boolean;
  viewerName: string;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
          onBack={() => setSelectedId(null)}
          viewerName={viewerName}
        />
        {creating && (
          <SpaceDialog kind={creating} onClose={() => setCreating(null)} viewerName={viewerName} />
        )}
      </>
    );
  }

  return (
    <div className="space-y-5">
      <AskPanel spaces={spaces} onOpenSpace={setSelectedId} />

      {spaces.length === 0 ? (
        <FirstRun isAdmin={isAdmin} onCreate={() => setCreating('personal')} />
      ) : (
        <>
          {/* --------------------------------------------------- company spaces */}
          <SpaceGroup
            title="Company spaces"
            blurb="Everyone can read these, and everyone's Zippy answers from them. Only an org admin can add one."
            icon={Building2}
            spaces={company}
            onOpen={setSelectedId}
            action={
              isAdmin
                ? { label: 'New company space', onClick: () => setCreating('global') }
                : undefined
            }
            emptyText="Nothing company-wide yet. Anything filed here becomes the answer everyone gets."
          />

          {/* ------------------------------------------------------- your spaces */}
          <SpaceGroup
            title="Your spaces"
            blurb="Only you can read these, and only your own Zippy answers from them. Nobody else's search will ever reach them."
            icon={Lock}
            spaces={mine}
            onOpen={setSelectedId}
            action={{ label: 'New personal space', onClick: () => setCreating('personal') }}
            emptyText="Somewhere to keep your own working notes — a client's quirks, a draft you want Zippy to remember."
          />
        </>
      )}

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
    <Panel className="p-5">
      <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
        <Sparkles className="h-3.5 w-3.5 text-primary" />
        Ask the Knowledge Base
      </div>

      <div className="flex flex-wrap gap-2">
        <div className="relative min-w-[240px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && run()}
            placeholder="Rates for a senior React developer, how we onboard a new client…"
            className="h-9 w-full rounded-pill border border-border bg-surface-2 pl-9 pr-3 text-[13px] text-ink placeholder:text-ink-faint focus:border-primary/40 focus:bg-surface focus:outline-none focus:ring-4 focus:ring-primary/10"
          />
        </div>

        {spaces.length > 1 && (
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            className="h-9 rounded-pill border border-border bg-surface px-3 text-[12.5px] font-medium text-ink focus:border-border-strong focus:outline-none"
          >
            <option value="">Everywhere you can see</option>
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
          className="inline-flex h-9 items-center gap-1.5 rounded-pill bg-primary px-4 text-[12.5px] font-semibold text-white shadow-pop transition-colors hover:bg-primary-strong disabled:opacity-40"
        >
          {running && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Search
        </button>
      </div>

      {error && (
        <p className="mt-3 rounded-[10px] border border-rose/30 bg-rose-soft px-3 py-2 text-[12px] text-rose">
          {error}
        </p>
      )}

      {results !== null && !error && (
        <div className="mt-4 space-y-2.5">
          {results.length === 0 ? (
            <p className="text-[12.5px] leading-relaxed text-ink-muted">
              Nothing on that{scopeName ? ` in ${scopeName}` : ''} yet. The Knowledge Base only
              knows what has been put into it — add a document to a space and Zippy can answer from
              it a minute later.
            </p>
          ) : (
            results.map((r) => (
              <div
                key={`${r.documentId}-${r.chunkIndex}`}
                className="rounded-[12px] border border-border bg-canvas px-3.5 py-3"
              >
                <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                  <span className="inline-flex min-w-0 items-center gap-1.5 text-[12.5px] font-semibold text-ink">
                    <FileText className="h-3.5 w-3.5 shrink-0 text-primary" />
                    <span className="truncate">{r.documentTitle}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <SpaceChip kind={r.spaceKind} label={r.space} />
                    <span className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-2">
                      <span
                        className="block h-full rounded-full bg-primary"
                        style={{ width: `${Math.round(Math.min(1, Math.max(0, r.score)) * 100)}%` }}
                      />
                    </span>
                  </span>
                </div>
                <p className="line-clamp-3 text-[12.5px] leading-relaxed text-ink-muted">
                  {r.content}
                </p>
              </div>
            ))
          )}
        </div>
      )}

      {results === null && !error && (
        <p className="mt-3 text-[11.5px] text-ink-faint">
          The same search Zippy runs before it answers you — so if it is not here, Zippy does not
          know it either.
        </p>
      )}

      {results !== null && results.length > 0 && (
        <button
          type="button"
          onClick={() => {
            const first = spaces.find((s) => s.name === results[0]?.space);
            if (first) onOpenSpace(first.id);
          }}
          className="mt-3 rounded-pill px-2.5 py-1 text-[11.5px] font-semibold text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink-muted"
        >
          Open {results[0]?.space}
        </button>
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
        'inline-flex shrink-0 items-center gap-1 rounded-pill px-2 py-0.5 text-[10.5px] font-bold',
        kind === 'global' ? 'bg-primary-soft text-primary' : 'bg-surface-2 text-ink-muted',
      )}
    >
      <Icon className="h-3 w-3" />
      {label ?? (kind === 'global' ? 'Company' : 'Personal')}
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
          <p className="mt-0.5 max-w-2xl text-[12px] leading-relaxed text-ink-faint">{blurb}</p>
        </div>
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            className="inline-flex items-center gap-1.5 rounded-pill border border-border px-3 py-1.5 text-[12px] font-semibold text-ink-muted transition-colors hover:border-border-strong hover:text-ink"
          >
            <Plus className="h-3.5 w-3.5" />
            {action.label}
          </button>
        )}
      </div>

      {spaces.length === 0 ? (
        <Panel className="px-5 py-6 text-[12.5px] leading-relaxed text-ink-faint">
          {emptyText}
        </Panel>
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
      <Panel className="flex h-full flex-col gap-2.5 p-4 transition-all group-hover:-translate-y-0.5 group-hover:shadow-pop">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-[13.5px] font-bold text-ink">{space.name}</div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <SpaceChip kind={space.kind} />
              {space.ownerName && (
                <span className="truncate text-[11px] text-ink-faint">
                  {space.isMine ? 'Yours' : space.ownerName}
                </span>
              )}
            </div>
          </div>
          <span className="stat-num shrink-0 text-[22px] leading-none text-ink">
            {space.documentCount}
          </span>
        </div>

        {space.description && (
          <p className="line-clamp-2 text-[12px] leading-relaxed text-ink-muted">
            {space.description}
          </p>
        )}

        <div className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-2.5 text-[11.5px] text-ink-faint">
          <span>
            {space.documentCount === 1 ? '1 document' : `${space.documentCount} documents`}
            {space.lastAddedAt && ` · last added ${relativeTime(space.lastAddedAt)}`}
          </span>
          {space.failedCount > 0 ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-rose">
              <AlertTriangle className="h-3 w-3" />
              {space.failedCount}
            </span>
          ) : space.pendingCount > 0 ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-amber">
              <Loader2 className="h-3 w-3 animate-spin" />
              {space.pendingCount}
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
    <Panel className="p-10 text-center">
      <span className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-[14px] bg-primary-soft text-primary">
        <BookOpen className="h-5 w-5" />
      </span>
      <p className="mb-1 text-[15px] font-bold text-ink">Nothing in here yet</p>
      <p className="mx-auto max-w-lg text-[13px] leading-relaxed text-ink-muted">
        The Knowledge Base is where Zippy remembers things: how a client likes to be pitched, what
        we charge for a senior back-end developer, the proposal that won last quarter. Put a
        document in, and Zippy can answer from it the next time anyone asks — with the document
        named, so you can check.
      </p>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          onClick={onCreate}
          className="inline-flex items-center gap-1.5 rounded-pill bg-primary px-4 py-2 text-[12.5px] font-semibold text-white shadow-pop transition-colors hover:bg-primary-strong"
        >
          <Plus className="h-3.5 w-3.5" />
          Create a space
        </button>
      </div>
      <p className="mx-auto mt-3 max-w-lg text-[11.5px] text-ink-faint">
        {isAdmin
          ? 'A personal space is yours alone. A company space is read by everyone, so start there only for things the whole company should be told.'
          : 'A space of your own is private — only your own answers use it. Ask an org admin for a company-wide one.'}
      </p>
    </Panel>
  );
}
