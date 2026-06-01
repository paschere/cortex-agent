'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';

interface MobileSidebarContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const MobileSidebarContext = createContext<MobileSidebarContextValue | null>(null);

export function MobileSidebarProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <MobileSidebarContext.Provider value={{ open, setOpen }}>
      {children}
    </MobileSidebarContext.Provider>
  );
}

export function useMobileSidebar(): MobileSidebarContextValue {
  const ctx = useContext(MobileSidebarContext);
  if (!ctx) {
    // Outside the (chat) layout the hamburger is never rendered; provide a no-op
    // fallback so consumers don't crash if mounted elsewhere.
    return { open: false, setOpen: () => {} };
  }
  return ctx;
}
