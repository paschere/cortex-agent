'use client';

import { createContext, useContext } from 'react';

import { LIVE_FLASH_CLASS } from '@/lib/live-signal';

/**
 * Las filas y tarjetas que titilan ahora, por clave `bloque:fila`. Lo llena
 * LiveViewCanvas al comparar refrescos; fuera de una vista en vivo está vacío.
 */
const FlashContext = createContext<ReadonlySet<string>>(new Set());

export const FlashProvider = FlashContext.Provider;

/** Devuelve la clase que hace titilar la fila, o '' si no le toca. */
export function useFlashClass(): (blockId: string, rowId: string) => string {
  const keys = useContext(FlashContext);
  return (blockId, rowId) => (keys.has(`${blockId}:${rowId}`) ? LIVE_FLASH_CLASS : '');
}
