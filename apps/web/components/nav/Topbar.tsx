'use client';

import { Bell, Menu, Search } from 'lucide-react';
import { useMobileSidebar } from './MobileSidebarContext';

/**
 * The app's top edge: an opaque surface, a hairline where it meets the scroll,
 * and capsule controls. It stays flat on purpose — it is chrome the content
 * slides under, so the depth in this app belongs to the cards below it.
 */
export function Topbar({ email }: { email?: string }) {
  const { setOpen } = useMobileSidebar();
  const initial = (email ?? '?').charAt(0).toUpperCase();

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-4 md:px-6">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Abrir el menú"
        className="rounded-full p-1.5 text-ink-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink md:hidden"
      >
        <Menu className="h-5 w-5" />
      </button>

      <label className="relative hidden max-w-sm flex-1 items-center sm:flex">
        <Search className="pointer-events-none absolute left-3.5 h-4 w-4 text-ink-faint" />
        <input
          type="search"
          placeholder="Buscar personas, negocios, documentos"
          className="h-9 w-full rounded-pill border border-border bg-surface-2 pl-10 pr-4 text-[13px] text-ink transition-[background-color,border-color,box-shadow] duration-150 placeholder:text-ink-faint focus:border-primary/40 focus:bg-surface focus:outline-none focus:ring-4 focus:ring-primary/10 motion-reduce:transition-none"
        />
      </label>

      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          aria-label="Notificaciones"
          className="relative rounded-full p-2 text-ink-muted transition-colors duration-150 hover:bg-primary-soft hover:text-primary-ink motion-reduce:transition-none"
        >
          <Bell className="h-[18px] w-[18px]" />
          {/* Ringed in the bar's own surface so the dot keeps its edge when the
              button fills on hover. */}
          <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-primary ring-2 ring-surface" />
        </button>
        <span
          title={email}
          className="grid h-8 w-8 place-items-center rounded-full bg-primary font-mono text-xs font-bold text-white shadow-card ring-2 ring-surface"
        >
          {initial}
        </span>
      </div>
    </header>
  );
}
