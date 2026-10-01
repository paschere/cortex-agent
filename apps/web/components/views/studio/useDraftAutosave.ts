'use client';

import { type StoredDraft, draftKey, parseStoredDraft } from '@/lib/views/studio';
import { useEffect, useRef, useState } from 'react';

/**
 * EL BORRADOR QUE SOBREVIVE A UNA PESTAÑA CERRADA.
 *
 * Mientras hay cambios sin guardar, el estudio copia el borrador al
 * `localStorage` de este navegador (600 ms después del último cambio), uno por
 * vista. Al volver a abrir el estudio, si hay uno distinto de lo guardado, se
 * ofrece recuperarlo: nunca se aplica solo, porque la vista pudo cambiar
 * mientras tanto (otra persona guardó) y quien decide es quien edita.
 *
 * Es una comodidad de este navegador, no un guardado: no viaja a otro equipo
 * ni a otra persona, puede no estar (ventana privada, datos borrados) y en
 * algunos contextos el acceso mismo lanza. Por eso todo va en try/catch y el
 * estudio funciona igual sin él. Guardar de verdad o descartar lo borra.
 */
export function useDraftAutosave<T>({
  viewId,
  version,
  draft,
  dirty,
  initialJson,
}: {
  viewId: string | undefined;
  version: number | null;
  draft: T;
  dirty: boolean;
  /** El borrador con el que abrió el estudio: si lo guardado es igual, no hay nada que ofrecer. */
  initialJson: string;
}) {
  const key = draftKey(viewId);
  const [offer, setOffer] = useState<StoredDraft<T> | null>(null);
  /** Hasta que la persona decide sobre el borrador viejo, no se pisa. */
  const decided = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: sólo al abrir el estudio.
  useEffect(() => {
    let stored: StoredDraft<T> | null = null;
    try {
      stored = parseStoredDraft<T>(window.localStorage.getItem(key));
    } catch {
      stored = null;
    }
    if (stored && JSON.stringify(stored.draft) !== initialJson) setOffer(stored);
    else decided.current = true;
  }, [key]);

  useEffect(() => {
    if (!decided.current) return;
    const id = window.setTimeout(() => {
      try {
        if (dirty) {
          const value: StoredDraft<T> = { draft, at: new Date().toISOString(), version };
          window.localStorage.setItem(key, JSON.stringify(value));
        } else window.localStorage.removeItem(key);
      } catch {
        /* Sin almacenamiento en este navegador: el estudio sigue igual. */
      }
    }, 600);
    return () => window.clearTimeout(id);
  }, [draft, dirty, key, version]);

  return {
    offer,
    /** La persona lo recupera: el estudio lo aplica y desde ahí se sigue guardando. */
    accept() {
      decided.current = true;
      setOffer(null);
    },
    /** Lo descarta: se borra y se empieza a guardar el actual. */
    dismiss() {
      decided.current = true;
      setOffer(null);
      try {
        window.localStorage.removeItem(key);
      } catch {
        /* nada que borrar */
      }
    },
    /** Después de guardar de verdad o de descartar los cambios. */
    clear() {
      try {
        window.localStorage.removeItem(key);
      } catch {
        /* nada que borrar */
      }
    },
  };
}
