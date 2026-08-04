'use client';

import { Field } from '@/components/ui/provenance';
import { type StatusTone, chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import { Check, ChevronDown, Copy, History } from 'lucide-react';
import { useEffect, useState } from 'react';
import { LiveRelative } from './LiveRelative';
import { RunOutput } from './RunMarkdown';
import { fmtLong, runDuration } from './format';
import type { JobRun } from './types';

const TONE: Record<JobRun['status'], StatusTone> = {
  ok: 'emerald',
  error: 'rose',
  running: 'primary',
};

const LABEL: Record<JobRun['status'], string> = {
  ok: 'exitosa',
  error: 'falló',
  running: 'corriendo',
};

/**
 * The routine's whole run history, expandable in place. Outputs are agent
 * reports, so they render as markdown; errors are stack-ish text and stay
 * preformatted in rose.
 */
export function RunHistory({ runs }: { runs: JobRun[] }) {
  // The newest run is what people came for — open it by default.
  const [open, setOpen] = useState<Record<string, boolean>>(() =>
    runs[0] ? { [runs[0].id]: true } : {},
  );

  if (runs.length === 0) {
    return (
      <div className="rounded-card border border-dashed border-border-strong px-4 py-8 text-center">
        <History className="mx-auto mb-2 h-6 w-6 text-ink-faint" />
        <p className="text-[13px] font-semibold text-ink">Todavía no hay ejecuciones</p>
        <p className="mt-0.5 text-[12px] text-ink-muted">
          Dale <span className="font-semibold text-ink">Ejecutar ahora</span> arriba para ver qué
          produce esta rutina sin esperar a la hora programada.
        </p>
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {runs.map((run) => {
        const expanded = open[run.id] ?? false;
        const took = runDuration(run.started_at, run.finished_at);
        return (
          <li
            key={run.id}
            id={`run-${run.id}`}
            className="overflow-hidden rounded-card border border-border bg-surface"
          >
            <button
              type="button"
              onClick={() => setOpen((prev) => ({ ...prev, [run.id]: !expanded }))}
              aria-expanded={expanded}
              className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <span className={chipClass(TONE[run.status])}>{LABEL[run.status]}</span>
              <span className="tabular min-w-0 flex-1 truncate text-[12px] text-ink-muted">
                {fmtLong(run.started_at)}
                <span className="text-ink-faint">
                  {' · '}
                  <LiveRelative ts={run.started_at} fallback="" />
                </span>
              </span>
              <span
                className="tabular shrink-0 text-[11.5px] text-ink-faint"
                title="Duración de la ejecución"
              >
                {took ?? (run.status === 'running' ? 'en curso' : '—')}
              </span>
              <ChevronDown
                className={clsx(
                  'h-4 w-4 shrink-0 text-ink-faint transition-transform',
                  expanded && 'rotate-180',
                )}
              />
            </button>

            {expanded && (
              <div className="border-t border-border bg-canvas px-3 py-3">
                <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap gap-x-5 gap-y-1">
                    <Field label="Empezó">{fmtLong(run.started_at)}</Field>
                    <Field label="Terminó">
                      {run.finished_at ? fmtLong(run.finished_at) : 'sigue corriendo'}
                    </Field>
                    <Field label="Duración">{took ?? '—'}</Field>
                  </div>
                  <CopyRaw text={run.error ?? run.output ?? ''} />
                </div>

                {run.error && (
                  <div className="mb-3">
                    <div className="field-label mb-1.5">Error</div>
                    <pre className="scroll-slim overflow-x-auto whitespace-pre-wrap rounded-card border border-rose/40 bg-rose-soft px-3.5 py-2.5 font-mono text-[12px] leading-[1.6] text-rose">
                      {run.error}
                    </pre>
                  </div>
                )}

                {run.output ? (
                  <RunOutput
                    text={run.output}
                    className="rounded-card border border-border bg-surface px-3.5 py-3"
                  />
                ) : (
                  !run.error && (
                    <p className="rounded-card border border-border bg-surface px-3.5 py-3 text-[12.5px] text-ink-muted">
                      {run.status === 'running'
                        ? 'Sigue en curso. El resultado aparece aquí apenas termine.'
                        : 'Esta ejecución terminó sin escribir nada.'}
                    </p>
                  )
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function CopyRaw({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <button
      type="button"
      disabled={!text}
      // Deliberately the raw markdown, not the rendered text — people paste it on.
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
        } catch {
          setCopied(false);
        }
      }}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-card border border-border-strong bg-surface px-2.5 py-1 text-[11.5px] font-semibold text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
    >
      {copied ? (
        <>
          <Check className="h-3.5 w-3.5 text-emerald" /> Copiado
        </>
      ) : (
        <>
          <Copy className="h-3.5 w-3.5" /> Copiar sin formato
        </>
      )}
    </button>
  );
}
