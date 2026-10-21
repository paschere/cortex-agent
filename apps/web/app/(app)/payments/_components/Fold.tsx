'use client';

import { chipClass } from '@/lib/status-chip';
import { ChevronDown } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';

/**
 * Una sección secundaria plegada: título, una pista de lo que hay dentro y su
 * cuenta a la derecha. Se abre sola si la dirección trae su ancla (`#extractos`,
 * `#recuperado`): Finanzas y la guía mandan ahí, y un pliegue cerrado esconde
 * justo a lo que se vino.
 */
export function Fold({
  id,
  title,
  hint,
  badge,
  badgeTone = 'neutral',
  children,
}: {
  id: string;
  title: string;
  hint?: string;
  badge?: string | null;
  badgeTone?: 'neutral' | 'amber' | 'emerald' | 'rose' | 'primary';
  children: ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const open = () => {
      if (window.location.hash === `#${id}` && ref.current) ref.current.open = true;
    };
    open();
    window.addEventListener('hashchange', open);
    return () => window.removeEventListener('hashchange', open);
  }, [id]);
  return (
    <details
      ref={ref}
      id={id}
      className="group scroll-mt-24 rounded-card border border-border bg-surface shadow-card"
    >
      <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 rounded-card px-5 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">
          <span className="block text-sm font-bold text-ink">{title}</span>
          {hint ? <span className="block text-xs text-ink-muted">{hint}</span> : null}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {badge ? <span className={chipClass(badgeTone)}>{badge}</span> : null}
          <ChevronDown
            className="h-4 w-4 text-ink-faint transition-transform group-open:rotate-180"
            aria-hidden
          />
        </span>
      </summary>
      <div className="border-t border-border p-3 sm:p-4">{children}</div>
    </details>
  );
}
