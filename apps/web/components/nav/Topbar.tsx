'use client';
import { NotificationBell } from '@/components/notifications/NotificationBell';
import { CortexSignature } from '@/components/ui/cortex-signature';
import { buildRail } from '@/lib/nav-shape';
import { ChevronRight, Search } from 'lucide-react';
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
    <header className="workspace-topbar sticky top-0 z-30 flex h-16 shrink-0 items-center gap-3 border-b border-border bg-surface px-4 print:hidden md:px-8">
      {/* En el teléfono la marca ocupa el sitio de la hamburguesa: el menú
          completo se abre desde «Más», en la barra de abajo. */}
      <button
        type="button"
        onClick={() => mobile.setOpen(true)}
        aria-label="Abrir el menú"
        className="grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-primary text-white md:hidden"
      >
        <CortexSignature className="h-6 w-6" />
      </button>
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <span className="hidden font-medium text-ink-faint lg:inline">Espacio de trabajo</span>
        <ChevronRight className="hidden h-4 w-4 text-ink-faint lg:inline" />
        <span className="truncate font-bold text-ink">{current?.label ?? 'Cortex'}</span>
      </div>
      <div className="ml-auto flex items-center gap-2 md:gap-3">
        <button
          type="button"
          onClick={() => command.setOpen(true)}
          aria-label="Buscar o ir a una pantalla"
          aria-keyshortcuts="Meta+K Control+K"
          className="flex h-10 items-center gap-2 rounded-pill px-2.5 text-sm text-ink-faint transition-colors hover:text-ink sm:border sm:border-border-strong sm:bg-surface sm:pl-3.5 sm:pr-3 md:w-64"
        >
          <Search className="h-4 w-4 shrink-0" />
          <span className="hidden flex-1 text-left font-medium sm:inline">Buscar en Cortex</span>
          <kbd className="hidden font-sans text-micro font-semibold md:inline">⌘K</kbd>
        </button>
        <NotificationBell />
        <span
          title={email}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-amber-soft text-sm font-bold text-amber"
        >
          {(email ?? '?').charAt(0).toUpperCase()}
        </span>
      </div>
    </header>
  );
}
