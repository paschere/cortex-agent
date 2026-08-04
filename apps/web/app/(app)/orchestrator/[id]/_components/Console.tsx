'use client';

import { Panel } from '@/components/ui/panel';
import { Provenance } from '@/components/ui/provenance';
import {
  type ConsoleState,
  applyEvent,
  initialConsoleState,
} from '@/lib/orchestrator/console-state';
import { computeWaves } from '@/lib/orchestrator/graph';
import { type EventView, type RunView, type TaskView, isTerminal } from '@/lib/orchestrator/types';
import { clsx } from 'clsx';
import {
  ArrowLeft,
  CircleStop,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RunMarkdown } from '../../../schedules/_components/RunMarkdown';
import { RunStatusPill, elapsedMs, formatDuration } from '../../_components/status';
import { TaskCard } from './TaskCard';

/**
 * The live console.
 *
 * The server renders whatever the log already contains; this component picks up
 * from that exact cursor over SSE and folds every new event into the same view
 * model (lib/orchestrator/console-state). Nothing here re-fetches the run, so a
 * ten-minute orchestration costs one HTTP connection, not six hundred polls.
 */

type Connection = 'live' | 'reconnecting' | 'closed';

/** A clock that only ticks while something is actually moving. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function CancelButton({ runId, onCancelled }: { runId: string; onCancelled: () => void }) {
  const [busy, setBusy] = useState(false);

  async function cancel() {
    if (
      !window.confirm(
        'Stop this run?\n\nSub-agents already working finish their current step; nothing new is started.',
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await fetch(`/api/orchestrator/${runId}/cancel`, { method: 'POST' });
      onCancelled();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void cancel()}
      disabled={busy}
      className="inline-flex items-center gap-1.5 rounded-card border border-border-strong bg-surface px-3 py-1.5 text-[12.5px] font-semibold text-rose transition-colors hover:bg-rose-soft disabled:opacity-60"
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
      ) : (
        <CircleStop className="h-3.5 w-3.5" />
      )}
      Stop
    </button>
  );
}

function ConnectionDot({ connection, active }: { connection: Connection; active: boolean }) {
  if (!active) return null;
  const label =
    connection === 'live'
      ? 'Live'
      : connection === 'reconnecting'
        ? 'Reconnecting…'
        : 'Disconnected';
  return (
    <span className="field-label inline-flex items-center gap-1.5">
      <span
        className={clsx(
          'h-1.5 w-1.5 rounded-full',
          connection === 'live'
            ? 'bg-emerald'
            : connection === 'reconnecting'
              ? 'bg-amber'
              : 'bg-ink-faint',
        )}
      />
      {label}
    </span>
  );
}

export function Console({
  run: initialRun,
  tasks: initialTasks,
  events: initialEvents,
}: {
  run: RunView;
  tasks: TaskView[];
  events: EventView[];
}) {
  const [state, setState] = useState<ConsoleState>(() =>
    initialConsoleState(initialRun, initialTasks, initialEvents),
  );
  const [connection, setConnection] = useState<Connection>('live');
  // Bumped to force a fresh EventSource when the server ends a stream while the
  // run is still going (the endpoint caps how long it holds one connection).
  const [generation, setGeneration] = useState(0);

  const active = !isTerminal(state.run.status);
  const now = useNow(active);

  // The reader lives in a long-lived effect, so the cursor is kept in a ref:
  // putting it in the dependency list would tear down and rebuild the stream on
  // every single event.
  const cursorRef = useRef(state.lastEventId);
  cursorRef.current = state.lastEventId;

  const runId = state.run.id;

  // `generation` is never read inside the effect — it IS the trigger. Bumping it
  // is how the console asks for a brand-new EventSource after the server closed
  // one on its own timer, and with an unchanged runId there is no other way to
  // make this effect run again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional re-run trigger, see above
  useEffect(() => {
    if (!active) {
      setConnection('closed');
      return;
    }

    const source = new EventSource(`/api/orchestrator/${runId}/events?after=${cursorRef.current}`);
    let stopped = false;

    source.onopen = () => setConnection('live');
    source.onerror = () => {
      // EventSource retries by itself; say so rather than showing a dead page.
      if (!stopped) setConnection('reconnecting');
    };
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as EventView;
        setState((prev) => applyEvent(prev, event));
        setConnection('live');
      } catch {
        // A malformed frame is not worth killing the console over.
      }
    };
    source.addEventListener('closed', (message) => {
      stopped = true;
      source.close();
      const data = JSON.parse((message as MessageEvent).data ?? '{}') as { status?: string };
      // The server closed because it hit its own time cap, not because the run
      // ended — reconnect from where we stopped.
      if (data.status && !isTerminal(data.status as RunView['status'])) {
        setGeneration((g) => g + 1);
      } else {
        setConnection('closed');
      }
    });

    return () => {
      stopped = true;
      source.close();
    };
  }, [runId, active, generation]);

  const markCancelled = useCallback(() => {
    setState((prev) => ({ ...prev, run: { ...prev.run, status: 'cancelled' } }));
  }, []);

  const { tasks, toolCalls, run } = state;

  const waves = useMemo(
    () => computeWaves(tasks.map((t) => ({ seq: t.seq, dependsOn: t.dependsOn }))),
    [tasks],
  );

  const grouped = useMemo(() => {
    const map = new Map<number, TaskView[]>();
    for (const task of [...tasks].sort((a, b) => a.seq - b.seq)) {
      const wave = waves.get(task.seq) ?? 1;
      map.set(wave, [...(map.get(wave) ?? []), task]);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [tasks, waves]);

  const done = tasks.filter((t) => t.status === 'completed').length;
  const settled = tasks.filter((t) => t.status !== 'pending' && t.status !== 'running').length;
  const progress = tasks.length > 0 ? Math.round((settled / tasks.length) * 100) : 0;
  const duration = elapsedMs(run.startedAt ?? run.createdAt, run.finishedAt, now);
  const toolCallCount = Object.values(toolCalls).reduce((sum, list) => sum + list.length, 0);
  const planning = run.status === 'planning';

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-3">
        <Link
          href="/orchestrator"
          className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-faint transition-colors hover:text-ink"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Orchestrator
        </Link>
        <ConnectionDot connection={connection} active={active} />
      </div>

      {/* The run's masthead: objective, then its figures in a ruled meter strip. */}
      <div className="rule-double mb-5 pt-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1 basis-[20rem]">
            <div className="field-label">Objective</div>
            <h1 className="mt-1 text-[19px] font-extrabold leading-snug tracking-tight text-ink">
              {run.objective}
            </h1>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <RunStatusPill status={run.status} />
            {active && <CancelButton runId={run.id} onCancelled={markCancelled} />}
            {!active && (
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="inline-flex items-center gap-1.5 rounded-card border border-border-strong bg-surface px-3 py-1.5 text-[12.5px] font-semibold text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
              >
                <RefreshCw className="h-3.5 w-3.5" /> Refresh
              </button>
            )}
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-px border border-border bg-border sm:grid-cols-4">
          <Meter label="Sub-agents" value={String(tasks.length)} />
          <Meter label="Elapsed" value={formatDuration(duration)} />
          <Meter label="Tool calls" value={toolCallCount.toLocaleString()} />
          <Meter
            label="Tokens"
            value={run.totalTokens > 0 ? run.totalTokens.toLocaleString() : '—'}
          />
        </div>
      </div>

      {tasks.length > 0 && (
        <div className="mb-5">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="field-label">
              {done} of {tasks.length} done
            </span>
            <span className="tabular text-[11px] text-ink-muted">{progress}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden border border-border bg-surface-2">
            <div
              className="h-full bg-primary transition-[width] duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {state.error && (
        <Panel className="mb-5 border-rose/40 bg-rose-soft px-4 py-3">
          <p className="flex items-start gap-2 text-[12.5px] leading-relaxed text-rose">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0 break-words">
              {state.error} The sub-agents below show how far the run got before it stopped.
            </span>
          </p>
        </Panel>
      )}

      {planning && tasks.length === 0 && (
        <Panel className="mb-5 px-6 py-12 text-center">
          <Loader2 className="mx-auto mb-3 h-6 w-6 animate-spin text-primary motion-reduce:animate-none" />
          <h2 className="text-[14px] font-bold text-ink">Working out the plan</h2>
          <p className="mx-auto mt-1 max-w-sm text-[12.5px] leading-relaxed text-ink-muted">
            Cortex is deciding which specialists this needs and which of them can work at the same
            time. The manifest below fills in the moment it decides.
          </p>
        </Panel>
      )}

      {!planning && tasks.length === 0 && (
        <Panel className="mb-5 px-6 py-12 text-center">
          <h2 className="text-[14px] font-bold text-ink">No sub-agents ran</h2>
          <p className="mx-auto mt-1 max-w-sm text-[12.5px] leading-relaxed text-ink-muted">
            This run ended before the first task started, so there is nothing to inspect. Run the
            objective again, or reword it if it was ambiguous.
          </p>
        </Panel>
      )}

      {/*
       * The manifest. One section per wave, because the single most useful fact
       * while a run is live is which sub-agents are working at the same time —
       * a stacked list of cards hides exactly that.
       */}
      {grouped.map(([wave, waveTasks]) => {
        const parallel = waveTasks.length > 1;
        const runningHere = waveTasks.filter((t) => t.status === 'running').length;
        return (
          <section key={wave} className="mb-5">
            <div className="mb-2 flex items-center gap-2 border-b border-border-strong pb-1.5">
              <div className="field-label text-ink-muted">Wave {wave}</div>
              <div className="tabular text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                {parallel ? `${waveTasks.length} in parallel` : 'single agent'}
              </div>
              {runningHere > 0 && (
                <span className="tabular ml-auto inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.08em] text-primary">
                  <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />
                  {runningHere} working
                </span>
              )}
            </div>
            <div className={clsx('grid gap-3', parallel && 'lg:grid-cols-2')}>
              {waveTasks.map((task) => (
                <TaskCard key={task.id} task={task} calls={toolCalls[task.id] ?? []} now={now} />
              ))}
            </div>
          </section>
        );
      })}

      <Panel className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-strong px-4 py-3">
          <div className="field-label">Final report</div>
          {/* Real provenance: the report is Cortex's own assertion, and this
              says which run produced it and when that run stopped. */}
          {run.summary && run.finishedAt && (
            <Provenance
              source="Orchestrator"
              readAt={stamp(run.finishedAt)}
              detail={`${tasks.length} sub-agent${tasks.length === 1 ? '' : 's'}`}
              tone={run.status === 'failed' ? 'seal' : 'stamp'}
            />
          )}
        </div>
        <div className="px-4 py-4">
          {run.summary ? (
            <RunMarkdown>{run.summary}</RunMarkdown>
          ) : active ? (
            <p className="flex items-center gap-2 text-[12.5px] text-ink-faint">
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              Cortex writes this once every sub-agent has finished.
            </p>
          ) : (
            <p className="text-[12.5px] text-ink-muted">
              {run.status === 'cancelled'
                ? 'This run was stopped before a report was written. Each sub-agent above kept whatever it had found.'
                : 'This run produced no report. The sub-agents above show what it did reach.'}
            </p>
          )}
        </div>
      </Panel>
    </>
  );
}

/** One cell of the run's meter strip: a named box with a monospaced figure. */
function Meter({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface px-3 py-2">
      <div className="field-label">{label}</div>
      <div className="stat-num mt-0.5 truncate text-[16px] leading-none text-ink">{value}</div>
    </div>
  );
}

/** Compact absolute stamp for the provenance mark: "04 Aug 10:18". */
function stamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
