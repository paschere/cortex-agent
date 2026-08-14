'use client';

import { clsx } from 'clsx';
import { ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

/**
 * The model's thinking, kept in the margin.
 *
 * This is a record of process, not an assertion, and the two must never be
 * confused — so it is set apart from the answer on every axis available:
 * monospaced instead of the prose face, smaller, muted, and hung off a soft
 * hairline down the left. It is folded by default because it must not compete
 * with what Cortex actually says.
 *
 * While a turn is still running the fold is the best progress there is: the
 * tail of the reasoning updates live, which beats three dots for telling
 * someone that a twenty-second lookup is in fact moving.
 *
 * Reasoning is not persisted with the transcript, so it appears on the live
 * turn only — a reloaded conversation shows the answers without it.
 */
export function ReasoningTrail({ text, live }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const trimmed = text.trim();

  // Follow the stream while it is open and still arriving. `text` is in the
  // deps precisely because it is the thing growing — it is what the effect
  // reacts to, even though the body reads only the node.
  // biome-ignore lint/correctness/useExhaustiveDependencies: text is the trigger
  useEffect(() => {
    if (!open || !live) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text, open, live]);

  if (!trimmed) return null;

  // The last non-empty line is what the model is on right now.
  const lines = trimmed.split('\n').filter((l) => l.trim().length > 0);
  const tail = lines[lines.length - 1] ?? '';

  return (
    <div className="mb-2 border-l-2 border-border pl-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-left"
      >
        <span
          className={clsx(
            'shrink-0 text-micro font-semibold',
            live ? 'text-primary' : 'text-ink-faint',
          )}
        >
          {live ? 'Razonando…' : 'Razonamiento'}
        </span>
        {live && !open && (
          <span className="min-w-0 flex-1 truncate font-mono text-micro text-ink-faint">
            {tail}
          </span>
        )}
        <ChevronDown
          className={clsx(
            'ml-auto h-3 w-3 shrink-0 text-ink-faint transition-transform duration-150 motion-reduce:transition-none',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && (
        <div
          ref={bodyRef}
          className="scroll-slim mt-1.5 max-h-60 overflow-y-auto whitespace-pre-wrap font-mono text-micro leading-relaxed text-ink-muted"
        >
          {trimmed}
        </div>
      )}
    </div>
  );
}
