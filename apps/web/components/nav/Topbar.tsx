'use client';

import { Bell, Menu, Search } from 'lucide-react';
import { useMobileSidebar } from './MobileSidebarContext';

/**
 * The header rule of the document: a hairline, an opaque paper background and
 * squared controls. No pills, no blur — a form does not have a floating chrome.
 */
export function Topbar({ email }: { email?: string }) {
  const { setOpen } = useMobileSidebar();
  const initial = (email ?? '?').charAt(0).toUpperCase();

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-border-strong bg-surface px-4 md:px-6">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Abrir el menú"
        className="rounded-card p-1.5 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink md:hidden"
      >
        <Menu className="h-5 w-5" />
      </button>

      <label className="relative hidden max-w-sm flex-1 items-center sm:flex">
        <Search className="pointer-events-none absolute left-3 h-4 w-4 text-ink-faint" />
        <input
          type="search"
          placeholder="Buscar personas, negocios, documentos"
          className="h-9 w-full rounded-card border border-border bg-surface-2 pl-9 pr-3 text-[13px] text-ink placeholder:text-ink-faint focus:border-border-strong focus:bg-surface"
        />
      </label>

      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          aria-label="Notificaciones"
          className="relative rounded-card p-2 text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <Bell className="h-[18px] w-[18px]" />
          <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-primary" />
        </button>
        <span
          title={email}
          className="grid h-8 w-8 place-items-center rounded-full bg-primary font-mono text-xs font-bold text-white"
        >
          {initial}
        </span>
      </div>
    </header>
  );
}
