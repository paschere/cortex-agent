'use client';

import type { ToolCallEntry } from '@/lib/orchestrator/console-state';
import type { TaskView } from '@/lib/orchestrator/types';
import { clsx } from 'clsx';
import { ChevronDown, ChevronRight, CircleX, Loader2, TriangleAlert, Wrench } from 'lucide-react';
import { useState } from 'react';
import { RunMarkdown } from '../../../schedules/_components/RunMarkdown';
import { TASK_TONE, TaskStatusIcon, elapsedMs, formatDuration } from '../../_components/status';

/**
 * One sub-agent, as a card.
 *
 * Everything a person asks while a run is in flight — is it moving, what is it
 * touching, did it work — has to be answerable without opening anything. So the
 * tool calls are always visible as a list, and only their arguments and output
 * hide behind a disclosure.
 */

function ToolCallRow({ call }: { call: ToolCallEntry }) {
  const [open, setOpen] = useState(false);
  const pending = call.ok === null;
  const failed = call.ok === false;

  return (
    <li className="rounded-[10px] border border-border bg-canvas">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-ink-faint" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-ink-faint" />
        )}
        <span
          className={clsx(
            'grid h-5 w-5 shrink-0 place-items-center rounded-[6px]',
            pending
              ? 'bg-primary-soft text-primary'
              : failed
                ? 'bg-rose-soft text-rose'
                : 'bg-emerald-soft text-emerald',
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
        <code className="shrink-0 text-[11.5px] font-semibold text-ink">{call.toolId}</code>
        <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-ink-faint">
          {call.args}
        </span>
        {call.durationMs !== null && (
          <span className="shrink-0 text-[10.5px] tabular-nums text-ink-faint">
            {formatDuration(call.durationMs)}
          </span>
        )}
      </button>

      {open && (
        <div className="border-t border-border px-2.5 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
            Arguments
          </div>
          <pre className="scroll-slim mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-[8px] bg-surface-2 p-2 font-mono text-[10.5px] leading-relaxed text-ink-muted">
            {call.args || '(none)'}
          </pre>
          <div className="mt-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
            {failed ? 'Error' : 'Result'}
          </div>
          <pre
            className={clsx(
              'scroll-slim mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-[8px] p-2 font-mono text-[10.5px] leading-relaxed',
              failed ? 'bg-rose-soft text-rose' : 'bg-surface-2 text-ink-muted',
            )}
          >
            {call.preview ?? (pending ? 'Still running…' : '(empty)')}
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

  return (
    <div
      className={clsx(
        'flex flex-col rounded-card border bg-surface p-3.5 shadow-card transition-colors',
        tone.ring,
        running && 'ring-4 ring-primary/10',
      )}
    >
      <div className="flex items-start gap-2.5">
        <TaskStatusIcon status={task.status} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[10.5px] font-bold tabular-nums text-ink-faint">#{task.seq}</span>
            <h3 className="text-[13.5px] font-bold leading-snug text-ink">{task.title}</h3>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px] text-ink-faint">
            {task.agentLabel && (
              <span className="rounded-pill bg-surface-2 px-1.5 py-0.5 font-semibold text-ink-muted">
                {task.agentLabel}
              </span>
            )}
            {task.dependsOn.length > 0 && (
              <span>after {task.dependsOn.map((d) => `#${d}`).join(', ')}</span>
            )}
            {duration !== null && <span className="tabular-nums">{formatDuration(duration)}</span>}
            {task.tokens > 0 && (
              <span className="tabular-nums">{task.tokens.toLocaleString()} tok</span>
            )}
          </div>
        </div>
        <span
          className={clsx('shrink-0 rounded-pill px-2 py-0.5 text-[10.5px] font-bold', tone.chip)}
        >
          {tone.label}
        </span>
      </div>

      {task.instruction && (
        <div className="mt-2.5">
          <p
            className={clsx(
              'text-[12px] leading-relaxed text-ink-muted',
              !showBrief && 'line-clamp-2',
            )}
          >
            {task.instruction}
          </p>
          {task.instruction.length > 140 && (
            <button
              type="button"
              onClick={() => setShowBrief((v) => !v)}
              className="mt-1 text-[11px] font-semibold text-primary hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              {showBrief ? 'Less' : 'Full brief'}
            </button>
          )}
        </div>
      )}

      {task.allowedTools.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1">
          {task.allowedTools.slice(0, 6).map((id) => (
            <span
              key={id}
              className="rounded-[6px] bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-ink-faint"
            >
              {id}
            </span>
          ))}
          {task.allowedTools.length > 6 && (
            <span className="px-1 text-[10px] text-ink-faint">+{task.allowedTools.length - 6}</span>
          )}
        </div>
      )}

      {calls.length > 0 && (
        <ul className="mt-2.5 flex flex-col gap-1">
          {calls.map((call) => (
            <ToolCallRow key={call.callId} call={call} />
          ))}
        </ul>
      )}

      {running && calls.length === 0 && (
        <div className="mt-2.5 flex items-center gap-1.5 text-[11.5px] text-ink-faint">
          <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" />
          Thinking…
        </div>
      )}

      {task.error && (
        <p className="mt-2.5 flex items-start gap-1.5 rounded-[10px] border border-rose/30 bg-rose-soft px-2.5 py-1.5 text-[11.5px] leading-relaxed text-rose">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 break-words">{task.error}</span>
        </p>
      )}

      {task.result && (
        <div className="mt-2.5">
          <button
            type="button"
            onClick={() => setShowAnswer((v) => !v)}
            className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-primary hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            {showAnswer ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            {showAnswer ? 'Hide answer' : 'Show answer'}
          </button>
          {showAnswer && (
            <div className="mt-1.5 rounded-[10px] border border-border bg-canvas px-3 py-2">
              <RunMarkdown>{task.result}</RunMarkdown>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
