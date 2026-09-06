'use client';
import { NotificationBell } from '@/components/notifications/NotificationBell';
import { buildRail } from '@/lib/nav-shape';
import { ChevronRight, Menu, Search } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useCommandMenu } from './CommandMenuContext';
import { useMobileSidebar } from './MobileSidebarContext';

export function Topbar({ email }: { email?: string }) {
  const mobile = useMobileSidebar();
  const command = useCommandMenu();
  const path = usePathname();
  const rail = buildRail([], true);
  const items = [
    ...rail.pinned,
    ...rail.waiting,
    ...rail.rest.flatMap((s) => s.items),
    ...rail.company.items,
    ...rail.footer,
  ];
  const current = items
    .filter((i) => path === i.href || path.startsWith(`${i.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];
  return (
    <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-3 border-b border-border bg-surface px-4 print:hidden md:px-8">
      <button
        type="button"
        onClick={() => mobile.setOpen(true)}
        aria-label="Abrir el menú"
        className="rounded-lg p-2 text-ink-muted hover:bg-surface-2 md:hidden"
      >
        <Menu className="h-5 w-5" />
      </button>
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <span className="hidden text-ink-faint sm:inline">Espacio de trabajo</span>
        <ChevronRight className="hidden h-3.5 w-3.5 text-ink-faint sm:inline" />
        <span className="truncate font-semibold text-ink">{current?.label ?? 'Cortex'}</span>
      </div>
      <div className="ml-auto flex items-center gap-3">
        <button
          type="button"
          onClick={() => command.setOpen(true)}
          aria-label="Buscar o ir a una pantalla"
          aria-keyshortcuts="Meta+K Control+K"
          className="flex h-8 items-center gap-2 rounded-lg px-2 text-xs text-ink-muted hover:bg-surface-2"
        >
          <Search className="h-4 w-4" />
          <span className="hidden sm:inline">Buscar en Cortex</span>
        </button>
        <NotificationBell />
        <span
          title={email}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-border bg-surface-2 text-xs font-semibold text-ink"
        >
          {(email ?? '?').charAt(0).toUpperCase()}
        </span>
      </div>
    </header>
  );
}
