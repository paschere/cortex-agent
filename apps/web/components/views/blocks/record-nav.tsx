'use client';

import { createContext, useContext } from 'react';

/**
 * IR AL DETALLE DE UN REGISTRO Y VOLVER.
 *
 * Quien monta el lienzo (LiveViewCanvas) lleva `?fila=<id>` en la dirección:
 * abrir una fila lo escribe (con un paso en el historial, así «atrás» vuelve
 * a la lista) y pide la vista recalculada con ese registro. Los bloques sólo
 * conocen estas dos funciones. Sin proveedor (la vista previa del editor, el
 * escaparate), no hay navegación: las filas abren la ficha lateral de siempre.
 */
export interface RecordNav {
  open: (detailBlockId: string, rowId: string) => void;
  close: () => void;
  /** La dirección propia de un registro, para copiarla o abrirla en otra pestaña. */
  href: (detailBlockId: string, rowId: string) => string;
}

const Ctx = createContext<RecordNav | null>(null);
export const RecordNavProvider = Ctx.Provider;
export const useRecordNav = () => useContext(Ctx);
