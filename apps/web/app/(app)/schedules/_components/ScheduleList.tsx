'use client';

import { clsx } from 'clsx';
import {
  AlarmClock,
  Bot,
  ChevronDown,
  Globe,
  Loader2,
  MessageSquare,
  Pause,
  Play,
  Wrench,
  X,
  Mail,
  ShieldAlert,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export interface JobRun {
  id: string;
  status: 'running' | 'ok' | 'error';
  started_at: string;
  finished_at: string | null;
  output: string | null;
  error: string | null;
}

export interface ScheduledJob {
  id: string;
  name: string;
  kind: 'tool' | 'agent';
  toolId: string | null;
  instruction: string | null;
  scheduleKind: 'once' | 'cron';
  cron: string | null;
  timezone: string;
  runAt: string | null;
  status: 'active' | 'paused' | 'completed' | 'cancelled';
  nextRunAt: string | null;
  lastRunAt: string | null;
  allowUnattendedWrites: boolean;
  notifyEmail: boolean;
  conversationId: string | null;
  /** Explicit email recipients; empty means the results go to the owner. */
  recipients: string[];
  /** Owned by the workspace: visible to — and runnable by — the whole team. */
  isGlobal: boolean;
  runs: JobRun[];
}

const STATUS_STYLES: Record<ScheduledJob['status'], string> = {
  active: 'bg-emerald-soft text-emerald',
  paused: 'bg-amber-soft text-amber',
  completed: 'bg-surface-2 text-ink-faint',
  cancelled: 'bg-rose-soft text-rose',
};

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Humanize the common cron shapes; fall back to the raw expression. */
export function humanizeCron(cron: string | null, tz: string): string {
  if (!cron) return '—';
  const m = cron.trim().split(/\s+/);
  if (m.length !== 5) return `${cron} (${tz})`;
  const [min, hour, dom, , dow] = m as [string, string, string, string, string];
  const time =
    /^\d+$/.test(hour) && /^\d+$/.test(min)
      ? `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`
      : null;

  if (min.startsWith('*/') && hour === '*') return `Every ${min.slice(2)} min`;
  if (time && dom === '*' && dow === '*') return `Daily at ${time}`;
  if (time && dom === '*' && dow === '1-5') return `Weekdays at ${time}`;
  if (time && dom === '*' && /^\d$/.test(dow)) return `${DOW[Number(dow)]}s at ${time}`;
  if (time && /^\d+$/.test(dom) && dow === '*') return `Monthly on day ${dom} at ${time}`;
  return `${cron} (${tz})`;
}

function fmt(ts: string | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** How long a finished run took, e.g. "12.4s". Null while still running. */
function runDuration(startedAt: string, finishedAt: string | null): string | null {
  if (!finishedAt) return null;
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${Math.round(secs % 60)}s`;
}

function untilNext(ts: string | null): string | null {
  if (!ts) return null;
  const ms = new Date(ts).getTime() - Date.now();
  if (ms <= 0) return 'due now';
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `in ${hours}h ${mins % 60}m`;
  return `in ${Math.round(hours / 24)}d`;
}

export function ScheduleList({ jobs }: { jobs: ScheduledJob[] }) {
  const router = useRouter();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    if (action === 'cancel' && !window.confirm('Cancel this job permanently?')) return;
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
    } finally {
      setBusy(null);
    }
  }

  if (jobs.length === 0) {
    return (
      <section className="rounded-card border border-border bg-surface p-10 text-center text-[13px] text-ink-faint shadow-card">
        <AlarmClock className="mx-auto mb-3 h-8 w-8 text-primary" />
        <p className="mb-1 font-semibold text-ink">No routines yet</p>
        <p>
          Ask Zippy in{' '}
          <Link href="/chat" className="font-semibold text-primary hover:text-primary-strong">
            chat
          </Link>
          : <em>&ldquo;Every Friday at 4pm, send each client their active-candidates report.&rdquo;</em>
        </p>
      </section>
    );
  }

  return (
    <div className="space-y-3">
      {error && (
        <div className="rounded-[12px] border border-rose/30 bg-rose-soft px-3 py-2 text-[12.5px] text-rose">
          {error}
        </div>
      )}
      {jobs.map((job) => {
        const isOpen = expanded === job.id;
        const next = untilNext(job.nextRunAt);
        return (
          <section
            key={job.id}
            className="overflow-hidden rounded-card border border-border bg-surface shadow-card"
          >
            <div className="flex items-start gap-3 p-4">
              <span
                className={clsx(
                  'grid h-10 w-10 shrink-0 place-items-center rounded-[12px]',
                  job.status === 'active' ? 'bg-primary-soft text-primary' : 'bg-surface-2 text-ink-faint',
                )}
              >
                {job.kind === 'tool' ? <Wrench className="h-4.5 w-4.5" style={{ height: 18, width: 18 }} /> : <Bot style={{ height: 18, width: 18 }} />}
              </span>

              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => setExpanded(isOpen ? null : job.id)}
              >
                <div className="flex flex-wrap items-center gap-2">
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
                  {job.allowUnattendedWrites && (
                    <span
                      className="inline-flex items-center gap-1 rounded-pill bg-amber-soft px-2 py-0.5 text-[10.5px] font-bold text-amber"
                      title="This job may execute write tools without a human confirming each one"
                    >
                      <ShieldAlert className="h-3 w-3" /> unattended writes
                    </span>
                  )}
                  {job.notifyEmail && (
                    <span className="inline-flex items-center gap-1 text-[10.5px] text-ink-faint" title="Emails results">
                      <Mail className="h-3 w-3" />
                    </span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11.5px] text-ink-faint">
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
                  {/* run history dots, newest first */}
                  {job.runs.length > 0 && (
                    <span className="inline-flex items-center gap-1" title={`${job.runs.length} recent runs`}>
                      {job.runs.slice(0, 10).map((r) => (
                        <span
                          key={r.id}
                          className={clsx(
                            'h-2 w-2 rounded-full',
                            r.status === 'ok' ? 'bg-emerald' : r.status === 'error' ? 'bg-rose' : 'bg-ink-faint',
                          )}
                        />
                      ))}
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
              </button>

              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  disabled={running === job.id || job.status !== 'active'}
                  onClick={() => runNow(job.id)}
                  className="inline-flex items-center gap-1.5 rounded-[10px] bg-primary px-2.5 py-1.5 text-[11.5px] font-semibold text-white transition hover:bg-primary-strong disabled:opacity-50"
                  title={
                    job.status === 'active'
                      ? 'Run this routine now'
                      : `Only active routines can be run (this one is ${job.status})`
                  }
                >
                  {running === job.id ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Running…
                    </>
                  ) : (
                    <>
                      <Play className="h-3.5 w-3.5" /> Run now
                    </>
                  )}
                </button>
                {job.conversationId && (
                  <Link
                    href={`/chat/${job.conversationId}`}
                    className="rounded-[10px] p-1.5 text-ink-faint hover:bg-surface-2 hover:text-ink"
                    title="Open results conversation"
                  >
                    <MessageSquare className="h-4 w-4" />
                  </Link>
                )}
                {job.status === 'active' && (
                  <button
                    type="button"
                    disabled={busy === job.id}
                    onClick={() => act(job.id, 'pause')}
                    className="rounded-[10px] p-1.5 text-ink-faint hover:bg-surface-2 hover:text-ink disabled:opacity-50"
                    title="Pause"
                  >
                    <Pause className="h-4 w-4" />
                  </button>
                )}
                {job.status === 'paused' && (
                  <button
                    type="button"
                    disabled={busy === job.id}
                    onClick={() => act(job.id, 'resume')}
                    className="rounded-[10px] p-1.5 text-emerald hover:bg-emerald-soft disabled:opacity-50"
                    title="Resume"
                  >
                    <Play className="h-4 w-4" />
                  </button>
                )}
                {(job.status === 'active' || job.status === 'paused') && (
                  <button
                    type="button"
                    disabled={busy === job.id}
                    onClick={() => act(job.id, 'cancel')}
                    className="rounded-[10px] p-1.5 text-rose hover:bg-rose-soft disabled:opacity-50"
                    title="Cancel permanently"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : job.id)}
                  className="rounded-[10px] p-1.5 text-ink-faint hover:bg-surface-2 hover:text-ink"
                  aria-label={isOpen ? 'Collapse' : 'Expand'}
                >
                  <ChevronDown className={clsx('h-4 w-4 transition-transform', isOpen && 'rotate-180')} />
                </button>
              </div>
            </div>

            {isOpen && (
              <div className="space-y-3 border-t border-border bg-canvas/50 px-4 py-3.5">
                {(job.instruction ?? job.toolId) && (
                  <div>
                    <h3 className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
                      {job.kind === 'agent' ? 'Instruction' : 'Tool'}
                    </h3>
                    <p className="whitespace-pre-wrap rounded-[10px] bg-surface-2 px-3 py-2 text-[12.5px] leading-relaxed text-ink-muted">
                      {job.instruction ?? job.toolId}
                    </p>
                  </div>
                )}
                <div>
                  <h3 className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
                    Recent runs
                  </h3>
                  {job.runs.length === 0 ? (
                    <p className="text-[12.5px] text-ink-faint">No runs yet.</p>
                  ) : (
                    <ul className="space-y-1.5">
                      {job.runs.map((run) => {
                        const took = runDuration(run.started_at, run.finished_at);
                        return (
                          <li
                            key={run.id}
                            className="rounded-[10px] border border-border bg-surface px-3 py-2 text-[12px]"
                          >
                            <div className="flex items-center gap-2">
                              <span
                                className={clsx(
                                  'rounded-pill px-1.5 py-0.5 text-[10px] font-bold uppercase',
                                  run.status === 'ok'
                                    ? 'bg-emerald-soft text-emerald'
                                    : run.status === 'error'
                                      ? 'bg-rose-soft text-rose'
                                      : 'bg-surface-2 text-ink-faint',
                                )}
                              >
                                {run.status}
                              </span>
                              <span className="text-ink-faint">{fmt(run.started_at)}</span>
                              {took && (
                                <span className="text-ink-faint" title="Run duration">
                                  · took {took}
                                </span>
                              )}
                            </div>
                            {(run.error ?? run.output) && (
                              <pre className="scroll-slim mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap font-sans text-[11px] leading-relaxed text-ink-muted">
                                {run.error ?? run.output}
                              </pre>
                            )}
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
      })}
    </div>
  );
}
