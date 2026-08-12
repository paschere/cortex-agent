'use client';

import { Bell, Menu, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useCommandMenu } from './CommandMenuContext';
import { useMobileSidebar } from './MobileSidebarContext';

/**
 * The app's top edge: an opaque surface, a hairline where it meets the scroll,
 * and capsule controls. It stays flat on purpose — it is chrome the content
 * slides under, so the depth in this app belongs to the cards below it.
 */
export function Topbar({ email }: { email?: string }) {
  const { setOpen } = useMobileSidebar();
  const { setOpen: openCommandMenu } = useCommandMenu();
  const initial = (email ?? '?').charAt(0).toUpperCase();
  // See the same note in the sidebar's SearchTrigger: the platform is not
  // knowable while rendering, and naming the wrong key is worse than naming none.
  const [modKey, setModKey] = useState('⌘');
  useEffect(() => {
    if (!/Mac|iPhone|iPad|iPod/.test(navigator.userAgent)) setModKey('Ctrl ');
  }, []);

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

      {/*
        A BUTTON THAT LOOKS LIKE A FIELD, NOT A FIELD.

        This was a real <input type="search"> with no handler, no form and no
        results — it took the caret, took what you typed and did nothing with it,
        which is a worse promise than an honest button. It now opens the command
        palette, which is the thing that actually searches the product, and it
        says the shortcut so the palette stops being a secret.

        The placeholder changed with it: it offered "personas, negocios,
        documentos" and the palette navigates to screens. Naming what it does is
        the point of the whole change.
      */}
      <button
        type="button"
        onClick={() => openCommandMenu(true)}
        aria-label="Buscar o ir a una pantalla"
        aria-keyshortcuts="Meta+K Control+K"
        className="relative hidden h-9 max-w-sm flex-1 items-center gap-2.5 rounded-pill border border-border bg-surface-2 pl-3.5 pr-2 text-left text-[13px] text-ink-faint transition-[background-color,border-color,color] duration-150 hover:border-border-strong hover:bg-surface hover:text-ink-muted focus-visible:border-primary/40 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/10 motion-reduce:transition-none sm:flex"
      >
        <Search className="h-4 w-4 shrink-0" />
        <span className="truncate">Buscar o ir a…</span>
        <kbd
          aria-hidden="true"
          className="ml-auto shrink-0 rounded-sm bg-surface px-1.5 py-0.5 font-mono text-[10px] font-semibold text-ink-faint ring-1 ring-inset ring-border"
        >
          {modKey}K
        </kbd>
      </button>

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
