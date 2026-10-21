'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * «PARECE QUE YA EXISTE» EN EL FORMULARIO.
 *
 * Mientras la persona llena, y con una pausa, se pregunta al servidor si ya hay
 * una fila igual (misma regla de duplicados de la tabla, sólo lo que el rol
 * puede ver). Sólo avisa: no bloquea nada. La primera respuesta dice qué
 * campos mira (`keys`); después sólo se vuelve a preguntar si cambian ésos.
 * Sin señal o con un error, no hay aviso y el formulario sigue como siempre.
 */

export interface DuplicateMatch {
  id: string;
  label: string;
  why: string;
}

interface Response {
  keys: string[];
  matches: DuplicateMatch[];
  openIn: string | null;
}

const PAUSE_MS = 700;

export function useDuplicateHint({
  url,
  blockId,
  values,
  enabled,
}: {
  url: string | null;
  blockId: string;
  values: Record<string, string>;
  enabled: boolean;
}) {
  const [found, setFound] = useState<Response | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const keysRef = useRef<string[] | null>(null);
  const lastRef = useRef('');
  const ackedRef = useRef(false);
  const matchesRef = useRef(0);
  const valuesRef = useRef(values);
  valuesRef.current = values;

  // Lo que decide si se vuelve a preguntar: los campos clave, o todo mientras no se sepan.
  const signature = JSON.stringify(
    keysRef.current ? keysRef.current.map((k) => values[k] ?? '') : values,
  );

  useEffect(() => {
    if (!enabled || !url) return;
    if (keysRef.current && keysRef.current.length === 0) return;
    const current = valuesRef.current;
    const worthAsking = (keysRef.current ?? Object.keys(current)).some(
      (k) => (current[k] ?? '').trim().length >= 3,
    );
    if (!worthAsking) {
      matchesRef.current = 0;
      setFound(null);
      return;
    }
    if (signature === lastRef.current) return;
    const ctl = new AbortController();
    const t = window.setTimeout(async () => {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ block: blockId, values: valuesRef.current }),
          signal: ctl.signal,
        });
        if (!res.ok) return;
        const body = (await res.json()) as Response;
        if (ctl.signal.aborted) return;
        lastRef.current = signature;
        keysRef.current = body.keys;
        setFound(body);
        ackedRef.current = false;
        matchesRef.current = body.matches.length;
        setAcknowledged(false);
      } catch {
        // Sin señal o cortado: sin aviso, el formulario sigue igual.
      }
    }, PAUSE_MS);
    return () => {
      ctl.abort();
      window.clearTimeout(t);
    };
  }, [enabled, url, blockId, signature]);

  const matches = enabled && found ? found.matches : [];
  const reset = useCallback(() => {
    setFound(null);
    setAcknowledged(false);
    ackedRef.current = false;
    matchesRef.current = 0;
    lastRef.current = '';
  }, []);
  return {
    matches,
    openIn: found?.openIn ?? null,
    /** Hay un aviso sin atender: el primer «Enviar» lo muestra en vez de guardar. */
    pending: matches.length > 0 && !acknowledged,
    /** Lectura al instante (sin esperar un render): para el clic de «Guardar igual». */
    isPending: () => enabled && matchesRef.current > 0 && !ackedRef.current,
    acknowledge: () => {
      ackedRef.current = true;
      setAcknowledged(true);
    },
    reset,
  };
}
