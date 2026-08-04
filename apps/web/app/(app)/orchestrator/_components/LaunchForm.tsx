'use client';

import { clsx } from 'clsx';
import { CornerDownLeft, Loader2, Sparkles, TriangleAlert } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * The launch pad. One field, because the whole promise of the orchestrator is
 * that you describe the outcome and it works out the steps.
 *
 * The examples are not decoration: an empty box is the hardest thing to answer,
 * and each one demonstrates a different shape of objective (research, audit,
 * multi-source synthesis) so the first run people try is a good one.
 */

const MIN_CHARS = 10;

const EXAMPLES = [
  'Investiga a nuestros tres competidores más cercanos y dime cómo quedan nuestras tarifas frente a las de ellos.',
  'Revisa los pull requests abiertos y el backlog de Linear, y dime qué está frenando de verdad el lanzamiento.',
  'Saca el embudo de contratación del mes pasado, encuentra dónde se caen los candidatos y propón dos arreglos.',
];

export function LaunchForm({ concurrency }: { concurrency: number }) {
  const router = useRouter();
  const [objective, setObjective] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tooShort = objective.trim().length < MIN_CHARS;

  async function launch() {
    if (tooShort || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/orchestrator', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ objective: objective.trim(), concurrency }),
      });
      const body = (await res.json().catch(() => null)) as {
        runId?: string;
        error?: string;
      } | null;
      if (!res.ok || !body?.runId) throw new Error(body?.error ?? 'No se pudo iniciar la ejecución.');
      router.push(`/orchestrator/${body.runId}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="rounded-card border border-border bg-surface p-4 md:p-5">
      <div className="field-label mb-2">Objetivo</div>

      <textarea
        value={objective}
        onChange={(e) => setObjective(e.target.value)}
        onKeyDown={(e) => {
          // ⌘/Ctrl+Enter submits; plain Enter keeps writing, because objectives
          // are paragraphs more often than they are one-liners.
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void launch();
          }
        }}
        rows={4}
        maxLength={4000}
        disabled={busy}
        placeholder="Describe el resultado que quieres. Cortex lo reparte entre subagentes, corre en paralelo los que no dependen de nadie y te escribe un solo informe."
        className="scroll-slim w-full resize-y rounded-card border border-border bg-canvas px-3.5 py-3 text-[14px] leading-relaxed text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-border-strong disabled:opacity-60"
      />

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="field-label">Empieza con</span>
          {EXAMPLES.map((example, i) => (
            <button
              key={example}
              type="button"
              disabled={busy}
              title={example}
              onClick={() => setObjective(example)}
              className="tabular rounded-card border border-border bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-ink-muted transition-colors hover:border-border-strong hover:text-ink disabled:opacity-50"
            >
              Ejemplo {i + 1}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2.5">
          <span className="tabular hidden text-[11px] text-ink-faint sm:inline">
            {objective.trim().length}/4000
          </span>
          <button
            type="button"
            onClick={() => void launch()}
            disabled={busy || tooShort}
            className={clsx(
              'inline-flex items-center gap-1.5 rounded-card px-4 py-2 text-[13px] font-semibold transition-colors',
              'bg-primary text-white hover:bg-primary-strong',
              'disabled:cursor-not-allowed disabled:opacity-45',
            )}
          >
            {busy ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> Planeando…
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4" /> Ejecutar
                <CornerDownLeft className="hidden h-3.5 w-3.5 opacity-60 sm:block" />
              </>
            )}
          </button>
        </div>
      </div>

      {error && (
        <p className="mt-3 flex items-start gap-2 rounded-card border border-rose/40 bg-rose-soft px-3 py-2 text-[12.5px] text-rose">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error} No se lanzó nada: revisa el objetivo y vuelve a ejecutar.</span>
        </p>
      )}
    </div>
  );
}
