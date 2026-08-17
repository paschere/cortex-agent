'use client';

import { Loader2 } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useMemo } from 'react';
import { num, plural } from '../format';
import { usePrefersReducedMotion } from '../motion';
import type { ConstellationData } from '../types';
import { PALETTE_CSS, placeConstellation } from './layout';

/**
 * La vista Constelación: el marco alrededor de la escena.
 *
 * POR QUÉ `next/dynamic` CON `ssr: false`. three + fiber + drei son el trozo
 * más pesado de JavaScript de esta pantalla y no sirven de nada en el
 * servidor (WebGL no existe ahí). El import dinámico hace dos cosas: el
 * bundle solo se descarga cuando alguien toca «Constelación» — quien vive en
 * la lista nunca lo paga — y el HTML del servidor nunca intenta renderizar un
 * canvas que no puede existir.
 *
 * LA ESCENA NO ES LA ÚNICA PUERTA. Igual que el mapa de relieve: todo lo que
 * se abre tocando una esfera se abre también desde la vista Lista, con
 * teclado y con lector de pantalla. Por eso el contenedor es `role="img"` con
 * una descripción honesta, en vez de fingir que un canvas es navegable.
 */
const Scene = dynamic(() => import('./Scene').then((m) => m.ConstellationScene), {
  ssr: false,
  loading: () => (
    <div className="grid h-full place-items-center">
      <p className="flex items-center gap-1.5 text-xs text-rail-ink-faint">
        <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
        Armando la constelación…
      </p>
    </div>
  ),
});

export function ConstellationView({
  data,
  onOpenDocument,
}: {
  data: ConstellationData;
  onOpenDocument: (id: string) => void;
}) {
  const reduced = usePrefersReducedMotion();

  // El layout es determinista y puro; se calcula una vez por cambio de datos
  // y jamás dentro de un frame.
  const clusters = useMemo(() => placeConstellation(data.spaces), [data.spaces]);
  const docCount = useMemo(
    () => data.spaces.reduce((sum, s) => sum + s.documents.length, 0),
    [data.spaces],
  );

  // Los que más pesan primero, que es como se lee un cielo: por brillo.
  const legend = useMemo(
    () =>
      [...clusters].sort(
        (a, b) =>
          b.docs.reduce((n, d) => n + d.chunkCount, 0) -
          a.docs.reduce((n, d) => n + d.chunkCount, 0),
      ),
    [clusters],
  );

  return (
    <div className="px-5 py-4">
      <div
        role="img"
        aria-label={`Constelación del cerebro: ${plural(data.spaces.length, 'espacio', 'espacios')} y ${plural(docCount, 'documento en memoria', 'documentos en memoria')}. Para navegar con teclado usa la vista Lista.`}
        className="relative h-[420px] w-full overflow-hidden rounded-card bg-rail lg:h-[520px]"
      >
        <Scene clusters={clusters} reduced={reduced} onOpenDocument={onOpenDocument} />
      </div>

      {/* La clave del cielo: qué cúmulo es qué espacio, y cuánto pesa. */}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {legend.map((cluster) => (
          <span key={cluster.id} className="inline-flex min-w-0 items-center gap-1.5">
            <span
              aria-hidden
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: cluster.color ?? PALETTE_CSS[cluster.paletteIndex] }}
            />
            <span className="max-w-[160px] truncate text-micro font-semibold text-ink-muted">
              {cluster.name}
            </span>
            <span className="tabular text-micro text-ink-faint">{num(cluster.docs.length)}</span>
          </span>
        ))}
      </div>

      <p className="mt-1.5 text-micro text-ink-faint">
        Cada esfera es un documento; su tamaño, cuántos fragmentos dejó en memoria. Arrastra para
        girar y toca una esfera para abrirla.
        {/* El recorte se dice en voz alta: presentar los 220 más recientes
            como si fueran el todo sería un cielo que miente por omisión. */}
        {data.total > data.considered &&
          ` Se dibujan los ${num(data.considered)} más recientes de ${num(data.total)}.`}
      </p>
    </div>
  );
}
