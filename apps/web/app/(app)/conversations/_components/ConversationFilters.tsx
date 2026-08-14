import { SURFACE_FILTERS, type SurfaceFilter } from '@/lib/conversation-surface';
import { clsx } from 'clsx';
import { Search, X } from 'lucide-react';
import Link from 'next/link';

function hrefFor(surface: SurfaceFilter, q: string): string {
  const sp = new URLSearchParams();
  if (surface) sp.set('surface', surface);
  if (q) sp.set('q', q);
  const qs = sp.toString();
  return qs ? `/conversations?${qs}` : '/conversations';
}

/**
 * Surface segments + title search. Both live entirely in the query string —
 * the search is a plain GET form, so there is no client state to keep in sync
 * and every view is a shareable URL.
 */
export function ConversationFilters({ surface, q }: { surface: SurfaceFilter; q: string }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div
        className="inline-flex flex-wrap items-center gap-0.5 rounded-pill border border-border bg-surface p-0.5"
        role="tablist"
        aria-label="Filtrar las conversaciones por origen"
      >
        {SURFACE_FILTERS.map((f) => {
          const active = f.value === surface;
          return (
            <Link
              key={f.value || 'default'}
              href={hrefFor(f.value, q)}
              role="tab"
              aria-selected={active}
              className={clsx(
                'rounded-pill px-3 py-1.5 text-xs font-semibold transition-colors',
                active
                  ? 'bg-primary text-white'
                  : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
              )}
            >
              {f.label}
            </Link>
          );
        })}
      </div>

      <form method="get" action="/conversations" className="flex items-center gap-2">
        {surface && <input type="hidden" name="surface" value={surface} />}
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="Buscar por título…"
            aria-label="Buscar conversaciones por título"
            className="w-56 rounded-card border border-border bg-surface py-1.5 pl-8 pr-3 text-xs text-ink transition-colors placeholder:text-ink-faint focus:border-primary/40 focus:outline-none focus:ring-4 focus:ring-primary/10"
          />
        </div>
        {q && (
          <Link
            href={hrefFor(surface, '')}
            aria-label="Limpiar la búsqueda"
            className="rounded-full p-1.5 text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <X className="h-3.5 w-3.5" />
          </Link>
        )}
      </form>
    </div>
  );
}
