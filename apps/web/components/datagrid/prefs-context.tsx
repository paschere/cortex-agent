'use client';

import { type ReactNode, createContext, useContext } from 'react';

/** Quién mira: con esto cada tabla guarda sus columnas y densidad por persona. */
const GridUserContext = createContext<string>('anon');

export function GridUserProvider({ userKey, children }: { userKey: string; children: ReactNode }) {
  return <GridUserContext.Provider value={userKey}>{children}</GridUserContext.Provider>;
}

export function useGridUser(): string {
  return useContext(GridUserContext);
}
