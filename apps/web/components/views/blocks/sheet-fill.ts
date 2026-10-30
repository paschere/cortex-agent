'use client';

import { createContext, useContext } from 'react';

/**
 * LA HOJA QUE LLENA LA PANTALLA. Una pantalla de app cuyo primer bloque es una
 * hoja la pinta como Google Sheets: sin la tarjeta alrededor, de borde a borde
 * y con la rejilla hasta abajo de la ventana (el desplazamiento va por dentro).
 * Lo enciende AppRunner; en una vista suelta la hoja sigue siendo una tarjeta.
 */
export const SheetFillContext = createContext<string | null>(null);

/** El id del bloque que llena la pantalla (sólo ese; los demás quedan como tarjeta). */
export function useSheetFill(blockId: string): boolean {
  return useContext(SheetFillContext) === blockId;
}
