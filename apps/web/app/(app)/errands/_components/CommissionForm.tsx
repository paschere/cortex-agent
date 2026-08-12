'use client';

import { ERRAND_BOUNDARY_NOTICE } from '@/lib/errands/boundary';
import {
  DEFAULT_MONITOR_CADENCE_MINUTES,
  type ErrandKindSpec,
  MONITOR_CADENCES,
} from '@/lib/errands/kinds';
import type { ErrandKind } from '@/lib/errands/types';
import { clsx } from 'clsx';
import { CornerDownLeft, Loader2, ShieldCheck, Sparkles, TriangleAlert } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

/**
 * The commissioning desk.
 *
 * ── WHY THE KIND IS PICKED FIRST, AND NOT INFERRED ────────────────────────
 *
 * A single free-text box would be friendlier for about ten seconds. Then
 * somebody writes "consígueme un vuelo a Bogotá el martes" and gets back a
 * comparison of fares instead of a booking, and the product has broken a
 * promise it never made out loud. Picking the shape first is the promise made
 * out loud: these three things, done properly.
 *
 * It also makes the deliverable specific. A comparison, a dossier and a
 * reading are three different documents, and a system that does not know which
 * one it is writing writes the same wall of prose for all three.
 *
 * ── WHY THE LIMIT IS ON THE FORM AND NOT IN A HELP PAGE ───────────────────
 *
 * `ERRAND_BOUNDARY_NOTICE` sits under the button, where somebody about to hand
 * over an hour of autonomous work can read it. A boundary that only exists in
 * the code is a boundary the customer finds out about by being surprised.
 */

const MIN_CHARS = 10;

export function CommissionForm({ kinds }: { kinds: ErrandKindSpec[] }) {
  const router = useRouter();
  const [kind, setKind] = useState<ErrandKind>(kinds[0]?.kind ?? 'research_compare');
  const [request, setRequest] = useState('');
  const [cadence, setCadence] = useState(DEFAULT_MONITOR_CADENCE_MINUTES);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const spec = useMemo(() => kinds.find((k) => k.kind === kind) ?? kinds[0], [kinds, kind]);
  const tooShort = request.trim().length < MIN_CHARS;
  const isMonitor = kind === 'monitor_change';

  async function commission() {
    if (tooShort || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/errands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind,
          request: request.trim(),
          ...(isMonitor ? { checkIntervalMinutes: cadence } : {}),
        }),
      });
      const body = (await res.json().catch(() => null)) as {
        errandId?: string;
        error?: string;
      } | null;
      if (!res.ok || !body?.errandId) {
        throw new Error(body?.error ?? 'No se pudo crear el encargo.');
      }
      router.push(`/errands/${body.errandId}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="rounded-card border border-border bg-surface p-4 shadow-card md:p-5">
      <div className="field-label mb-2">Qué tipo de encargo</div>
      <div className="mb-4 grid gap-2 sm:grid-cols-3">
        {kinds.map((option) => {
          const active = option.kind === kind;
          return (
            <button
              key={option.kind}
              type="button"
              disabled={busy}
              onClick={() => setKind(option.kind)}
              aria-pressed={active}
              className={clsx(
                'rounded-card border p-3 text-left transition-all duration-150',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                'disabled:opacity-60 motion-reduce:transform-none motion-reduce:transition-none',
                active
                  ? 'border-primary/30 bg-primary-soft shadow-card'
                  : 'border-border bg-surface-2 hover:-translate-y-px hover:border-border-strong',
              )}
            >
              <div
                className={clsx(
                  'text-[13px] font-bold',
                  active ? 'text-primary-ink' : 'text-ink',
                )}
              >
                {option.label}
              </div>
              <div className="mt-1 text-[11.5px] leading-snug text-ink-muted">{option.blurb}</div>
            </button>
          );
        })}
      </div>

      <div className="field-label mb-2">Qué quieres que haga</div>
      <textarea
        value={request}
        onChange={(e) => setRequest(e.target.value)}
        onKeyDown={(e) => {
          // ⌘/Ctrl+Enter commissions; plain Enter keeps writing, because a good
          // errand is a paragraph more often than a line.
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void commission();
          }
        }}
        rows={4}
        maxLength={4000}
        disabled={busy}
        placeholder={spec?.example}
        className="scroll-slim w-full resize-y rounded-card border border-border bg-canvas px-3.5 py-3 text-[14px] leading-relaxed text-ink transition-colors placeholder:text-ink-faint focus:border-primary/40 focus:outline-none focus:ring-4 focus:ring-primary/10 disabled:opacity-60"
      />

      {isMonitor && (
        <div className="mt-3">
          <div className="field-label mb-1.5">Cada cuánto vuelve a mirar</div>
          <div className="flex flex-wrap gap-1.5">
            {MONITOR_CADENCES.map((option) => (
              <button
                key={option.minutes}
                type="button"
                disabled={busy}
                onClick={() => setCadence(option.minutes)}
                aria-pressed={cadence === option.minutes}
                className={clsx(
                  'rounded-pill border px-3 py-1 text-[12px] font-semibold transition-all duration-150',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                  'disabled:opacity-50 motion-reduce:transform-none motion-reduce:transition-none',
                  cadence === option.minutes
                    ? 'border-primary/30 bg-primary-soft text-primary-ink'
                    : 'border-border bg-surface-2 text-ink-muted hover:-translate-y-px hover:text-ink',
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => spec && setRequest(spec.example)}
          className="tabular rounded-pill border border-border bg-surface-2 px-2.5 py-0.5 text-[11px] font-semibold text-ink-muted transition-all duration-150 hover:-translate-y-px hover:border-border-strong hover:text-ink disabled:opacity-50 motion-reduce:transform-none motion-reduce:transition-none"
        >
          Usar el ejemplo
        </button>

        <div className="flex items-center gap-2.5">
          <span className="tabular hidden text-[11px] text-ink-faint sm:inline">
            {request.trim().length}/4000
          </span>
          <button
            type="button"
            onClick={() => void commission()}
            disabled={busy || tooShort}
            className={clsx(
              'inline-flex items-center gap-1.5 rounded-pill px-4 py-2 text-[13px] font-semibold shadow-pop transition-all duration-150',
              'bg-primary text-white hover:-translate-y-px hover:bg-primary-strong',
              'disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none',
              'motion-reduce:transform-none motion-reduce:transition-none',
            )}
          >
            {busy ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> Encargando…
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4" /> Encargar
                <CornerDownLeft className="hidden h-3.5 w-3.5 opacity-60 sm:block" />
              </>
            )}
          </button>
        </div>
      </div>

      <p className="mt-3 flex items-start gap-2 rounded-card border border-border bg-surface-2 px-3 py-2 text-[12px] leading-relaxed text-ink-muted">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint" />
        <span>{ERRAND_BOUNDARY_NOTICE}</span>
      </p>

      {error && (
        <p className="mt-3 flex items-start gap-2 rounded-card border border-rose/40 bg-rose-soft px-3 py-2 text-[12.5px] text-rose">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error} No se encargó nada.</span>
        </p>
      )}
    </div>
  );
}
