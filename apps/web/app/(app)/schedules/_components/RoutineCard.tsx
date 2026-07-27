'use client';

import { clsx } from 'clsx';
import {
  AlarmClock,
  Bot,
  ChevronDown,
  Globe,
  Loader2,
  Mail,
  MessageSquare,
  Pause,
  Pencil,
  Play,
  ShieldAlert,
  TriangleAlert,
  Wrench,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { fmt, humanizeCron, relative, runDuration, untilNext } from './format';
import type { JobRun, JobStatus, ScheduledJob } from './types';

const STATUS_STYLES: Record<JobStatus, string> = {
  active: 'bg-emerald-soft text-emerald',
  paused: 'bg-amber-soft text-amber',
  completed: 'bg-surface-2 text-ink-faint',
  cancelled: 'bg-rose-soft text-rose',
};

const RUN_DOT: Record<JobRun['status'], string> = {
  ok: 'bg-emerald',
  error: 'bg-rose',
  running: 'bg-ink-faint',
};

const RUN_PILL: Record<JobRun['status'], string> = {
  ok: 'bg-emerald-soft text-emerald',
  error: 'bg-rose-soft text-rose',
  running: 'bg-surface-2 text-ink-faint',
};

const ICON_BTN =
  'rounded-[10px] p-1.5 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50';

/** Two or more consecutive failures at the head of the history. */
function isFailing(runs: JobRun[]): boolean {
  return runs.length >= 2 && runs[0]?.status === 'error' && runs[1]?.status === 'error';
}

export function RoutineCard({
  job,
  now,
  expanded,
  busy,
  running,
  canEdit,
  highlightRunId,
  onToggle,
  onRunNow,
  onAction,
  onEdit,
  onOpenRun,
  onSelectRun,
}: {
  job: ScheduledJob;
  now: number | null;
  expanded: boolean;
  busy: boolean;
  running: boolean;
  canEdit: boolean;
  highlightRunId: string | null;
  onToggle: () => void;
  onRunNow: () => void;
  onAction: (action: 'pause' | 'resume' | 'cancel') => void;
  onEdit: () => void;
  onOpenRun: (run: JobRun) => void;
  onSelectRun: (run: JobRun) => void;
}) {
  const next = untilNext(job.nextRunAt, now);
  const lastRun = job.runs[0];
  const failing = isFailing(job.runs);
  const preview = lastRun?.error ?? lastRun?.output ?? null;

  return (
    <section className="overflow-hidden rounded-card border border-border bg-surface shadow-card transition hover:border-border-strong">
      <div className="flex flex-wrap items-start gap-3 p-4">
        <span
          className={clsx(
            'grid h-10 w-10 shrink-0 place-items-center rounded-[12px]',
            job.status === 'active'
              ? 'bg-primary-soft text-primary'
              : 'bg-surface-2 text-ink-faint',
          )}
        >
          {job.kind === 'tool' ? (
            <Wrench style={{ height: 18, width: 18 }} />
          ) : (
            <Bot style={{ height: 18, width: 18 }} />
          )}
        </span>

        <div className="min-w-0 flex-1 basis-[15rem]">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            className="block w-full rounded-[8px] text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-[13.5px] font-bold text-ink">{job.name}</span>
              <span
                className={clsx(
                  'rounded-pill px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wide',
                  STATUS_STYLES[job.status],
                )}
              >
                {job.status}
              </span>
              {job.isGlobal && (
                <span
                  className="inline-flex items-center gap-1 rounded-pill bg-primary-soft px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wide text-primary"
                  title="Team routine — runs for the whole workspace"
                >
                  <Globe className="h-3 w-3" /> global
                </span>
              )}
              {failing && (
                <span
                  className="inline-flex items-center gap-1 rounded-pill bg-rose-soft px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wide text-rose"
                  title="The last runs failed in a row"
                >
                  <TriangleAlert className="h-3 w-3" /> failing
                </span>
              )}
              {job.allowUnattendedWrites && (
                <span
                  className="inline-flex items-center gap-1 rounded-pill bg-amber-soft px-2 py-0.5 text-[10.5px] font-bold text-amber"
                  title="This job may execute write tools without a human confirming each one"
                >
                  <ShieldAlert className="h-3 w-3" /> unattended writes
                </span>
              )}
              {job.notifyEmail && (
                <span
                  className="inline-flex items-center gap-1 text-[10.5px] text-ink-faint"
                  title="Emails results"
                >
                  <Mail className="h-3 w-3" />
                </span>
              )}
            </span>
          </button>

          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-faint">
            <span className="inline-flex items-center gap-1 font-semibold text-ink-muted">
              <AlarmClock className="h-3.5 w-3.5 text-primary" />
              {job.scheduleKind === 'once'
                ? `Once at ${fmt(job.runAt)}`
                : humanizeCron(job.cron, job.timezone)}
            </span>
            {next && job.status === 'active' && (
              <span className="rounded-pill bg-primary-soft px-2 py-px font-semibold text-primary">
                next {next}
              </span>
            )}
            <span>last: {fmt(job.lastRunAt)}</span>

            {/* Run strip — newest first, hoverable, click to jump to the run. */}
            {job.runs.length > 0 && (
              <span className="inline-flex items-center gap-1">
                {job.runs.slice(0, 10).map((r) => {
                  const when = relative(r.started_at, now);
                  const took = runDuration(r.started_at, r.finished_at);
                  const label = `${r.status === 'ok' ? 'Succeeded' : r.status === 'error' ? 'Failed' : 'Running'}${
                    when ? ` · ${when}` : ''
                  }${took ? ` · ${took}` : ''}`;
                  return (
                    <span key={r.id} className="group/dot relative inline-flex">
                      <button
                        type="button"
                        onClick={() => onSelectRun(r)}
                        aria-label={label}
                        className={clsx(
                          'h-2.5 w-2.5 rounded-full transition hover:scale-125 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                          RUN_DOT[r.status],
                        )}
                      />
                      {/* Below the dot on purpose: the card clips overflow. */}
                      <span className="pointer-events-none absolute left-1/2 top-full z-20 mt-1.5 hidden -translate-x-1/2 whitespace-nowrap rounded-[8px] bg-ink px-2 py-1 text-[10.5px] font-semibold text-surface shadow-pop group-hover/dot:block group-focus-within/dot:block">
                        {label}
                      </span>
                    </span>
                  );
                })}
              </span>
            )}
          </div>

          {job.recipients.length > 0 && (
            <div
              className="mt-1 flex items-center gap-1 truncate text-[11.5px] text-ink-faint"
              title={job.recipients.join(', ')}
            >
              <Mail className="h-3 w-3 shrink-0" />
              <span className="truncate">Emails: {job.recipients.join(', ')}</span>
            </div>
          )}

          {/* Last result, right on the collapsed card. */}
          {lastRun ? (
            preview ? (
              <button
                type="button"
                onClick={() => onOpenRun(lastRun)}
                className="mt-2 block w-full rounded-[10px] bg-surface-2 px-3 py-2 text-left transition hover:bg-canvas focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <span
                  className={clsx(
                    'line-clamp-2 text-[12px] leading-relaxed',
                    lastRun.error ? 'text-rose' : 'text-ink-muted',
                  )}
                >
                  {preview}
                </span>
              </button>
            ) : null
          ) : (
            <p className="mt-2 text-[11.5px] italic text-ink-faint">Never run — try Run now.</p>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1">
          <button
            type="button"
            disabled={running || job.status !== 'active'}
            onClick={onRunNow}
            className="inline-flex items-center gap-1.5 rounded-[10px] bg-primary px-2.5 py-1.5 text-[11.5px] font-semibold text-white transition hover:bg-primary-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
            title={
              job.status === 'active'
                ? 'Run this routine now'
                : `Only active routines can be run (this one is ${job.status})`
            }
          >
            {running ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Running…
              </>
            ) : (
              <>
                <Play className="h-3.5 w-3.5" /> Run now
              </>
            )}
          </button>

          {canEdit && (
            <button
              type="button"
              onClick={onEdit}
              className={clsx(ICON_BTN, 'text-ink-faint hover:bg-surface-2 hover:text-ink')}
              title="Edit name, schedule and recipients"
              aria-label="Edit routine"
            >
              <Pencil className="h-4 w-4" />
            </button>
          )}

          {job.conversationId && (
            <Link
              href={`/chat/${job.conversationId}`}
              className={clsx(ICON_BTN, 'text-ink-faint hover:bg-surface-2 hover:text-ink')}
              title="Open results conversation"
            >
              <MessageSquare className="h-4 w-4" />
            </Link>
          )}

          {job.status === 'active' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onAction('pause')}
              className={clsx(ICON_BTN, 'text-ink-faint hover:bg-surface-2 hover:text-ink')}
              title="Pause"
            >
              <Pause className="h-4 w-4" />
            </button>
          )}
          {job.status === 'paused' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onAction('resume')}
              className={clsx(ICON_BTN, 'text-emerald hover:bg-emerald-soft')}
              title="Resume"
            >
              <Play className="h-4 w-4" />
            </button>
          )}
          {(job.status === 'active' || job.status === 'paused') && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onAction('cancel')}
              className={clsx(ICON_BTN, 'text-rose hover:bg-rose-soft')}
              title="Cancel permanently"
            >
              <X className="h-4 w-4" />
            </button>
          )}
          <button
            type="button"
            onClick={onToggle}
            className={clsx(ICON_BTN, 'text-ink-faint hover:bg-surface-2 hover:text-ink')}
            aria-label={expanded ? 'Collapse' : 'Expand'}
            aria-expanded={expanded}
          >
            <ChevronDown
              className={clsx('h-4 w-4 transition-transform', expanded && 'rotate-180')}
            />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="space-y-3 border-t border-border bg-canvas/50 px-4 py-3.5">
          {(job.instruction ?? job.toolId) && (
            <div>
              <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
                {job.kind === 'agent' ? 'Instruction' : 'Tool'}
              </h3>
              <p className="whitespace-pre-wrap rounded-[10px] bg-surface-2 px-3 py-2 text-[12.5px] leading-relaxed text-ink-muted">
                {job.instruction ?? job.toolId}
              </p>
            </div>
          )}
          <div>
            <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
              Recent runs
            </h3>
            {job.runs.length === 0 ? (
              <p className="text-[12.5px] text-ink-faint">
                Never run yet — hit <span className="font-semibold text-ink-muted">Run now</span> to
                see what it produces.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {job.runs.map((run) => {
                  const took = runDuration(run.started_at, run.finished_at);
                  const when = relative(run.started_at, now);
                  return (
                    <li key={run.id} id={`run-${run.id}`}>
                      <button
                        type="button"
                        onClick={() => onOpenRun(run)}
                        className={clsx(
                          'block w-full rounded-[10px] border bg-surface px-3 py-2 text-left text-[12px] transition hover:border-border-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                          highlightRunId === run.id
                            ? 'border-primary ring-2 ring-primary-soft'
                            : 'border-border',
                        )}
                      >
                        <span className="flex flex-wrap items-center gap-2">
                          <span
                            className={clsx(
                              'rounded-pill px-1.5 py-0.5 text-[10px] font-bold uppercase',
                              RUN_PILL[run.status],
                            )}
                          >
                            {run.status}
                          </span>
                          <span className="text-ink-faint">{fmt(run.started_at)}</span>
                          {when && <span className="text-ink-faint">· {when}</span>}
                          {took && (
                            <span className="text-ink-faint" title="Run duration">
                              · took {took}
                            </span>
                          )}
                        </span>
                        {(run.error ?? run.output) && (
                          <span
                            className={clsx(
                              'mt-1.5 line-clamp-3 block whitespace-pre-wrap text-[11.5px] leading-relaxed',
                              run.error ? 'text-rose' : 'text-ink-muted',
                            )}
                          >
                            {run.error ?? run.output}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
