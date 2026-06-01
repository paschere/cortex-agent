'use client';

import { Menu, Search, Bell } from 'lucide-react';
import { useMobileSidebar } from './MobileSidebarContext';

export function Topbar({ email }: { email?: string }) {
  const { setOpen } = useMobileSidebar();
  const initial = (email ?? '?').charAt(0).toUpperCase();

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface/80 px-4 backdrop-blur-md md:px-6">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open menu"
        className="rounded-[10px] p-1.5 text-ink-muted hover:bg-surface-2 md:hidden"
      >
        <Menu className="h-5 w-5" />
      </button>

      <label className="relative hidden max-w-sm flex-1 items-center sm:flex">
        <Search className="pointer-events-none absolute left-3 h-4 w-4 text-ink-faint" />
        <input
          type="search"
          placeholder="Search candidates, deals, docs…"
          className="h-9 w-full rounded-pill border border-border bg-surface-2 pl-9 pr-3 text-[13px] text-ink placeholder:text-ink-faint focus:border-primary/40 focus:bg-surface focus:outline-none focus:ring-4 focus:ring-primary/10"
        />
      </label>

      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          aria-label="Notifications"
          className="relative rounded-[10px] p-2 text-ink-muted hover:bg-surface-2"
        >
          <Bell className="h-[18px] w-[18px]" />
          <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-primary" />
        </button>
        <span
          title={email}
          className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-primary to-primary-strong text-xs font-bold text-white"
        >
          {initial}
        </span>
      </div>
    </header>
  );
}
