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
  'Research our three closest competitors and tell me where our pricing sits against theirs.',
  'Audit the open pull requests and the Linear backlog, then tell me what is actually blocking the release.',
  'Pull last month’s hiring pipeline, find where candidates drop off, and propose two fixes.',
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
      if (!res.ok || !body?.runId) throw new Error(body?.error ?? 'Could not start the run.');
      router.push(`/orchestrator/${body.runId}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="rounded-card border border-border bg-surface p-4 shadow-card md:p-5">
      <div className="mb-3 flex items-center gap-2">
        <span className="grid h-7 w-7 place-items-center rounded-[9px] bg-primary-soft text-primary">
          <Sparkles className="h-4 w-4" />
        </span>
        <div className="text-[13px] font-semibold text-ink">What should the team work on?</div>
      </div>

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
        placeholder="Describe the outcome you want. Cortex breaks it into sub-agents, runs the independent ones in parallel, and writes you one report."
        className="scroll-slim w-full resize-y rounded-[14px] border border-border bg-canvas px-3.5 py-3 text-[14px] leading-relaxed text-ink outline-none transition placeholder:text-ink-faint focus:border-primary/50 focus:ring-4 focus:ring-primary/10 disabled:opacity-60"
      />

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {EXAMPLES.map((example, i) => (
            <button
              key={example}
              type="button"
              disabled={busy}
              onClick={() => setObjective(example)}
              className="rounded-pill border border-border bg-surface-2 px-2.5 py-1 text-[11.5px] font-medium text-ink-muted transition hover:border-border-strong hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
            >
              Example {i + 1}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2.5">
          <span className="hidden text-[11px] text-ink-faint sm:inline">
            {objective.trim().length}/4000
          </span>
          <button
            type="button"
            onClick={() => void launch()}
            disabled={busy || tooShort}
            className={clsx(
              'inline-flex items-center gap-1.5 rounded-pill px-4 py-2 text-[13px] font-semibold transition-colors',
              'bg-primary text-white shadow-pop hover:bg-primary-strong',
              'focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/15',
              'disabled:opacity-50',
            )}
          >
            {busy ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /> Planning…
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4" /> Run it
                <CornerDownLeft className="hidden h-3.5 w-3.5 opacity-60 sm:block" />
              </>
            )}
          </button>
        </div>
      </div>

      {error && (
        <p className="mt-3 flex items-start gap-2 rounded-[12px] border border-rose/30 bg-rose-soft px-3 py-2 text-[12.5px] text-rose">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}
