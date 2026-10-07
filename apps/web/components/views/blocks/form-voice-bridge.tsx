'use client';

import type { TrackerField } from '@cortex/agent-tools';
import { type ReactNode, createContext, useContext, useRef, useSyncExternalStore } from 'react';
import type { SubmitTarget } from '../ViewCanvas';

/**
 * EL PUENTE ENTRE UN FORMULARIO Y SU ASISTENTE DE VOZ.
 *
 * El formulario (FormBlock) es dueño de sus valores, de la validación y del
 * envío (con su cola sin internet). El asistente de voz puede estar en otro
 * bloque (`voice`) o en el mismo; en los dos casos maneja EL MISMO estado: cada
 * FormBlock se registra aquí con un «control» (lo que lleva, cómo poner
 * valores, cómo enviar) y el asistente lo busca por el id del bloque. Así la
 * persona ve cómo se llena el formulario y puede corregir con el dedo, y el
 * envío sale por el mismo camino de siempre.
 *
 * Es un almacén externo (useSyncExternalStore): el formulario lo actualiza en
 * cada render sin volver a pintar a los demás bloques, y sólo el asistente que
 * lo lee se repinta.
 */

export type VoiceSendOutcome =
  | { ok: true; offline: boolean; message: string; duplicate: string | null }
  | { ok: false; error: string };

export interface FormController {
  blockId: string;
  title: string;
  target: SubmitTarget;
  fields: TrackerField[];
  steps: Array<{ title: string; fields: string[] }> | null;
  values: Record<string, string>;
  /** Mezcla estos valores en el formulario (lo que la voz entendió). */
  setValues: (patch: Record<string, string>) => void;
  /** Sin vista guardada (vista previa) o sin con qué enviar. */
  disabled: boolean;
  online: boolean;
  /** El formulario ya mostró su pantalla de «listo». */
  done: boolean;
  /** Lo que valida un valor guardado (una foto pendiente cuenta como puesta). */
  prepare: (value: string) => string;
  /** Valida y envía por el mismo camino que el botón Enviar. */
  submit: () => Promise<VoiceSendOutcome>;
  /** Vuelve a un formulario en blanco (tras «Enviar otro»). */
  reset: () => void;
}

class Store {
  private map = new Map<string, FormController>();
  private listeners = new Set<() => void>();
  set(id: string, c: FormController) {
    this.map.set(id, c);
    for (const l of this.listeners) l();
  }
  drop(id: string) {
    this.map.delete(id);
    for (const l of this.listeners) l();
  }
  get = (id: string) => this.map.get(id);
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
}

const Ctx = createContext<Store | null>(null);

export function FormVoiceProvider({ children }: { children: ReactNode }) {
  const ref = useRef<Store | null>(null);
  if (!ref.current) ref.current = new Store();
  return <Ctx.Provider value={ref.current}>{children}</Ctx.Provider>;
}

/** Para FormBlock: el almacén (null fuera de un lienzo: sin asistente). */
export function useFormVoiceStore(): Store | null {
  return useContext(Ctx);
}

/** Para el asistente: el control del formulario `blockId`, o undefined si no está. */
export function useFormController(blockId: string): FormController | undefined {
  const store = useContext(Ctx);
  return useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    () => store?.get(blockId),
    () => undefined,
  );
}

const noopSubscribe = () => () => {};
