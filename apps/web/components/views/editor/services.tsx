'use client';

import type { EditorCatalog, PreviewResult } from '@/lib/views/editor-spec';
import { createContext, useContext } from 'react';

/**
 * DE DÓNDE SACA EL LIENZO SUS DOS LECTURAS.
 *
 * El catálogo de fuentes (`/api/views/catalog`) y la vista previa
 * (`/api/views/preview`). Van detrás de un contexto y no escritas dentro de
 * los componentes por una razón concreta: la QA visual del lienzo pinta el
 * editor con datos de mentira, fuera de la sesión, y necesita cambiar estas
 * dos llamadas por otras sin tocar el editor. En la app nadie pone el
 * proveedor y se usan las de verdad.
 */

export interface PreviewRequest {
  spec: unknown;
  viewId?: string;
  newTrackers?: unknown[];
}

export interface EditorServices {
  loadCatalog: (viewId?: string) => Promise<EditorCatalog>;
  preview: (input: PreviewRequest, signal: AbortSignal) => Promise<PreviewResult>;
}

const fetchServices: EditorServices = {
  async loadCatalog(viewId) {
    const url = viewId
      ? `/api/views/catalog?viewId=${encodeURIComponent(viewId)}`
      : '/api/views/catalog';
    const res = await fetch(url, { cache: 'no-store' });
    const body = (await res.json().catch(() => null)) as
      | (EditorCatalog & { error?: string })
      | null;
    if (!res.ok || !body?.sources)
      throw new Error(body?.error ?? 'No se pudieron leer las tablas.');
    return body;
  },
  async preview(input, signal) {
    try {
      const res = await fetch('/api/views/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
        signal,
      });
      const body = (await res.json().catch(() => null)) as PreviewResult | null;
      return body ?? { ok: false, error: 'Respuesta inválida del servidor.' };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      return {
        ok: false,
        error: 'Sin conexión. La vista previa se reintenta al siguiente cambio.',
      };
    }
  },
};

const ServicesContext = createContext<EditorServices>(fetchServices);

export function EditorServicesProvider({
  services,
  children,
}: {
  services: EditorServices;
  children: React.ReactNode;
}) {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}

export function useEditorServices(): EditorServices {
  return useContext(ServicesContext);
}
