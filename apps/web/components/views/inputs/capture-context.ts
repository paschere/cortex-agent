'use client';

import { createContext, useContext } from 'react';

/**
 * Quién está capturando y en qué app: lo que la marca de agua de una foto con
 * evidencia dice abajo («Ana Gómez · Control de planta»). Lo pone la capa de
 * captura de la app (components/apps/AppCaptureLayer.tsx); fuera de una app
 * (un enlace público) no hay contexto y la marca lleva sólo fecha y lugar.
 */
export interface CaptureWho {
  userName: string | null;
  appName: string | null;
  /**
   * Para guardar copias sin señal (listas de opciones de los formularios) de
   * ESTA persona en ESTA app; ausentes fuera de una app.
   */
  appKey?: string | null;
  userKey?: string | null;
}

export const CaptureContext = createContext<CaptureWho>({ userName: null, appName: null });

export function useCaptureWho(): CaptureWho {
  return useContext(CaptureContext);
}
