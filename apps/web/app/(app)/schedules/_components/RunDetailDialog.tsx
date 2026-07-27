'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { clsx } from 'clsx';
import { Check, Copy, MessageSquare, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { RunOutput } from './RunMarkdown';
import { fmtLong, relative, runDuration } from './format';
import type { JobRun } from './types';

const RUN_STATUS_STYLES: Record<JobRun['status'], string> = {
  ok: 'bg-emerald-soft text-emerald',
  error: 'bg-rose-soft text-rose',
  running: 'bg-surface-2 text-ink-faint',
};

const RUN_STATUS_LABEL: Record<JobRun['status'], string> = {
  ok: 'succeeded',
  error: 'failed',
  running: 'running',
};

/** Full detail of a single run: timings, the whole output, and the error. */
export function RunDetailDialog({
  run,
  jobName,
  conversationId,
  now,
  onClose,
}: {
  run: JobRun | null;
  jobName: string;
  conversationId: string | null;
  now: number | null;
  onClose: () => void;
}) {
  // Keyed by run id so switching runs drops the "Copied" state for free.
  const [copiedRunId, setCopiedRunId] = useState<string | null>(null);
  const copied = copiedRunId !== null && copiedRunId === run?.id;

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopiedRunId(null), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  if (!run) return null;

  const took = runDuration(run.started_at, run.finished_at);
  const body = run.output ?? '';
  const when = relative(run.started_at, now);

  async function copyOutput() {
    if (!run) return;
    try {
      await navigator.clipboard.writeText(run.error ?? body);
      setCopiedRunId(run.id);
    } catch {
      setCopiedRunId(null);
    }
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[86vh] w-[min(680px,calc(100vw-1.5rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-card border border-border bg-surface shadow-pop outline-none">
          <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="truncate text-sm font-bold text-ink">{jobName}</Dialog.Title>
              <Dialog.Description className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-ink-faint">
                <span
                  className={clsx(
                    'rounded-pill px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                    RUN_STATUS_STYLES[run.status],
                  )}
                >
                  {RUN_STATUS_LABEL[run.status]}
                </span>
                <span>Started {fmtLong(run.started_at)}</span>
                {when && <span>· {when}</span>}
              </Dialog.Description>
            </div>
            <Dialog.Close
              className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>

          <div className="grid grid-cols-2 gap-px border-b border-border bg-border sm:grid-cols-3">
            <Meta label="Started" value={fmtLong(run.started_at)} />
            <Meta
              label="Finished"
              value={run.finished_at ? fmtLong(run.finished_at) : 'Still running'}
            />
            <Meta label="Duration" value={took ?? '—'} />
          </div>

          <div className="scroll-slim min-h-0 flex-1 overflow-auto px-5 py-4">
            {run.error && (
              <div className="mb-4">
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
                  Error
                </div>
                <p className="whitespace-pre-wrap rounded-[12px] border border-rose/30 bg-rose-soft px-3.5 py-2.5 text-[13px] leading-[1.65] text-rose">
                  {run.error}
                </p>
              </div>
            )}

            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
              Output
            </div>
            {body ? (
              <RunOutput text={body} className="rounded-[12px] bg-surface-2 px-3.5 py-3" />
            ) : (
              <p className="rounded-[12px] bg-surface-2 px-3.5 py-3 text-[13px] text-ink-faint">
                {run.status === 'running'
                  ? 'This run is still in flight — results land here when it finishes.'
                  : 'This run produced no output.'}
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-3">
            {conversationId ? (
              <Link
                href={`/chat/${conversationId}`}
                className="inline-flex items-center gap-1.5 rounded-[10px] px-2.5 py-1.5 text-[12px] font-semibold text-primary transition hover:bg-primary-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <MessageSquare className="h-3.5 w-3.5" /> Open results conversation
              </Link>
            ) : (
              <span className="text-[11.5px] text-ink-faint">
                No results conversation for this routine
              </span>
            )}
            <button
              type="button"
              onClick={copyOutput}
              disabled={!body && !run.error}
              className="inline-flex items-center gap-1.5 rounded-[10px] border border-border bg-surface px-2.5 py-1.5 text-[12px] font-semibold text-ink-muted transition hover:bg-surface-2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
            >
              {copied ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald" /> Copied
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" /> Copy output
                </>
              )}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface px-5 py-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
        {label}
      </div>
      <div className="mt-0.5 truncate text-[12px] font-semibold text-ink" title={value}>
        {value}
      </div>
    </div>
  );
}
