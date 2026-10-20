'use client';

import {
  type ConnectionState,
  nextConnection,
  probeDelayMs,
} from '@/lib/forms/connection-state';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * La conexión de verdad, no la que cree el navegador (ver
 * lib/forms/connection-state.ts). Se alimenta de los eventos `online`/`offline`,
 * de los fallos de red que avisan los envíos (`cortex:net-failure`) y de una
 * comprobación liviana al servidor (un HEAD sin caché) con espera creciente.
 *
 * Cuando el servidor vuelve a contestar avisa `cortex:reconnected` para que las
 * colas se vacíen de inmediato en vez de esperar su reloj de 30 s.
 */

const PROBE_URL = '/favicon.ico';

/** Un envío o lectura que falló por red: lo oyen todas las píldoras de la página. */
export function reportNetworkFailure() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('cortex:net-failure'));
}

export function useConnection(): { state: ConnectionState; check: () => void } {
  const [state, setState] = useState<ConnectionState>('online');
  const ref = useRef<ConnectionState>('online');
  const failures = useRef(0);
  const timer = useRef<number | undefined>(undefined);

  const apply = useCallback((next: ConnectionState) => {
    const was = ref.current;
    ref.current = next;
    setState(next);
    if (next === 'online' && was !== 'online') {
      failures.current = 0;
      window.dispatchEvent(new Event('cortex:reconnected'));
    }
  }, []);

  const probe = useCallback(async () => {
    window.clearTimeout(timer.current);
    let ok = false;
    try {
      const ctl = new AbortController();
      const kill = window.setTimeout(() => ctl.abort(), 6000);
      const res = await fetch(`${PROBE_URL}?_=${Date.now()}`, {
        method: 'HEAD',
        cache: 'no-store',
        signal: ctl.signal,
      });
      window.clearTimeout(kill);
      ok = res.ok || res.status < 500;
    } catch {
      ok = false;
    }
    apply(nextConnection(ref.current, { type: 'probe', ok }));
    if (!ok) {
      failures.current += 1;
      // Sigue intentando, cada vez más despacio, mientras haya red enlazada.
      timer.current = window.setTimeout(
        () => void probe(),
        probeDelayMs(failures.current),
      );
    }
  }, [apply]);

  useEffect(() => {
    if (navigator.onLine === false) apply('offline');
    const on = () => {
      apply(nextConnection(ref.current, { type: 'browser', online: true }));
      void probe();
    };
    const off = () => {
      window.clearTimeout(timer.current);
      apply(nextConnection(ref.current, { type: 'browser', online: false }));
    };
    const failed = () => {
      if (ref.current === 'online') {
        apply(nextConnection(ref.current, { type: 'network-failure' }));
        void probe();
      }
    };
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    window.addEventListener('cortex:net-failure', failed);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
      window.removeEventListener('cortex:net-failure', failed);
      window.clearTimeout(timer.current);
    };
  }, [apply, probe]);

  return { state, check: () => void probe() };
}
