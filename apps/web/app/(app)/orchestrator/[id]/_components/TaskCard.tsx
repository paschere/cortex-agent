'use client';

import { Provenance } from '@/components/ui/provenance';
import type { ToolCallEntry } from '@/lib/orchestrator/console-state';
import type { TaskView } from '@/lib/orchestrator/types';
import { CHIP_BASE, CHIP_TONE } from '@/lib/status-chip';
import { clsx } from 'clsx';
import { ChevronDown, ChevronRight, CircleX, Loader2, TriangleAlert, Wrench } from 'lucide-react';
import { useState } from 'react';
import { RunMarkdown } from '../../../schedules/_components/RunMarkdown';
import { TASK_TONE, TaskStatusIcon, elapsedMs, formatDuration } from '../../_components/status';

/**
 * One sub-agent, as a line on the manifest.
 *
 * Everything a person asks while a run is in flight — is it moving, what is it
 * touching, did it work — has to be answerable without opening anything. So the
 * tool calls are always visible as a list, and only their arguments and output
 * hide behind a disclosure: the trail stays whole, the evidence folds away.
 */

function ToolCallRow({ call }: { call: ToolCallEntry }) {
  const [open, setOpen] = useState(false);
  const pending = call.ok === null;
  const failed = call.ok === false;

  return (
    <li className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-surface-2"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-ink-faint" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-ink-faint" />
        )}
        <span
          className={clsx(
            'shrink-0',
            pending ? 'text-primary' : failed ? 'text-rose' : 'text-emerald',
          )}
        >
          {pending ? (
            <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />
          ) : failed ? (
            <CircleX className="h-3 w-3" />
          ) : (
            <Wrench className="h-3 w-3" />
          )}
        </span>
        <code className="shrink-0 font-mono text-micro font-semibold text-ink">
          {call.toolId}
        </code>
        <span className="min-w-0 flex-1 truncate font-mono text-micro text-ink-faint">
          {call.args}
        </span>
        {call.durationMs !== null && (
          <span className="tabular shrink-0 text-micro text-ink-faint">
            {formatDuration(call.durationMs)}
          </span>
        )}
      </button>

      {open && (
        <div className="border-t border-border bg-canvas px-2.5 py-2">
          <div className="field-label">Argumentos</div>
          <pre className="scroll-slim mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-border bg-surface p-2 font-mono text-micro leading-relaxed text-ink-muted">
            {call.args || '(ninguno)'}
          </pre>
          <div className="field-label mt-2">{failed ? 'Error' : 'Resultado'}</div>
          <pre
            className={clsx(
              'scroll-slim mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-sm border p-2 font-mono text-micro leading-relaxed',
              failed
                ? 'border-rose/40 bg-rose-soft text-rose'
                : 'border-border bg-surface text-ink-muted',
            )}
          >
            {call.preview ?? (pending ? 'Todavía corriendo…' : '(vacío)')}
          </pre>
        </div>
      )}
    </li>
  );
}

