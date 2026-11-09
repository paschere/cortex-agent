import { useCallback, useEffect, useRef, useState } from 'react';
import { withUpdates } from './bridge';
import { cortex } from './cortex';
import {
  EMPTY_OUTBOX,
  getLiveStatus,
  getOutbox,
  isHostVisible,
  onHostVisible,
  onLiveStatus,
  onOutbox,
} from './events';
import type {
  LiveEvent,
  LiveOptions,
  LiveStatus,
  OutboxItem,
  OutboxState,
  QueryOptions,
  SdkLocation,
  SdkRow,
  SdkUser,
} from './types';

/**
 * Ganchos de React. Los que refrescan solos (`refreshMs`) se pausan mientras la
 * pestaña está oculta y refrescan al volver, para no gastar llamadas (el tope
 * es de 120 por minuto).
 */

/** Con la pestaña a la vista Y con el marco mostrando esta pantalla (los iframes vivos se ocultan). */
function visible(): boolean {
  return (
    isHostVisible() && (typeof document === 'undefined' || document.visibilityState !== 'hidden')
  );
}

/** Rebote entre el aviso de cambio y la relectura (varias escrituras seguidas = una lectura). */
export const LIVE_DEBOUNCE_MS = 300;
/** Sondeo de respaldo cuando el canal en vivo no está conectado. */
export const LIVE_FALLBACK_MS = 30_000;

/** Carga con `load` ahora y cada `refreshMs`, solo con la pantalla visible. */
function useLoader<T>(
  load: () => Promise<T>,
  deps: unknown[],
  refreshMs?: number,
  liveTables?: string[],
) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const alive = useRef(true);
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);

  const refresh = useCallback(async () => {
    try {
      // Las llamadas de `load` piden respuesta en dos tiempos: si el host contestó con lo guardado
      // y luego llega el dato fresco, se vuelve a cargar (ahora el host ya lo tiene al día).
      const next = await withUpdates(
        () => {
          if (alive.current) void refreshRef.current();
        },
        () => loadRef.current(),
      );
      if (!alive.current) return;
      setData(next);
      setError(null);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : 'No se pudo cargar.');
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);
  refreshRef.current = refresh;

  const liveKey = liveTables?.length ? [...liveTables].sort().join(',') : '';
  // Con el canal en vivo conectado no hace falta sondear; sin él, un respaldo cada 30 s.
  const status = useLiveStatus(Boolean(liveKey));
  const pollMs = liveKey
    ? status === 'live'
      ? 0
      : Math.min(refreshMs && refreshMs > 0 ? refreshMs : LIVE_FALLBACK_MS, LIVE_FALLBACK_MS)
    : (refreshMs ?? 0);
  // Algo cambió mientras la pantalla estaba oculta: se vuelve a leer al mostrarse.
  const dirty = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `deps` es la lista del llamador.
  useEffect(() => {
    alive.current = true;
    setLoading(true);
    void refresh();
    return () => {
      alive.current = false;
    };
  }, [refresh, ...deps]);

  useEffect(() => {
    const timer =
      pollMs > 0
        ? setInterval(() => {
            if (visible()) void refresh();
          }, pollMs)
        : null;
    const refreshIfVisible = () => {
      if (!visible()) return;
      if (pollMs > 0 || dirty.current) {
        dirty.current = false;
        void refresh();
      }
    };
    document.addEventListener('visibilitychange', refreshIfVisible);
    const offVisible = onHostVisible(refreshIfVisible);
    return () => {
      if (timer) clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshIfVisible);
      offVisible();
    };
  }, [refresh, pollMs]);

  useEffect(() => {
    if (!liveKey) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = cortex.live.subscribe(liveKey.split(','), () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        if (!alive.current) return;
        if (visible()) void refreshRef.current();
        else dirty.current = true;
      }, LIVE_DEBOUNCE_MS);
    });
    return () => {
      if (t) clearTimeout(t);
      off();
    };
  }, [liveKey]);

  return { data, loading, error, refresh };
}

/**
 * Carga lo que devuelva `load` ahora, cuando cambie `deps` y cada `refreshMs` (sondeo: se pausa
 * con la pestaña oculta y refresca al volver). Sirve para combinar varias llamadas del SDK.
 */
export function useAsync<T>(
  load: () => Promise<T>,
  deps: unknown[] = [],
  config: { refreshMs?: number } = {},
): { data: T | null; loading: boolean; error: string | null; refresh: () => Promise<void> } {
  return useLoader(load, deps, config.refreshMs);
}

/** Quién usa la pantalla. */
export function useUser(): { user: SdkUser | null; loading: boolean; error: string | null } {
  const { data, loading, error } = useLoader(() => cortex.user.me(), []);
  return { user: data, loading, error };
}

/** Filas de una tabla, con refresco opcional. `opts` se compara por valor. */
export function useQuery(
  table: string,
  opts: QueryOptions = {},
  config: LiveOptions = {},
): { rows: SdkRow[]; loading: boolean; error: string | null; refresh: () => Promise<void> } {
  const key = JSON.stringify(opts);
  const { data, loading, error, refresh } = useLoader(
    () => cortex.tables.query(table, opts),
    [table, key],
    config.refreshMs,
    config.live ? [table] : undefined,
  );
  return { rows: data?.rows ?? [], loading, error, refresh };
}

/** Ubicaciones en vivo (solo si el rol puede verlas). */
export function useLocations(config: { refreshMs?: number } = {}): {
  locations: SdkLocation[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const { data, loading, error, refresh } = useLoader(
    () => cortex.locations.live(),
    [],
    config.refreshMs,
  );
  return { locations: data ?? [], loading, error, refresh };
}

/** El estado del canal en vivo (`live` | `reconnecting` | `off`); se repinta cuando cambia. */
export function useLiveStatus(enabled = true): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>(() => getLiveStatus());
  useEffect(() => {
    if (!enabled) return;
    setStatus(getLiveStatus());
    return onLiveStatus(setStatus);
  }, [enabled]);
  return status;
}

/** Avisa (`cb`) cuando cambia alguna de estas tablas. Sin rebote: úsalo para reaccionar, no para releer. */
export function useLive(tables: string[], cb: (ev: LiveEvent) => void): void {
  const cbRef = useRef(cb);
  cbRef.current = cb;
  const key = [...tables].sort().join(',');
  useEffect(() => {
    if (!key) return;
    return cortex.live.subscribe(key.split(','), (ev) => cbRef.current(ev));
  }, [key]);
}

/** La cola sin señal: cuántas operaciones esperan, cuáles, cuáles fallaron y cómo reintentar. */
export function useOutbox(): {
  pending: number;
  items: OutboxItem[];
  failed: number;
  online: boolean;
  retry: () => Promise<void>;
  discard: (localId: string) => Promise<void>;
} {
  const [state, setState] = useState<OutboxState>(() => getOutbox());
  useEffect(() => {
    setState(getOutbox());
    const off = onOutbox(setState);
    // El host guarda la cola entre pantallas: se le pide la actual al montar.
    void cortex.outbox.list().then(() => setState(getOutbox()));
    return off;
  }, []);
  const retry = useCallback(() => cortex.outbox.retry(), []);
  const discard = useCallback((id: string) => cortex.outbox.discard(id), []);
  const s = state ?? EMPTY_OUTBOX;
  return { pending: s.pending, items: s.items, failed: s.failed, online: s.online, retry, discard };
}
