'use client';

import { Eyebrow, Panel } from '@/components/ui/panel';
import { clsx } from 'clsx';
import { Radar, Search, SearchX } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { setProspectStatus } from '../actions';
import { ProspectCard } from './ProspectCard';
import { STATUS_META } from './status';
import type { Prospect, SignalStatus } from './types';

/** The funnel reads left to right; rejected sits at the end, off the path. */
const FUNNEL: SignalStatus[] = ['new', 'qualified', 'contacted', 'rejected'];

const ANY = 'all';

export function ProspectBoard({
  prospects,
  truncated,
  apolloAvailable,
}: {
  prospects: Prospect[];
  truncated: boolean;
  apolloAvailable: boolean;
}) {
  // The default view is the work, not the archive.
  const [status, setStatus] = useState<SignalStatus | typeof ANY>('new');
  const [region, setRegion] = useState<string>(ANY);
  const [source, setSource] = useState<string>(ANY);
  const [query, setQuery] = useState('');

  /**
   * Optimistic layer. A status change paints immediately and is reverted in
   * place if the server refuses; when a fresh server render arrives it has the
   * truth, so the layer is dropped.
   */
  const [moved, setMoved] = useState<
    Record<string, { status: SignalStatus; reviewerName: string; reviewedAt: string }>
  >({});
  const [busy, setBusy] = useState<Record<string, SignalStatus>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [snapshot, setSnapshot] = useState(prospects);
  if (snapshot !== prospects) {
    setSnapshot(prospects);
    setMoved({});
  }

  /**
   * Rows touched since the last filter change stay on screen even once their new
   * status no longer matches the filter. Rejecting something from the New list
   * should visibly file it away, not make it vanish — "where did it go?" is the
   * exact question this page exists to answer.
   */
  const [pinned, setPinned] = useState<Set<string>>(new Set());

  function refilter(fn: () => void) {
    fn();
    setPinned(new Set());
  }

  const merged = useMemo(
    () =>
      prospects.map((p) => {
        const m = moved[p.id];
        return m
          ? {
              ...p,
              status: m.status,
              reviewerName: m.reviewerName,
              reviewedAt: m.reviewedAt,
            }
          : p;
      }),
    [prospects, moved],
  );

  const counts = useMemo(() => {
    const c: Record<SignalStatus, number> = {
      new: 0,
      qualified: 0,
      contacted: 0,
      rejected: 0,
    };
    for (const p of merged) c[p.status] += 1;
    return c;
  }, [merged]);

  const regions = useMemo(
    () => [...new Set(prospects.map((p) => p.region).filter((r): r is string => !!r))].sort(),
    [prospects],
  );
  const sources = useMemo(
    () => [...new Set(prospects.map((p) => p.source).filter(Boolean))].sort(),
    [prospects],
  );

  const filtersActive = region !== ANY || source !== ANY || query.trim() !== '';

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return merged.filter((p) => {
      if (pinned.has(p.id)) return true;
      if (status !== ANY && p.status !== status) return false;
      if (region !== ANY && p.region !== region) return false;
      if (source !== ANY && p.source !== source) return false;
      if (q && !p.company.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [merged, pinned, status, region, source, query]);

  async function move(prospect: Prospect, next: SignalStatus) {
    const previous = prospect.status;
    setErrors(({ [prospect.id]: _gone, ...rest }) => rest);
    setBusy((b) => ({ ...b, [prospect.id]: next }));
    setMoved((m) => ({
      ...m,
      [prospect.id]: {
        status: next,
        reviewerName: 'you',
        reviewedAt: new Date().toISOString(),
      },
    }));
    setPinned((s) => new Set(s).add(prospect.id));

    const result = await setProspectStatus(prospect.id, next);

    setBusy(({ [prospect.id]: _done, ...rest }) => rest);
    if (result.ok) {
      setMoved((m) => ({
        ...m,
        [prospect.id]: {
          status: next,
          reviewerName: result.reviewerName,
          reviewedAt: result.reviewedAt,
        },
      }));
      return;
    }
    // Rolled back: put the old stage back and say why it did not stick.
    setMoved((m) => ({
      ...m,
      [prospect.id]: {
        status: previous,
        reviewerName: prospect.reviewerName ?? '',
        reviewedAt: prospect.reviewedAt ?? '',
      },
    }));
    setPinned((s) => {
      const next2 = new Set(s);
      next2.delete(prospect.id);
      return next2;
    });
    setErrors((e) => ({ ...e, [prospect.id]: result.error }));
  }

  if (prospects.length === 0) return <NothingFoundYet />;

  const total = merged.length;

  return (
    <div className="flex flex-col gap-4">
      {/* ------------------------------------------------------------ funnel */}
      <Panel className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Eyebrow>Prospecting funnel</Eyebrow>
          <button
            type="button"
            onClick={() => refilter(() => setStatus(ANY))}
            className={clsx(
              'rounded-pill px-2.5 py-1 text-[11.5px] font-semibold transition-colors',
              status === ANY
                ? 'bg-primary-soft text-primary'
                : 'text-ink-faint hover:bg-surface-2 hover:text-ink-muted',
            )}
          >
            Show all {total}
          </button>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          {FUNNEL.map((stage) => {
            const meta = STATUS_META[stage];
            const count = counts[stage];
            const pct = total > 0 ? Math.round((count / total) * 100) : 0;
            const active = status === stage;
            const Icon = meta.icon;
            return (
              <button
                key={stage}
                type="button"
                onClick={() => refilter(() => setStatus(stage))}
                aria-pressed={active}
                className={clsx(
                  'rounded-card bg-surface p-3 text-left transition-all',
                  active
                    ? `border border-transparent shadow-pop ring-2 ${meta.ring}`
                    : 'border border-border hover:border-border-strong',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11.5px] font-semibold text-ink-muted">{meta.label}</span>
                  <span
                    className={clsx('grid h-6 w-6 place-items-center rounded-[8px]', meta.chip)}
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                </div>
                <div className="stat-num mt-1.5 text-[26px] leading-none text-ink">{count}</div>
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-canvas">
                  <div
                    className={clsx(
                      'h-full rounded-full transition-[width] duration-500',
                      meta.bar,
                    )}
                    style={{ width: `${Math.max(pct, count > 0 ? 5 : 0)}%` }}
                  />
                </div>
                <div className="mt-1.5 truncate text-[10.5px] text-ink-faint">{meta.blurb}</div>
              </button>
            );
          })}
        </div>

        <p className="mt-3 text-[11.5px] leading-relaxed text-ink-faint">
          Cortex sweeps the job boards weekly and drops what it finds into <b>New</b>. From there it
          only ever moves — a rejected company keeps its place under Rejected so nobody spends an
          afternoon researching it a second time.
        </p>
      </Panel>

      {/* ----------------------------------------------------------- filters */}
      <Panel className="flex flex-wrap items-center gap-2 p-3">
        <div className="relative min-w-[190px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
          <input
            value={query}
            onChange={(e) => refilter(() => setQuery(e.target.value))}
            placeholder="Search by company"
            className="w-full rounded-pill border border-border bg-surface py-1.5 pl-8 pr-3 text-[12.5px] text-ink placeholder:text-ink-faint focus:border-border-strong focus:outline-none"
          />
        </div>

        <FilterSelect
          label="Region"
          value={region}
          options={regions}
          onChange={(v) => refilter(() => setRegion(v))}
        />
        <FilterSelect
          label="Found on"
          value={source}
          options={sources}
          onChange={(v) => refilter(() => setSource(v))}
        />

        {filtersActive && (
          <button
            type="button"
            onClick={() =>
              refilter(() => {
                setRegion(ANY);
                setSource(ANY);
                setQuery('');
              })
            }
            className="rounded-pill px-2.5 py-1 text-[11.5px] font-semibold text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink-muted"
          >
            Clear
          </button>
        )}

        <span className="ml-auto text-[11.5px] text-ink-faint">
          {visible.length} shown
          {truncated && ' · older prospects not loaded'}
        </span>
      </Panel>

      {/* -------------------------------------------------------------- list */}
      {visible.length === 0 ? (
        <NothingMatches
          status={status}
          filtersActive={filtersActive}
          onClear={() =>
            refilter(() => {
              setStatus(ANY);
              setRegion(ANY);
              setSource(ANY);
              setQuery('');
            })
          }
        />
      ) : (
        <div className="space-y-3">
          {visible.map((p) => (
            <ProspectCard
              key={p.id}
              prospect={p}
              busyWith={busy[p.id] ?? null}
              error={errors[p.id] ?? null}
              apolloAvailable={apolloAvailable}
              filedAway={pinned.has(p.id) && status !== ANY && p.status !== status}
              onMove={(next) => move(p, next)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  if (options.length < 2) return null;
  return (
    <label className="flex items-center gap-1.5 text-[11.5px] text-ink-faint">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-pill border border-border bg-surface px-2.5 py-1.5 text-[12.5px] font-medium text-ink focus:border-border-strong focus:outline-none"
      >
        <option value={ANY}>Any</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

/** First run: the table is empty and the person needs to know how it fills. */
function NothingFoundYet() {
  return (
    <Panel className="p-10 text-center">
      <span className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-[14px] bg-primary-soft text-primary">
        <Radar className="h-5 w-5" />
      </span>
      <p className="mb-1 text-[15px] font-bold text-ink">No prospects yet</p>
      <p className="mx-auto max-w-lg text-[13px] leading-relaxed text-ink-muted">
        Cortex sweeps the public job boards once a week looking for companies hiring the kind of
        people your team places, and everything it finds lands here.
      </p>
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <Link
          href="/chat"
          className="rounded-pill bg-primary px-4 py-2 text-[12.5px] font-semibold text-white shadow-pop transition-colors hover:bg-primary-strong"
        >
          Ask Cortex to sweep now
        </Link>
        <Link
          href="/schedules"
          className="rounded-pill border border-border px-4 py-2 text-[12.5px] font-semibold text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
        >
          Set up the weekly sweep
        </Link>
      </div>
      <p className="mx-auto mt-3 max-w-lg text-[11.5px] text-ink-faint">
        In chat, something like: “Sweep the job boards for senior fullstack and QA roles at US
        companies hiring remote.”
      </p>
    </Panel>
  );
}

function NothingMatches({
  status,
  filtersActive,
  onClear,
}: {
  status: SignalStatus | typeof ANY;
  filtersActive: boolean;
  onClear: () => void;
}) {
  const stage = status !== ANY ? STATUS_META[status] : null;
  const message = filtersActive
    ? 'No company matches those filters. They are still on file — widen the search.'
    : status === 'new'
      ? 'Nothing new to review. Everything Cortex has found has been dealt with — the next sweep will bring more.'
      : status === 'qualified'
        ? 'Nothing qualified yet. Work through the new ones and keep the companies worth approaching.'
        : status === 'contacted'
          ? 'Nobody has been marked as contacted yet. Once you reach out, mark them here so the team can see it.'
          : 'Nothing rejected yet.';

  return (
    <Panel className="p-10 text-center">
      <span className="mx-auto mb-3 grid h-11 w-11 place-items-center rounded-[14px] bg-surface-2 text-ink-faint">
        <SearchX className="h-5 w-5" />
      </span>
      <p className="mb-1 text-[14px] font-bold text-ink">
        {stage ? `No ${stage.label.toLowerCase()} prospects here` : 'Nothing to show'}
      </p>
      <p className="mx-auto max-w-md text-[12.5px] leading-relaxed text-ink-muted">{message}</p>
      <button
        type="button"
        onClick={onClear}
        className="mt-4 rounded-pill border border-border px-4 py-1.5 text-[12.5px] font-semibold text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
      >
        Show everything
      </button>
    </Panel>
  );
}
