'use client';

import { toolDisplayName } from '@/lib/tool-labels';
import type { ToolInvocation } from 'ai';
import { clsx } from 'clsx';
import { AlertCircle, CheckCircle2, ChevronDown, Loader2 } from 'lucide-react';
import { useState } from 'react';

/**
 * The record of a tool run, entered in the transcript.
 *
 * What goes in and what comes back is evidence — it is the only place a person
 * can check that Cortex asked the right question of the right system — so both
 * are set in monospace under labels that name them.
 *
 * Only the failure is tinted. A conversation with a dozen successful lookups
 * used to render as a wall of green, which spends the reader's attention on
 * the things that went right; a quiet card carrying one coloured edge keeps
 * the eye free for the one that did not.
 */
export function ToolCallCard({ invocation }: { invocation: ToolInvocation }) {
  const [open, setOpen] = useState(false);
  const label = toolDisplayName(invocation.toolName);
  const isRunning = invocation.state === 'call' || invocation.state === 'partial-call';
  const result = invocation.state === 'result' ? invocation.result : undefined;
  const isError =
    invocation.state === 'result' &&
    !!result &&
    typeof result === 'object' &&
    '__error' in (result as Record<string, unknown>);

  const evidence =
    'scroll-slim max-h-56 overflow-auto rounded-sm border border-border bg-surface-2 p-2.5 font-mono text-[10.5px] leading-relaxed text-ink-muted';

  return (
    <div
      className={clsx(
        'group rounded-card border border-l-2 text-xs shadow-card',
        isError
          ? 'border-rose/40 border-l-rose bg-rose-soft'
          : isRunning
            ? 'border-border border-l-amber bg-surface'
            : 'border-border border-l-emerald bg-surface',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-card px-3 py-2 text-left transition-colors duration-150 motion-reduce:transition-none"
      >
        {isRunning ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-amber" />
        ) : isError ? (
          <AlertCircle className="h-3.5 w-3.5 shrink-0 text-rose" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald" />
        )}
        <span className="min-w-0 truncate font-semibold text-ink">{label}</span>
        {/* The raw tool id, not the friendly label: it is what identifies the
            call in the audit log and in a support conversation. */}
        <span className="tabular ml-auto hidden truncate text-[10px] text-ink-faint sm:block">
          {invocation.toolName}
        </span>
        <ChevronDown
          className={clsx(
            'h-3.5 w-3.5 shrink-0 text-ink-faint transition-transform duration-150 group-hover:text-primary motion-reduce:transition-none',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && (
        <div className="space-y-2 px-3 pb-2.5">
          {invocation.args !== undefined && (
            <div>
              <div className="field-label">Argumentos</div>
              <pre className={clsx(evidence, 'mt-1')}>
                {JSON.stringify(invocation.args, null, 2)}
              </pre>
            </div>
          )}
          {invocation.state === 'result' && result !== undefined && (
            <div>
              <div className="field-label">{isError ? 'Error' : 'Resultado'}</div>
              <pre className={clsx(evidence, 'mt-1')}>
                {typeof result === 'string' ? result : JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
