'use client';

import type { SheetWindowRequest } from '@cortex/agent-tools/src/views/sheet-window';
import { createContext, useContext } from 'react';

/**
 * LA VENTANA DE LAS HOJAS, entre el lienzo en vivo (que pide los datos) y cada
 * hoja (que dice hasta dónde quiere ver y qué busca). El lienzo guarda lo
 * pedido por bloque y lo repite en CADA refresco (`?sw=`/`?sq=`), así lo cargado
 * hacia el pasado no se pierde cuando llega un cálculo nuevo. Sin proveedor
 * (el escaparate, una vista sin refresco) la hoja trabaja con lo que trae.
 */
export interface SheetWindowControl {
  /** Lo pedido hoy para un bloque. */
  request(blockId: string): SheetWindowRequest;
  /** Cambia la búsqueda / filtros de columna (todo el histórico) y recalcula en el servidor. */
  update(blockId: string, patch: Partial<SheetWindowRequest>): void;
  /** «Cargar anterior»: pide SÓLO el bloque nuevo hasta `reach` y lo suma a lo ya cargado. */
  more(blockId: string, reach: string): void;
  /** El selector de alcance: ensanchar suma un bloque; estrechar reinicia la ventana. */
  choose(blockId: string, reach: string): void;
  /** Bloques con una lectura de ventana en vuelo. */
  loading: ReadonlySet<string>;
  /** El bloque con TODO el histórico (para exportar); null si no se pudo leer. */
  fetchAll(blockId: string): Promise<unknown | null>;
}

export const SheetWindowContext = createContext<SheetWindowControl | null>(null);

export function useSheetWindow(): SheetWindowControl | null {
  return useContext(SheetWindowContext);
}
