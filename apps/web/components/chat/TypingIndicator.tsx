'use client';

import { Stamp } from 'lucide-react';

/**
 * Shown while the assistant is working.
 *
 * `label` matters more than it looks: Claude thinks and calls tools before it
 * writes a single word, and a long lookup (a RUNT check runs for ~18s) left the
 * screen showing three dots with no clue anything was happening — indistinguishable
 * from a hung request. Naming the tool in flight turns dead air into progress,
 * which is why there is always a word here even when no tool has been named yet.
 *
 * The dots are a CSS animation rather than a JS one so the global
 * prefers-reduced-motion rule in globals.css actually stops them.
 */
export function TypingIndicator({ label }: { label?: string }) {
  return (
    // <output> carries role="status" natively, so a screen reader is told what
    // the assistant is doing without a redundant ARIA role.
    <output className="flex items-start gap-3" aria-live="polite">
      <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-card border border-primary/30 bg-primary-soft text-primary">
        <Stamp className="h-3.5 w-3.5" />
      </span>
      <div className="flex items-center gap-2.5 rounded-card border border-border bg-surface px-3 py-2">
        <span className="flex items-center gap-1" aria-hidden>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary/50"
              style={{ animationDelay: `${i * 180}ms` }}
            />
          ))}
        </span>
        <span className="text-[13px] font-medium text-ink-muted">{label ?? 'Trabajando…'}</span>
      </div>
    </output>
  );
}
