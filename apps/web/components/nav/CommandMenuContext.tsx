'use client';

import type { Role } from '@cortex/core';
import { type ReactNode, createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useGlobalHotkeys } from '../../hooks/useGlobalHotkeys';
import { CommandPalette } from './CommandPalette';

interface CommandMenuContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const CommandMenuContext = createContext<CommandMenuContextValue | null>(null);

/**
 * The palette, mounted once for the whole shell.
 *
 * IT USED TO LIVE INSIDE ChatRoot, which meant ⌘K only worked on /chat — every
 * other screen had the shortcut and no listener. That is the worst version of
 * this feature: the rail can only afford to hide a destination if the palette
 * is genuinely everywhere and genuinely findable, and it was neither. Hoisting
 * it here is what earns the right to keep the rail short.
 *
 * Rendered by both shells ((app) and (chat)) so the two visible triggers — the
 * rail's "Buscar" row and the top bar's search field — always have something to
 * open, whichever layout the person is standing in.
 */
export function CommandMenuProvider({
  children,
  role,
}: {
  children: ReactNode;
  /** Only so the palette can leave out the admin screens a non-admin would 404 on. */
  role?: Role;
}) {
  const [open, setOpen] = useState(false);
  const hotkeys = useMemo(
    () => ({
      'mod+k': () => setOpen((v) => !v),
      escape: () => setOpen(false),
    }),
    [],
  );
  useGlobalHotkeys(hotkeys);

  const value = useMemo(() => ({ open, setOpen }), [open]);
  const close = useCallback(() => setOpen(false), []);

  return (
    <CommandMenuContext.Provider value={value}>
      {children}
      <CommandPalette open={open} onClose={close} role={role} />
    </CommandMenuContext.Provider>
  );
}

export function useCommandMenu(): CommandMenuContextValue {
  const ctx = useContext(CommandMenuContext);
  // A trigger rendered outside the provider should do nothing rather than crash
  // the navigation around it — same bargain as useMobileSidebar.
  if (!ctx) return { open: false, setOpen: () => {} };
  return ctx;
}
