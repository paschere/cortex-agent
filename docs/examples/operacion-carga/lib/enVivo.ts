import { useCallback, useEffect, useRef } from 'react';
import { cortex, useLive, useLiveStatus, useOutbox, useQuery } from '@cortex/app-sdk';
import type { LiveEvent, LiveStatus, OutboxItem, Queued, QueryOptions, SdkRow } from '@cortex/app-sdk';

/**
 * Adaptador fino sobre lo nuevo del SDK: tiempo real (`live`), escritura sin señal (`offline`) y cola de
 * envío (`useOutbox`). Concentra aquí los nombres que usan las pantallas.
 */

export type EstadoVivo = LiveStatus;
export type EventoVivo = LiveEvent;
export type ItemBuzon = OutboxItem;
export type Encolado = Queued;
export interface Buzon {
  pending: number;
  items: OutboxItem[];
  failed: number;
  online: boolean;
  retry: () => Promise<void>;
  discard: (localId: string) => Promise<void>;
}

/** Se avisa cuando cambia alguna de las tablas; devuelve cómo dejar de escuchar. */
export function suscribirVivo(tablas: string[], cb: (e: EventoVivo) => void): () => void {
  return cortex.live.subscribe(tablas, cb);
}

export const hayVivo = (): boolean => typeof cortex.live?.subscribe === 'function';

/** Estado de la conexión en vivo: 'live' | 'reconnecting' | 'off'. */
export function useEstadoVivo(): EstadoVivo {
  return useLiveStatus();
}

/** Cambios que esperan señal. */
export function useBuzon(): Buzon {
  return useOutbox();
}

/** Llama a `cb` cuando cambie alguna de las tablas (no hace nada con la lista vacía). */
export function useCambios(tablas: string[], cb: (e: EventoVivo) => void): void {
  useLive(tablas, cb);
}

/** useQuery con `live: true` y sondeo largo de respaldo (si el SDK no trae `live`, lo ignora). */
export function useQueryVivo(
  table: string,
  opts: QueryOptions = {},
  respaldoMs = 90_000,
): { rows: SdkRow[]; loading: boolean; error: string | null; refresh: () => Promise<void> } {
  return useQuery(table, opts, { refreshMs: respaldoMs, live: true });
}

/** Refresca (con un respiro para juntar ráfagas) cuando cambian las tablas. */
export function useRefrescoVivo(tablas: string[], refrescar: () => unknown, esperaMs = 500): void {
  const ref = useRef(refrescar);
  ref.current = refrescar;
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  useCambios(
    tablas,
    useCallback(() => {
      if (t.current) clearTimeout(t.current);
      t.current = setTimeout(() => void ref.current(), esperaMs);
    }, [esperaMs]),
  );
  useEffect(
    () => () => {
      if (t.current) clearTimeout(t.current);
    },
    [],
  );
}

/* ───────────── Escritura que sobrevive a la falta de señal ───────────── */

export const esEncolado = (x: unknown): x is Encolado => !!x && typeof x === 'object' && (x as { queued?: unknown }).queued === true;

/** Crea una fila; sin señal queda en la cola y devuelve `{ queued: true, localId }`. */
export const insertarSS = (table: string, values: Record<string, unknown>) => cortex.tables.insert(table, values, { offline: true });
/** Cambia una fila; sin señal queda en la cola. */
export const actualizarSS = (table: string, id: string, values: Record<string, unknown>) => cortex.tables.update(table, id, values, { offline: true });
/** Corre un botón de flujo; sin señal queda en la cola. */
export const accionSS = (table: string, id: string, action: string) => cortex.tables.action(table, id, action, { offline: true });
/** Sube un archivo; sin señal queda en la cola (`id` puede ser el `localId` de una fila que aún espera). */
export const subirSS = (file: File | Blob, d: { table: string; id: string; field: string; name?: string }) => cortex.files.upload(file, { ...d, offline: true as const });

/** `true` mientras el aparato no tiene señal (según la cola del SDK). */
export function useSinRed(): boolean {
  return !useOutbox().online;
}
