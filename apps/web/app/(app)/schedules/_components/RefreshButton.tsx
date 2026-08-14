'use client';

import { clsx } from 'clsx';
import { RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

/** Re-run the server render of the page — picks up runs that finished since. */
export function RefreshButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      onClick={() => startTransition(() => router.refresh())}
      disabled={pending}
      className="inline-flex items-center gap-1.5 rounded-pill border border-border-strong bg-surface px-3 py-1.5 text-xs font-semibold text-ink-muted shadow-card transition-all duration-150 hover:-translate-y-px hover:bg-surface-2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60 disabled:hover:translate-y-0 motion-reduce:transform-none motion-reduce:transition-none"
    >
      <RefreshCw
        className={clsx('h-3.5 w-3.5', pending && 'animate-spin motion-reduce:animate-none')}
      />
      {pending ? 'Actualizando…' : 'Actualizar'}
    </button>
  );
}
