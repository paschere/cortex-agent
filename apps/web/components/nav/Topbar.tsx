'use client';

import { NotificationBell } from '@/components/notifications/NotificationBell';
import { Menu, Search } from 'lucide-react';
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
        className="relative flex h-9 shrink-0 items-center gap-2.5 rounded-pill border border-border bg-surface-2 px-2.5 text-left text-sm text-ink-faint transition-[background-color,border-color,color] duration-150 hover:border-border-strong hover:bg-surface hover:text-ink-muted focus-visible:border-primary/40 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/10 motion-reduce:transition-none sm:max-w-sm sm:flex-1 sm:pl-3.5 sm:pr-2"
      >
        <Search className="h-4 w-4 shrink-0" />
        <span className="hidden truncate sm:inline">Buscar o ir a…</span>
        {/* No aria-hidden: the button carries an explicit aria-label, so nothing
            inside it is announced anyway, and `aria-keyshortcuts` is what tells
            a screen reader about ⌘K properly. */}
        <kbd className="ml-auto hidden shrink-0 rounded-sm bg-surface px-1.5 py-0.5 font-mono text-micro font-semibold text-ink-faint ring-1 ring-inset ring-border sm:block">
          {modKey}K
        </kbd>
      </button>

      <div className="ml-auto flex items-center gap-2">
        {/*
          THE BELL, IN ITS THIRD AND FINAL FORM.

          It started as a <button> with no onClick and an unread dot painted
          unconditionally — it claimed there was something new on every page load
          and did nothing when pressed. Then it became a link to /approvals with
          an honest dot, which was the truest thing available while there was no
          notification feed to open.

          Now there is one, so it opens it. The count comes from the bell itself
          against /api/notifications/count; nothing is passed down from the
          layout, which is why the `waiting` prop is gone rather than left
          hanging as a parameter nobody reads.

          The distinction it now respects: a notification is a FACT WITH AN HOUR
          that survives the screen — «the trámite finished», «the routine could
          not run». What is still pending lives in /dashboard, counted in the
          rail. Putting a queue in here would either repeat it or go stale.
        */}
        <NotificationBell />
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
