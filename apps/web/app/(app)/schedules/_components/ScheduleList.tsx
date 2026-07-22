'use client';

import { clsx } from 'clsx';
import {
  AlarmClock,
  Bot,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  Pause,
  Play,
  Wrench,
  X,
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
  runs: JobRun[];
}

const STATUS_STYLES: Record<ScheduledJob['status'], string> = {
  active: 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400',
  paused: 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-400',
  completed: 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400',
  cancelled: 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400',
};

function fmt(ts: string | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

function scheduleLabel(job: ScheduledJob): string {
  if (job.scheduleKind === 'once') return `Once at ${fmt(job.runAt)}`;
  return `Cron ${job.cron} (${job.timezone})`;
}

export function ScheduleList({ jobs }: { jobs: ScheduledJob[] }) {
  const router = useRouter();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      <section className="rounded-2xl border p-8 text-center text-sm text-neutral-500">
        <AlarmClock className="mx-auto mb-2 h-6 w-6" />
        No scheduled jobs yet. Ask an agent in chat, e.g.{' '}
        <em>&ldquo;todos los días a las 9am resume mis PRs abiertos&rdquo;</em>.
      </section>
    );
  }

  return (
    <div className="space-y-3">
      {error && (
        <div className="rounded bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-900/20 dark:text-red-400">
          {error}
        </div>
      )}
      {jobs.map((job) => {
        const isOpen = expanded === job.id;
        return (
          <section key={job.id} className="rounded-2xl border p-4">
            <div className="flex items-start justify-between gap-3">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-start gap-2 text-left"
                onClick={() => setExpanded(isOpen ? null : job.id)}
              >
                {isOpen ? (
                  <ChevronDown className="mt-1 h-4 w-4 shrink-0 text-neutral-400" />
                ) : (
                  <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-neutral-400" />
                )}
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{job.name}</span>
                    <span
                      className={clsx(
                        'rounded px-1.5 py-0.5 text-[11px] font-medium',
                        STATUS_STYLES[job.status],
                      )}
                    >
                      {job.status}
                    </span>
                    <span className="inline-flex items-center gap-1 text-[11px] text-neutral-500">
                      {job.kind === 'tool' ? (
                        <Wrench className="h-3 w-3" />
                      ) : (
                        <Bot className="h-3 w-3" />
                      )}
                      {job.kind === 'tool' ? job.toolId : 'agent turn'}
                    </span>
                    {job.allowUnattendedWrites && (
                      <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-700 dark:bg-amber-900/20 dark:text-amber-400">
                        writes allowed
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-neutral-500">
                    {scheduleLabel(job)} · next: {fmt(job.nextRunAt)} · last: {fmt(job.lastRunAt)}
                  </p>
                </div>
              </button>
              <div className="flex shrink-0 items-center gap-1">
                {job.conversationId && (
                  <Link
                    href={`/chat/${job.conversationId}`}
                    className="rounded p-1.5 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
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
                    className="rounded p-1.5 text-neutral-500 hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-800"
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
                    className="rounded p-1.5 text-neutral-500 hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-800"
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
                    className="rounded p-1.5 text-red-500 hover:bg-red-50 disabled:opacity-50 dark:hover:bg-red-900/20"
                    title="Cancel permanently"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>

            {isOpen && (
              <div className="mt-3 space-y-3 border-t pt-3">
                {job.instruction && (
                  <p className="whitespace-pre-wrap text-sm text-neutral-600 dark:text-neutral-300">
                    {job.instruction}
                  </p>
                )}
                <div>
                  <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                    Recent runs
                  </h3>
                  {job.runs.length === 0 ? (
                    <p className="mt-1 text-sm text-neutral-500">No runs yet.</p>
                  ) : (
                    <ul className="mt-1 space-y-1">
                      {job.runs.map((run) => (
                        <li key={run.id} className="rounded border px-2.5 py-1.5 text-xs">
                          <div className="flex items-center gap-2">
                            <span
                              className={clsx(
                                'rounded px-1 py-0.5 font-medium',
                                run.status === 'ok'
                                  ? 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400'
                                  : run.status === 'error'
                                    ? 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400'
                                    : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400',
                              )}
                            >
                              {run.status}
                            </span>
                            <span className="text-neutral-500">{fmt(run.started_at)}</span>
                          </div>
                          {(run.error ?? run.output) && (
                            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[11px] text-neutral-600 dark:text-neutral-300">
                              {run.error ?? run.output}
                            </pre>
                          )}
                        </li>
                      ))}
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
