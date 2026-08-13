'use client';

import { Bell, Menu, Search } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useCommandMenu } from './CommandMenuContext';
import { useMobileSidebar } from './MobileSidebarContext';

/**
 * The app's top edge: an opaque surface, a hairline where it meets the scroll,
 * and capsule controls. It stays flat on purpose — it is chrome the content
 * slides under, so the depth in this app belongs to the cards below it.
 */
export function Topbar({ email, waiting = 0 }: { email?: string; waiting?: number }) {
  const { setOpen } = useMobileSidebar();
  const { setOpen: openCommandMenu } = useCommandMenu();
  const initial = (email ?? '?').charAt(0).toUpperCase();
  // See the same note in the sidebar's SearchRow: the platform is not knowable
  // while rendering, and naming the wrong key is worse than naming none.
  const [modKey, setModKey] = useState('⌘');
  useEffect(() => {
    if (!/Mac|iPhone|iPad|iPod/.test(navigator.userAgent)) setModKey('Ctrl ');
  }, []);

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface px-4 md:gap-3 md:px-6">
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

        IT IS NO LONGER HIDDEN BELOW 640px. It used to carry `hidden … sm:flex`,
        which on a phone left the palette with no trigger at all — and the
        palette is the only way to reach /tools, /agents and /evaluation, none of
        which are in the rail. Four screens of the product were unreachable from
        a phone because of one utility class. Narrow, it collapses to the icon.
      */}
      <button
        type="button"
        onClick={() => openCommandMenu(true)}
        aria-label="Buscar o ir a una pantalla"
        aria-keyshortcuts="Meta+K Control+K"
        className="relative flex h-9 shrink-0 items-center gap-2.5 rounded-pill border border-border bg-surface-2 px-2.5 text-left text-[13px] text-ink-faint transition-[background-color,border-color,color] duration-150 hover:border-border-strong hover:bg-surface hover:text-ink-muted focus-visible:border-primary/40 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/10 motion-reduce:transition-none sm:max-w-sm sm:flex-1 sm:pl-3.5 sm:pr-2"
      >
        <Search className="h-4 w-4 shrink-0" />
        <span className="hidden truncate sm:inline">Buscar o ir a…</span>
        {/* No aria-hidden: the button carries an explicit aria-label, so nothing
            inside it is announced anyway, and `aria-keyshortcuts` is what tells
            a screen reader about ⌘K properly. */}
        <kbd className="ml-auto hidden shrink-0 rounded-sm bg-surface px-1.5 py-0.5 font-mono text-[10px] font-semibold text-ink-faint ring-1 ring-inset ring-border sm:block">
          {modKey}K
        </kbd>
      </button>

      <div className="ml-auto flex items-center gap-2">
        {/*
          THE BELL NOW GOES SOMEWHERE, AND THE DOT NOW MEANS SOMETHING.

          It was a <button> with no onClick and an unread dot painted
          unconditionally: it claimed there was something new on every single
          page load and did nothing when pressed. Both halves were lies, and a
          notification light that is always on is the fastest way to teach
          somebody to stop looking at it.

          There is no notification feed in this product to open, so it points at
          the closest true thing — the approvals queue — and the dot appears only
          when that queue is not empty.
        */}
        <Link
          href="/approvals"
          aria-label={
            waiting > 0 ? `Aprobaciones, ${waiting} esperando tu decisión` : 'Aprobaciones'
          }
          className="relative rounded-full p-2 text-ink-muted transition-colors duration-150 hover:bg-primary-soft hover:text-primary-ink motion-reduce:transition-none"
        >
          <Bell className="h-[18px] w-[18px]" />
          {waiting > 0 && (
            // Ringed in the bar's own surface so the dot keeps its edge when the
            // button fills on hover.
            <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-primary ring-2 ring-surface" />
          )}
        </Link>
        <span
          title={email}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary font-mono text-xs font-bold text-white shadow-card ring-2 ring-surface"
        >
          {initial}
        </span>
      </div>
    </header>
  );
}