export function TaskCard({
  task,
  calls,
  now,
}: {
  task: TaskView;
  calls: ToolCallEntry[];
  now: number;
}) {
  const [showAnswer, setShowAnswer] = useState(false);
  const [showBrief, setShowBrief] = useState(false);
  const tone = TASK_TONE[task.status];
  const duration = elapsedMs(task.startedAt, task.finishedAt, now);
  const running = task.status === 'running';
  const settled = task.status === 'completed' || task.status === 'failed';

  // The stamp only goes on a task that actually read something from a tool —
  // an unattributed sub-agent has no provenance to show, so it gets no mark.
  const distinctTools = [...new Set(calls.map((c) => c.toolId))];
  const evidence =
    settled && calls.length > 0
      ? {
          source:
            distinctTools.length === 1
              ? (distinctTools[0] as string)
              : `${distinctTools.length} herramientas`,
          detail: `${calls.length} ${calls.length === 1 ? 'llamada' : 'llamadas'}`,
        }
      : null;

  return (
    <div
      className={clsx(
        'flex flex-col rounded-card border bg-surface shadow-card transition-colors',
        tone.ring,
        running && 'border-l-2 border-l-primary',
      )}
    >
      <div className="flex items-start gap-2.5 p-3.5">
        <TaskStatusIcon status={task.status} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="tabular text-micro font-semibold text-ink-faint">
              #{String(task.seq).padStart(2, '0')}
            </span>
            <h3 className="text-sm font-bold leading-snug text-ink">{task.title}</h3>
          </div>
          <div className="tabular mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-ink-faint">
            {task.agentLabel && (
              <span className="font-semibold text-ink-muted">{task.agentLabel}</span>
            )}
            {task.dependsOn.length > 0 && (
              <span>
                después de {task.dependsOn.map((d) => `#${String(d).padStart(2, '0')}`).join(' ')}
              </span>
            )}
            {duration !== null && <span>{formatDuration(duration)}</span>}
            {task.tokens > 0 && <span>{task.tokens.toLocaleString()} tok</span>}
          </div>
        </div>
        <span className={clsx(CHIP_BASE, CHIP_TONE[tone.tone], 'shrink-0')}>{tone.label}</span>
      </div>

      {task.instruction && (
        <div className="px-3.5 pb-2.5">
          <p
            className={clsx(
              'text-xs leading-relaxed text-ink-muted',
              !showBrief && 'line-clamp-2',
            )}
          >
            {task.instruction}
          </p>
          {task.instruction.length > 140 && (
            <button
              type="button"
              onClick={() => setShowBrief((v) => !v)}
              className="mt-1 text-micro font-semibold text-primary hover:underline"
            >
              {showBrief ? 'Ocultar el encargo' : 'Leer el encargo completo'}
            </button>
          )}
        </div>
      )}

      {task.allowedTools.length > 0 && (
        <div className="flex flex-wrap gap-1 px-3.5 pb-2.5">
          {task.allowedTools.slice(0, 6).map((id) => (
            <span
              key={id}
              className="rounded-pill border border-border bg-surface-2 px-2 py-0.5 font-mono text-micro text-ink-muted"
            >
              {id}
            </span>
          ))}
          {task.allowedTools.length > 6 && (
            <span className="tabular px-1 py-0.5 text-micro text-ink-faint">
              +{task.allowedTools.length - 6}
            </span>
          )}
        </div>
      )}

      {calls.length > 0 && (
        <div className="border-t border-border">
          <div className="field-label flex items-center justify-between px-2.5 pt-2">
            <span>Herramientas ejecutadas</span>
            <span className="tabular">{calls.length}</span>
          </div>
          <ul className="mt-1 border-t border-border">
            {calls.map((call) => (
              <ToolCallRow key={call.callId} call={call} />
            ))}
          </ul>
        </div>
      )}

      {running && calls.length === 0 && (
        <div className="flex items-center gap-1.5 px-3.5 pb-3 text-micro text-ink-faint">
          <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />
          Pensando: todavía no ha llamado ninguna herramienta.
        </div>
      )}

      {task.error && (
        <p className="mx-3.5 mb-3 flex items-start gap-1.5 rounded-card border border-rose/40 bg-rose-soft px-2.5 py-1.5 text-micro leading-relaxed text-rose">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 break-words">{task.error}</span>
        </p>
      )}

      {(task.result || evidence) && (
        <div className="mt-auto border-t border-border px-3.5 py-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            {task.result ? (
              <button
                type="button"
                onClick={() => setShowAnswer((v) => !v)}
                aria-expanded={showAnswer}
                className="inline-flex items-center gap-1 text-micro font-semibold text-primary hover:underline"
              >
                {showAnswer ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
                {showAnswer ? 'Ocultar la respuesta' : 'Leer la respuesta'}
              </button>
            ) : (
              <span />
            )}
            {evidence && (
              <Provenance
                source={evidence.source}
                readAt={task.finishedAt ? stamp(task.finishedAt) : undefined}
                detail={evidence.detail}
                tone={task.status === 'failed' ? 'seal' : 'stamp'}
              />
            )}
          </div>
          {task.result && showAnswer && (
            <div className="mt-2 rounded-card border border-border bg-canvas px-3 py-2">
              <RunMarkdown>{task.result}</RunMarkdown>
            </div>
          )}
        </div>
      )}
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
