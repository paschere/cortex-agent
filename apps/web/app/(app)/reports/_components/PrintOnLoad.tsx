'use client';

import { useEffect } from 'react';

/**
 * Abre el diálogo de imprimir cuando la dirección pide `?print=1`.
 *
 * El informe ya es una fotografía en HTML. El PDF que alguien archiva es esa
 * misma fotografía, pasada por «Guardar como PDF» del navegador — sin un
 * Chromium en el servidor y sin una segunda cifra que pueda discrepar.
 */
export function PrintOnLoad({ active }: { active: boolean }) {
  useEffect(() => {
    if (!active) return;
    const id = window.setTimeout(() => window.print(), 50);
    return () => window.clearTimeout(id);
  }, [active]);
  return null;
}
