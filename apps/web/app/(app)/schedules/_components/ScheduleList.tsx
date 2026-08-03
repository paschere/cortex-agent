'use client';

import { clsx } from 'clsx';
import { AlarmClock, Globe, Search, SearchX, User, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { EditRoutineDialog } from './EditRoutineDialog';
import { RoutineCard } from './RoutineCard';
import { RunDetailDialog } from './RunDetailDialog';
import type { JobRun, JobStatus, RoutinePatch, ScheduledJob } from './types';
import { useNow } from './useNow';

export type { JobRun, ScheduledJob } from './types';

type Filter = 'all' | 'global' | 'mine' | 'paused';

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'global', label: 'Global' },
  { id: 'mine', label: 'Mine' },
  { id: 'paused', label: 'Paused' },
];

function matchesFilter(job: ScheduledJob, filter: Filter, userId: string): boolean {
  if (filter === 'global') return job.isGlobal;
  if (filter === 'mine') return job.ownerId === userId;
  if (filter === 'paused') return job.status === 'paused';
  return true;
}

export function ScheduleList({
  jobs,
  currentUserId,
}: {
  jobs: ScheduledJob[];
  currentUserId: string;
}) {
  const router = useRouter();
  const now = useNow();

  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [highlightRunId, setHighlightRunId] = useState<string | null>(null);
  const [openRun, setOpenRun] = useState<{ run: JobRun; job: ScheduledJob } | null>(null);
  const [editing, setEditing] = useState<ScheduledJob | null>(null);

  /**
   * Optimistic layers over the server data: status flips land instantly and are
   * dropped as soon as a fresh `jobs` array arrives from the server render.
   */
  const [statusOverride, setStatusOverride] = useState<Record<string, JobStatus>>({});
  const [patchOverride, setPatchOverride] = useState<Record<string, RoutinePatch>>({});
  const [snapshot, setSnapshot] = useState(jobs);
  if (snapshot !== jobs) {
    // Fresh server data landed — the optimistic layers have served their turn.
    setSnapshot(jobs);
    setStatusOverride({});
    setPatchOverride({});
  }

  const merged = useMemo(
    () =>
      jobs.map((job) => {
        const patch = patchOverride[job.id];
        return {
          ...job,
          ...(patch?.name !== undefined ? { name: patch.name } : null),
          ...(patch?.cron !== undefined ? { cron: patch.cron } : null),
          ...(patch?.timezone !== undefined ? { timezone: patch.timezone } : null),
          ...(patch?.notifyEmail !== undefined ? { notifyEmail: patch.notifyEmail } : null),
          ...(patch?.recipients !== undefined ? { recipients: patch.recipients } : null),
          status: statusOverride[job.id] ?? job.status,
        } satisfies ScheduledJob;
      }),
    [jobs, statusOverride, patchOverride],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return merged.filter((job) => {
      if (!matchesFilter(job, filter, currentUserId)) return false;
      if (!q) return true;
      return (
        job.name.toLowerCase().includes(q) ||
        (job.instruction ?? '').toLowerCase().includes(q) ||
        (job.toolId ?? '').toLowerCase().includes(q)
      );
    });
  }, [merged, filter, query, currentUserId]);

  const counts = useMemo(
    () => ({
      all: merged.length,
      global: merged.filter((j) => j.isGlobal).length,
      mine: merged.filter((j) => j.ownerId === currentUserId).length,
      paused: merged.filter((j) => j.status === 'paused').length,
    }),
    [merged, currentUserId],
  );

  const globals = visible.filter((j) => j.isGlobal);
  const personal = visible.filter((j) => !j.isGlobal);
  const grouped = globals.length > 0 && personal.length > 0;

  /**
   * Fire the routine now. The run happens in the background, so we hold the
   * "Running…" state briefly and then refresh to pick up the new run row.
   */
  async function runNow(jobId: string) {
    setRunning(jobId);
    setError(null);
    try {
      const res = await fetch(`/api/schedules/${jobId}/run`, { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Request failed (${res.status})`);
      }
      setTimeout(() => {
        setRunning(null);
        router.refresh();
      }, 2000);
    } catch (err) {
      setError((err as Error).message);
      setRunning(null);
    }
  }

  async function act(jobId: string, action: 'pause' | 'resume' | 'cancel') {
    if (action === 'cancel' && !window.confirm('Cancel this routine permanently?')) return;
    const optimistic: JobStatus =
      action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'cancelled';
    setStatusOverride((prev) => ({ ...prev, [jobId]: optimistic }));
    setBusy(jobId);
    setError(null);
    try {
      const res = await fetch(`/api/schedules/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Request failed (${res.status})`);
      }
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setStatusOverride((prev) => {
        const next = { ...prev };
        delete next[jobId];
        return next;
      });
    } finally {
      setBusy(null);
    }
  }

  /** Clicking a dot: open the card and bring that run into view. */
  function selectRun(job: ScheduledJob, run: JobRun) {
    setExpanded(job.id);
    setHighlightRunId(run.id);
    setTimeout(() => {
      document
        .getElementById(`run-${run.id}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 80);
  }

  function renderCard(job: ScheduledJob) {
    return (
      <RoutineCard
        key={job.id}
        job={job}
        now={now}
        expanded={expanded === job.id}
        busy={busy === job.id}
        running={running === job.id}
        canEdit={job.ownerId === currentUserId || job.isGlobal}
        highlightRunId={expanded === job.id ? highlightRunId : null}
        onToggle={() => setExpanded(expanded === job.id ? null : job.id)}
        onRunNow={() => runNow(job.id)}
        onAction={(action) => act(job.id, action)}
        onEdit={() => setEditing(job)}
        onOpenRun={(run) => setOpenRun({ run, job })}
        onSelectRun={(run) => selectRun(job, run)}
      />
    );
  }

  if (jobs.length === 0) {
    return (
      <section className="rounded-card border border-border bg-surface p-10 text-center text-[13px] text-ink-faint shadow-card">
        <AlarmClock className="mx-auto mb-3 h-8 w-8 text-primary" />
        <p className="mb-1 font-semibold text-ink">No routines yet</p>
        <p>
          Ask Cortex in{' '}
          <Link href="/chat" className="font-semibold text-primary hover:text-primary-strong">
            chat
          </Link>
          :{' '}
          <em>
            &ldquo;Every Friday at 4pm, send each client their active-candidates report.&rdquo;
          </em>
        </p>
      </section>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1 rounded-[12px] bg-surface-2 p-1">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              aria-pressed={filter === f.id}
              className={clsx(
                'inline-flex items-center gap-1.5 rounded-[9px] px-2.5 py-1.5 text-[12px] font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                filter === f.id
                  ? 'bg-surface text-ink shadow-card'
                  : 'text-ink-faint hover:text-ink',
              )}
            >
              {f.label}
              <span
                className={clsx(
                  'rounded-pill px-1.5 text-[10.5px] font-bold',
                  filter === f.id ? 'bg-primary-soft text-primary' : 'text-ink-faint',
                )}
              >
                {counts[f.id]}
              </span>
            </button>
          ))}
        </div>

        <label className="relative ml-auto min-w-[10rem] flex-1 sm:max-w-[18rem]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name or instruction…"
            aria-label="Search routines"
            className="w-full rounded-[10px] border border-border bg-surface py-1.5 pl-8 pr-7 text-[12.5px] text-ink outline-none transition placeholder:text-ink-faint focus:border-primary focus:ring-2 focus:ring-primary-soft"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="absolute right-1.5 top-1/2 grid h-5 w-5 -translate-y-1/2 place-items-center rounded-pill text-ink-faint transition hover:bg-surface-2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </label>
      </div>

      {error && (
        <div className="rounded-[12px] border border-rose/30 bg-rose-soft px-3 py-2 text-[12.5px] text-rose">
          {error}
        </div>
      )}

      {visible.length === 0 ? (
        <section className="rounded-card border border-border bg-surface p-8 text-center text-[13px] text-ink-faint shadow-card">
          <SearchX className="mx-auto mb-2.5 h-7 w-7 text-ink-faint" />
          <p className="mb-1 font-semibold text-ink">Nothing matches</p>
          <p className="mb-3">No routine fits this filter and search.</p>
          <button
            type="button"
            onClick={() => {
              setFilter('all');
              setQuery('');
            }}
            className="rounded-[10px] bg-primary px-3 py-1.5 text-[12px] font-semibold text-white transition hover:bg-primary-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            Clear filters
          </button>
        </section>
      ) : grouped ? (
        <div className="space-y-5">
          <Group
            icon={<Globe className="h-3.5 w-3.5" />}
            label="Global routines"
            count={globals.length}
          >
            {globals.map(renderCard)}
          </Group>
          <Group
            icon={<User className="h-3.5 w-3.5" />}
            label="My routines"
            count={personal.length}
          >
            {personal.map(renderCard)}
          </Group>
        </div>
      ) : (
        <div className="space-y-3">{visible.map(renderCard)}</div>
      )}

      <RunDetailDialog
        run={openRun?.run ?? null}
        jobName={openRun?.job.name ?? ''}
        conversationId={openRun?.job.conversationId ?? null}
        now={now}
        onClose={() => setOpenRun(null)}
      />

      <EditRoutineDialog
        job={editing}
        onClose={() => setEditing(null)}
        onSaved={(patch) => {
          if (editing) setPatchOverride((prev) => ({ ...prev, [editing.id]: patch }));
          setEditing(null);
          router.refresh();
        }}
      />
    </div>
  );
}

function Group({
  icon,
  label,
  count,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
        {icon}
        {label}
        <span className="rounded-pill bg-surface-2 px-1.5 text-[10.5px] font-bold normal-case tracking-normal">
          {count}
        </span>
      </h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}
