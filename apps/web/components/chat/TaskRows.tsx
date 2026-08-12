'use client';

import { essentialArgs, formatDuration } from '@/lib/tool-args';
import { toolDisplayName } from '@/lib/tool-labels';
import type { ToolInvocation } from 'ai';
import { clsx } from 'clsx';
import { AlertCircle, Check, ChevronDown, Loader2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * WHAT CORTEX IS DOING, AS A LIST INSTEAD OF A STACK OF CARDS.
 *
 * ===========================================================================
 * THE DENSITY PROBLEM, WHICH IS THE WHOLE DESIGN
 * ===========================================================================
 * The card this replaces was fine for one tool call and wrong for twelve. Each
 * one was a bordered, shadowed, tinted block with its own chevron; a turn that
 * looked up three plates in two registries and then wrote a commitment
 * scrolled the actual answer off the screen behind a wall of chrome. The
 * information in those cards was right. The unit was wrong: a tool call is a
 * LINE ITEM, not a document.
 *
 * So a call is one row, about the height of a line of text, and the visual
 * weight lives on the group rather than on each member — one border around the
 * list, hairlines between rows, no per-row shadow or tint. Twelve calls is
 * then twelve lines, which is a paragraph, not a page.
 *
 * Three further things follow from the same constraint:
 *
 *   COLLAPSE PAST FIVE. A finished turn with more than five steps shows a
 *   summary line — how many, how long — with the rows one click away. Somebody
 *   re-reading a conversation wants the answer; somebody auditing wants the
 *   steps; the second is rarer, so it is the one that costs a click. While the
 *   turn is RUNNING the list is always open, because then the steps ARE the
 *   content — that is the only thing on screen.
 *
 *   ONE COLOUR, AND ONLY FOR FAILURE. Rose on the row that failed, and
 *   nothing on the rest. A dozen green ticks spends the reader's attention on
 *   everything that went right, which is precisely where it is not needed.
 *
 *   ARGUMENTS ON THE ROW, RESULTS BEHIND IT. What was asked fits on a line and
 *   is the part that tells you whether Cortex understood the question. What
 *   came back does not fit and is the part you only want when the answer looks
 *   wrong.
 *
 * ===========================================================================
 * WHERE THE DURATIONS COME FROM
 * ===========================================================================
 * Not from here. `audit_events` already holds one row per tool call with its
 * own `latency_ms`, written by `runTool`; `turn_latencies` already holds the
 * shape of the turn. Both are fetched once the turn is finished — see
 * `/api/chat/turn-metrics` — and matched positionally per tool id.
 *
 * While a call is still running there is no measurement yet, so the row shows a
 * COUNTER, labelled as elapsed time and set in the same monospace as every
 * other piece of evidence. It is not a second measurement competing with the
 * first: it is replaced by the real number the moment that number exists. The
 * alternative was a spinner with no number, and an eighteen-second RUNT lookup
 * behind a silent spinner is the exact dead air this product already learned
 * to fix once.
 */

const COLLAPSE_ABOVE = 5;

export interface TurnMetrics {
  firstVisibleMs: number | null;
  preludeMs: number;
  totalMs: number;
  toolCalls: number;
  toolMs: number;
  calls: Array<{ toolId: string; ms: number | null; status: string }>;
}

/**
 * Match the server's per-call rows onto the invocations on screen.
 *
 * `audit_events` predates the AI SDK's tool-call ids, so rows for the same tool
 * are told apart by ORDER: the nth row for a tool is the nth call to it. That
 * holds because `runTool` writes one row per call as it finishes, and it fails
 * safely — the worst case is a duration shown against the wrong call OF THE
 * SAME TOOL, never against a different tool and never a number nobody measured.
 */
export function matchDurations(
  invocations: readonly ToolInvocation[],
  metrics: TurnMetrics | null,
): Map<string, number | null> {
  const out = new Map<string, number | null>();
  if (!metrics) return out;

  const queues = new Map<string, number[]>();
  for (const call of metrics.calls) {
    const key = call.toolId.replaceAll('.', '_');
    const queue = queues.get(key) ?? [];
    queue.push(call.ms ?? Number.NaN);
    queues.set(key, queue);
  }

  for (const inv of invocations) {
    const queue = queues.get(inv.toolName.replaceAll('.', '_'));
    const next = queue?.shift();
    if (next !== undefined && Number.isFinite(next)) out.set(inv.toolCallId, next);
  }
  return out;
}

/** A live counter, in whole seconds, for a call that has not come back yet. */
function useElapsed(active: boolean): number {
  const [ms, setMs] = useState(0);
  const startedAt = useRef<number | null>(null);

  useEffect(() => {
    if (!active) {
      startedAt.current = null;
      setMs(0);
      return;
    }
    startedAt.current = performance.now();
    // One second, not sixteen frames a second: this is a progress signal, and a
    // digit flickering at 60Hz next to a paragraph somebody is reading is the
    // kind of motion the design system rules out. It is also why there is no
    // transition here for `prefers-reduced-motion` to have to switch off.
    const id = setInterval(() => {
      if (startedAt.current !== null) setMs(performance.now() - startedAt.current);
    }, 1000);
    return () => clearInterval(id);
  }, [active]);

  return ms;
}

function isErrorResult(inv: ToolInvocation): boolean {
  if (inv.state !== 'result') return false;
  const result = (inv as { result?: unknown }).result;
  return !!result && typeof result === 'object' && '__error' in (result as Record<string, unknown>);
}

function TaskRow({
  invocation,
  durationMs,
}: {
  invocation: ToolInvocation;
  durationMs: number | null | undefined;
}) {
  const [open, setOpen] = useState(false);
  const running = invocation.state === 'call' || invocation.state === 'partial-call';
  const failed = isErrorResult(invocation);
  const elapsed = useElapsed(running);

  const label = toolDisplayName(invocation.toolName);
  const args = useMemo(() => essentialArgs(invocation.args), [invocation.args]);
  const measured = formatDuration(durationMs ?? null);
  const shown = running ? formatDuration(elapsed >= 1000 ? elapsed : null) : measured;

  const result = invocation.state === 'result' ? (invocation as { result?: unknown }).result : undefined;
  const evidence =
    'scroll-slim mt-1 max-h-52 overflow-auto rounded-sm border border-border bg-surface-2 p-2.5 font-mono text-[10.5px] leading-relaxed text-ink-muted';

  return (
    <li className={clsx('border-t border-border first:border-t-0', failed && 'bg-rose-soft')}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="group flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors duration-150 hover:bg-surface-2 motion-reduce:transition-none"
      >
        <span className="grid h-4 w-4 shrink-0 place-items-center" aria-hidden>
          {running ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
          ) : failed ? (
            <AlertCircle className="h-3.5 w-3.5 text-rose" />
          ) : (
            <Check className="h-3 w-3 text-ink-faint" />
          )}
        </span>

        <span
          className={clsx(
            'shrink-0 text-[12.5px] font-medium',
            failed ? 'text-rose' : running ? 'text-ink' : 'text-ink-muted',
          )}
        >
          {label}
        </span>

        {args && (
          // The arguments are evidence — what Cortex actually asked — so they
          // get the monospace face, like every other checkable value.
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-faint">
            {args}
          </span>
        )}
        {!args && <span className="flex-1" />}

        {shown && (
          <span
            className="tabular shrink-0 text-[10.5px] text-ink-faint"
            title={running ? 'Tiempo transcurrido' : 'Medido en el servidor'}
          >
            {running ? `${shown}…` : shown}
          </span>
        )}

        <ChevronDown
          className={clsx(
            'h-3 w-3 shrink-0 text-ink-faint transition-transform duration-150 group-hover:text-primary motion-reduce:transition-none',
            open && 'rotate-180',
          )}
          aria-hidden
        />
      </button>

      {open && (
        <div className="space-y-2 px-3 pb-2.5 pl-9">
          {/* The raw id: what identifies this call in the audit log and in a
              support conversation. */}
          <div className="font-mono text-[10.5px] text-ink-faint">{invocation.toolName}</div>
          {invocation.args !== undefined && (
            <div>
              <div className="field-label">Argumentos</div>
              <pre className={evidence}>{JSON.stringify(invocation.args, null, 2)}</pre>
            </div>
          )}
          {result !== undefined && (
            <div>
              <div className="field-label">{failed ? 'Error' : 'Resultado'}</div>
              <pre className={evidence}>
                {typeof result === 'string' ? result : JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export function TaskRows({
  invocations,
  metrics,
  isStreaming,
}: {
  invocations: ToolInvocation[];
  metrics: TurnMetrics | null;
  isStreaming?: boolean;
}) {
  const durations = useMemo(() => matchDurations(invocations, metrics), [invocations, metrics]);
  const failures = invocations.filter(isErrorResult).length;
  const running = invocations.some((i) => i.state !== 'result');

  // Open while it is happening, and while anything went wrong — a failed step
  // hidden behind a disclosure is a failed step nobody sees.
  const shouldCollapse = !isStreaming && !running && failures === 0 && invocations.length > COLLAPSE_ABOVE;
  const [open, setOpen] = useState(!shouldCollapse);
  useEffect(() => {
    if (!shouldCollapse) setOpen(true);
  }, [shouldCollapse]);

  if (invocations.length === 0) return null;

  const totalLabel = formatDuration(metrics?.toolMs ?? null);
  const currentLabel = running
    ? toolDisplayName(
        invocations.filter((i) => i.state !== 'result').slice(-1)[0]?.toolName ?? '',
      )
    : null;

  return (
    <div className="mt-2 overflow-hidden rounded-card border border-border bg-surface shadow-card">
      {/*
        A screen reader is told what is happening now, in words, and is NOT read
        the whole list every time a row lands — `aria-live` sits on this one
        line rather than on the list, so twelve tool calls announce twelve short
        sentences instead of twelve growing lists.
      */}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {running && currentLabel
          ? `Cortex está usando: ${currentLabel}.`
          : failures > 0
            ? `Cortex terminó ${invocations.length} pasos, ${failures} con error.`
            : `Cortex terminó ${invocations.length} ${invocations.length === 1 ? 'paso' : 'pasos'}.`}
      </p>

      {(shouldCollapse || !open) && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-ink-muted transition-colors duration-150 hover:bg-surface-2 motion-reduce:transition-none"
        >
          <Check className="h-3 w-3 shrink-0 text-ink-faint" aria-hidden />
          <span>
            {invocations.length} {invocations.length === 1 ? 'paso' : 'pasos'}
          </span>
          {totalLabel && (
            <span className="tabular text-ink-faint">· {totalLabel} en herramientas</span>
          )}
          <ChevronDown
            className={clsx(
              'ml-auto h-3 w-3 shrink-0 text-ink-faint transition-transform duration-150 motion-reduce:transition-none',
              open && 'rotate-180',
            )}
            aria-hidden
          />
        </button>
      )}

      {open && (
        <ul className="list-none">
          {invocations.map((inv) => (
            <TaskRow
              key={inv.toolCallId}
              invocation={inv}
              durationMs={durations.get(inv.toolCallId)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
