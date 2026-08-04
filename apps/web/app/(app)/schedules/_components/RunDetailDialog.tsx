'use client';

import { Provenance } from '@/components/ui/provenance';
import { type StatusTone, chipClass } from '@/lib/status-chip';
import * as Dialog from '@radix-ui/react-dialog';
import { Check, Copy, MessageSquare, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { RunOutput } from './RunMarkdown';
import { fmtLong, relative, runDuration } from './format';
import type { JobRun } from './types';

const RUN_STATUS_TONE: Record<JobRun['status'], StatusTone> = {
  ok: 'emerald',
  error: 'rose',
  running: 'primary',
};

const RUN_STATUS_LABEL: Record<JobRun['status'], string> = {
  ok: 'exitosa',
  error: 'falló',
  running: 'corriendo',
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
              <Dialog.Description className="tabular mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-ink-faint">
                <span className={chipClass(RUN_STATUS_TONE[run.status])}>
                  {RUN_STATUS_LABEL[run.status]}
                </span>
                <span>Empezó {fmtLong(run.started_at)}</span>
                {when && <span>· {when}</span>}
              </Dialog.Description>
              {/* The run is the system of record for this output: say when it
                  ran and how it ended, right above what it produced. */}
              <Provenance
                className="mt-2"
                source="Ejecución"
                readAt={fmtLong(run.started_at)}
                detail={took ? `${RUN_STATUS_LABEL[run.status]} en ${took}` : RUN_STATUS_LABEL[run.status]}
                tone={run.status === 'error' ? 'seal' : 'stamp'}
              />
            </div>
            <Dialog.Close
              className="grid h-8 w-8 shrink-0 place-items-center rounded-card text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              aria-label="Cerrar"
            >
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>

          <div className="grid grid-cols-2 gap-px border-b border-border bg-border sm:grid-cols-3">
            <Meta label="Empezó" value={fmtLong(run.started_at)} />
            <Meta
              label="Terminó"
              value={run.finished_at ? fmtLong(run.finished_at) : 'Sigue corriendo'}
            />
            <Meta label="Duración" value={took ?? '—'} />
          </div>

          <div className="scroll-slim min-h-0 flex-1 overflow-auto px-5 py-4">
            {run.error && (
              <div className="mb-4">
                <div className="field-label mb-1.5">Error</div>
                <p className="whitespace-pre-wrap rounded-card border border-rose/40 bg-rose-soft px-3.5 py-2.5 font-mono text-[12.5px] leading-[1.65] text-rose">
                  {run.error}
                </p>
              </div>
            )}

            <div className="field-label mb-1.5">Resultado</div>
            {body ? (
              <RunOutput
                text={body}
                className="rounded-card border border-border bg-surface-2 px-3.5 py-3"
              />
            ) : (
              <p className="rounded-card border border-border bg-surface-2 px-3.5 py-3 text-[13px] text-ink-muted">
                {run.status === 'running'
                  ? 'Sigue en curso. El resultado aparece aquí apenas termine.'
                  : 'Esta ejecución terminó sin escribir nada.'}
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-3">
            {conversationId ? (
              <Link
                href={`/chat/${conversationId}`}
                className="inline-flex items-center gap-1.5 rounded-card px-2.5 py-1.5 text-[12px] font-semibold text-primary transition-colors hover:bg-primary-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <MessageSquare className="h-3.5 w-3.5" /> Abrir la conversación
              </Link>
            ) : (
              <span className="text-[11.5px] text-ink-faint">
                Esta rutina no tiene conversación de resultados
              </span>
            )}
            <button
              type="button"
              onClick={copyOutput}
              disabled={!body && !run.error}
              className="inline-flex items-center gap-1.5 rounded-card border border-border-strong bg-surface px-2.5 py-1.5 text-[12px] font-semibold text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
            >
              {copied ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald" /> Copiado
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" /> Copiar el resultado
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
      <div className="field-label">{label}</div>
      <div className="tabular mt-0.5 truncate text-[12px] font-medium text-ink" title={value}>
        {value}
      </div>
    </div>
  );
}
