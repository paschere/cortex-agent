'use client';

import { Panel } from '@/components/ui/panel';
import { Provenance } from '@/components/ui/provenance';
import {
  type ConsoleState,
  applyEvent,
  applyRunStatus,
  initialConsoleState,
} from '@/lib/orchestrator/console-state';
import { computeWaves } from '@/lib/orchestrator/graph';
import { QUIET_AFTER_MS, STALE_AFTER_MS, silenceMs } from '@/lib/orchestrator/liveness';
import { type EventView, type RunView, type TaskView, isTerminal } from '@/lib/orchestrator/types';
import { clsx } from 'clsx';
import { ArrowLeft, CircleStop, Loader2, RadioTower, RefreshCw, TriangleAlert } from 'lucide-react';
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

function CancelButton({
  runId,
  onCancelled,
}: { runId: string; onCancelled: (settling: boolean) => void }) {
  const [busy, setBusy] = useState(false);

  async function cancel() {
    if (
      !window.confirm(
        '¿Detener esta ejecución?\n\nLos subagentes que ya están trabajando terminan el paso en el que van; no se lanza nada nuevo.',
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/orchestrator/${runId}/cancel`, { method: 'POST' });
      // `settling` means sub-agents were mid-step when the stop landed. The
      // banner it turns on says so instead of implying the run froze on the
      // spot — a tool call already in flight cannot be un-sent.
      const body = (await res.json().catch(() => null)) as { settling?: boolean } | null;
      onCancelled(Boolean(body?.settling));
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void cancel()}
      disabled={busy}
      className="inline-flex items-center gap-1.5 rounded-pill border border-border-strong bg-surface px-3 py-1.5 text-[12.5px] font-semibold text-rose shadow-card transition-all duration-150 hover:-translate-y-px hover:bg-rose-soft disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none motion-reduce:transform-none motion-reduce:transition-none"
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
      ) : (
        <CircleStop className="h-3.5 w-3.5" />
      )}
      Detener
    </button>
  );
}

function ConnectionDot({ connection, active }: { connection: Connection; active: boolean }) {
  if (!active) return null;
  const label =
    connection === 'live'
      ? 'En vivo'
      : connection === 'reconnecting'
        ? 'Reconectando…'
        : 'Desconectado';
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
  const [settling, setSettling] = useState(false);

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
    // The run's own row, re-sent as the server polls. The log cannot report
    // that nothing is happening — this is what lets the pill stop claiming
    // "Ejecutando" over a run that went quiet.
    source.addEventListener('status', (message) => {
      try {
        const fresh = JSON.parse((message as MessageEvent).data ?? '{}') as {
          status?: string;
          lastHeartbeatAt?: string | null;
        };
        setState((prev) => applyRunStatus(prev, fresh));
      } catch {
        // A malformed frame is not worth killing the console over.
      }
    });
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

  const markCancelled = useCallback((wasSettling: boolean) => {
    setSettling(wasSettling);
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
  const quietMs = silenceMs(run, now);
  const quiet = quietMs !== null && quietMs >= QUIET_AFTER_MS;

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-3">
        <Link
          href="/orchestrator"
          className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-faint transition-colors hover:text-ink"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Orquestador
        </Link>
        <ConnectionDot connection={connection} active={active} />
      </div>

      {/* The run's masthead: objective, then its figures in a soft meter strip. */}
      <div className="rule-double" />
      <div className="mb-5 pt-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1 basis-[20rem]">
            <div className="field-label">Objetivo</div>
            <h1 className="mt-1 text-[19px] font-extrabold leading-snug tracking-tight text-ink">
              {run.objective}
            </h1>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <RunStatusPill status={run.status} quietMs={quietMs} />
            {active && <CancelButton runId={run.id} onCancelled={markCancelled} />}
            {!active && (
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="inline-flex items-center gap-1.5 rounded-pill border border-border-strong bg-surface px-3 py-1.5 text-[12.5px] font-semibold text-ink-muted shadow-card transition-all duration-150 hover:-translate-y-px hover:bg-surface-2 hover:text-ink motion-reduce:transform-none motion-reduce:transition-none"
              >
                <RefreshCw className="h-3.5 w-3.5" /> Actualizar
              </button>
            )}
          </div>
        </div>

        <Panel className="mt-3 overflow-hidden">
          <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-4">
            <Meter label="Subagentes" value={String(tasks.length)} />
            <Meter label="Transcurrido" value={formatDuration(duration)} />
            <Meter label="Herramientas" value={toolCallCount.toLocaleString()} />
            <Meter
              label="Tokens"
              value={run.totalTokens > 0 ? run.totalTokens.toLocaleString() : '—'}
            />
          </div>
        </Panel>
      </div>

      {tasks.length > 0 && (
        <div className="mb-5">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="field-label">
              {done} de {tasks.length} listos
            </span>
            <span className="tabular text-[11px] text-ink-muted">{progress}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {/*
       * Said out loud rather than hidden behind a spinner: the run claims to be
       * working and has not produced a single line in minutes. The barrido will
       * close it at STALE_AFTER_MS, and until then this is the only place the
       * truth can appear.
       */}
      {quiet && (
        <Panel className="mb-5 border-amber/40 bg-amber-soft px-4 py-3">
          <p className="flex items-start gap-2 text-[12.5px] leading-relaxed text-amber">
            <RadioTower className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0">
              Esta ejecución lleva {formatDuration(quietMs)} sin dar señales. Puede que un subagente
              esté en una llamada larga, o puede que se haya caído el proceso que la ejecutaba. Si
              sigue callada, a los {Math.round(STALE_AFTER_MS / 60_000)} minutos la damos por
              interrumpida y cerramos lo que alcanzó a producir.
            </span>
          </p>
        </Panel>
      )}

      {/*
       * Cancelling is cooperative and always was. Now that the executor lives
       * in Inngest the stop lands at the next step instead of the next wave —
       * sooner, not instant — and pretending otherwise would just move the lie.
       */}
      {settling && (
        <Panel className="mb-5 border-border-strong bg-surface-2 px-4 py-3">
          <p className="flex items-start gap-2 text-[12.5px] leading-relaxed text-ink-muted">
            <CircleStop className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" />
            <span className="min-w-0">
              Pedimos detenerla. No se lanza ningún subagente nuevo, pero los que estaban a mitad de
              una herramienta terminan ese paso: una llamada ya enviada no se puede devolver. Lo que
              alcancen a entregar queda guardado abajo.
            </span>
          </p>
        </Panel>
      )}

      {state.error && (
        <Panel className="mb-5 border-rose/40 bg-rose-soft px-4 py-3">
          <p className="flex items-start gap-2 text-[12.5px] leading-relaxed text-rose">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0 break-words">
              {state.error} Los subagentes de abajo muestran hasta dónde alcanzó a llegar.
            </span>
          </p>
        </Panel>
      )}

      {planning && tasks.length === 0 && (
        <Panel className="mb-5 px-6 py-12 text-center">
          <Loader2 className="mx-auto mb-3 h-6 w-6 animate-spin text-primary motion-reduce:animate-none" />
          <h2 className="text-[14px] font-bold text-ink">Armando el plan</h2>
          <p className="mx-auto mt-1 max-w-sm text-[12.5px] leading-relaxed text-ink-muted">
            Cortex está decidiendo qué especialistas necesita y cuáles pueden trabajar al tiempo. El
            manifiesto de abajo se llena apenas lo decida.
          </p>
        </Panel>
      )}

      {!planning && tasks.length === 0 && (
        <Panel className="mb-5 px-6 py-12 text-center">
          <h2 className="text-[14px] font-bold text-ink">No corrió ningún subagente</h2>
          <p className="mx-auto mt-1 max-w-sm text-[12.5px] leading-relaxed text-ink-muted">
            Esta ejecución terminó antes de arrancar la primera tarea, así que no hay nada que
            revisar. Vuelve a ejecutar el objetivo, o reescríbelo si quedó ambiguo.
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
            <div className="mb-2 flex items-center gap-2">
              <div className="field-label text-ink-muted">Ola {wave}</div>
              <div className="tabular text-[11px] text-ink-faint">
                {parallel ? `${waveTasks.length} en paralelo` : 'un solo agente'}
              </div>
              {runningHere > 0 && (
                <span className="tabular ml-auto inline-flex items-center gap-1 text-[11px] font-semibold text-primary">
                  <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />
                  {runningHere} trabajando
                </span>
              )}
            </div>
            <div className="rule-double mb-3" />
            <div className={clsx('grid gap-3', parallel && 'lg:grid-cols-2')}>
              {waveTasks.map((task) => (
                <TaskCard key={task.id} task={task} calls={toolCalls[task.id] ?? []} now={now} />
              ))}
            </div>
          </section>
        );
      })}

      <Panel className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
          <div className="field-label">Informe final</div>
          {/* Real provenance: the report is Cortex's own assertion, and this
              says which run produced it and when that run stopped. */}
          {run.summary && run.finishedAt && (
            <Provenance
              source="Orquestador"
              readAt={stamp(run.finishedAt)}
              detail={`${tasks.length} ${tasks.length === 1 ? 'subagente' : 'subagentes'}`}
              tone={run.status === 'failed' ? 'seal' : 'stamp'}
            />
          )}
        </div>
        <div className="rule-double" />
        <div className="px-4 py-4">
          {run.summary ? (
            <RunMarkdown>{run.summary}</RunMarkdown>
          ) : active ? (
            <p className="flex items-center gap-2 text-[12.5px] text-ink-faint">
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              Cortex lo escribe cuando todos los subagentes terminen.
            </p>
          ) : (
            <p className="text-[12.5px] text-ink-muted">
              {run.status === 'cancelled'
                ? 'La detuviste antes de que se escribiera el informe. Cada subagente de arriba conservó lo que alcanzó a encontrar.'
                : 'Esta ejecución no produjo informe. Los subagentes de arriba muestran hasta dónde llegó.'}
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
  return new Date(iso).toLocaleString('es-CO', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
