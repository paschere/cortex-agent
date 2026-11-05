import { useCallback, useEffect, useRef, useState } from 'react';
import { cortex } from './cortex';
import type { QueryOptions, SdkLocation, SdkRow, SdkUser } from './types';

/**
 * Ganchos de React. Los que refrescan solos (`refreshMs`) se pausan mientras la
 * pestaña está oculta y refrescan al volver, para no gastar llamadas (el tope
 * es de 120 por minuto).
 */

function visible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

/** Carga con `load` ahora y cada `refreshMs`, solo con la pantalla visible. */
function useLoader<T>(load: () => Promise<T>, deps: unknown[], refreshMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const next = await loadRef.current();
      if (!alive.current) return;
      setData(next);
      setError(null);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : 'No se pudo cargar.');
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `deps` decide cuándo se vuelve a cargar.
  useEffect(() => {
    alive.current = true;
    setLoading(true);
    void refresh();
    const timer =
      refreshMs && refreshMs > 0
        ? setInterval(() => {
            if (visible()) void refresh();
          }, refreshMs)
        : null;
    const onVis = () => {
      if (refreshMs && visible()) void refresh();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      alive.current = false;
      if (timer) clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [refresh, refreshMs, ...deps]);

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
  config: { refreshMs?: number } = {},
): { rows: SdkRow[]; loading: boolean; error: string | null; refresh: () => Promise<void> } {
  const key = JSON.stringify(opts);
  const { data, loading, error, refresh } = useLoader(
    () => cortex.tables.query(table, opts),
    [table, key],
    config.refreshMs,
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
