'use client';

import { type BrainSource, brainSourceLabel } from '@/lib/brain-sources-shape';
import { clsx } from 'clsx';
import { Brain, ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

/**
 * LAS FUENTES DE LA RESPUESTA, VISIBLES SIN HOVER.
 *
 * ===========================================================================
 * EL CAMINO INVISIBLE
 * ===========================================================================
 * Cortex lee Brain Knowledge de dos maneras. Cuando el modelo llama a
 * `kb.search` a mitad del turno, eso aparece como un paso en la lista con su
 * nombre y su tiempo. Pero el camino NORMAL es el otro: antes de que el modelo
 * vea la pregunta, la ruta del chat busca en el cerebro y pega los fragmentos
 * encima. Eso no es una llamada a ninguna herramienta, así que no dejaba ni un
 * píxel — la respuesta citaba un contrato y nada decía que lo hubiera leído.
 *
 * ===========================================================================
 * UNA SECCIÓN EN EL FLUJO, NO UN PANEL FLOTANTE — Y ES EL ARREGLO
 * ===========================================================================
 * Esto era una fila «Del cerebro · <título>…» cuyo despliegue era un panel
 * absoluto flotando sobre el mensaje, y las citas del texto abrían ADEMÁS su
 * propio tooltip en hover que tapaba la prosa. El dueño lo dijo llano: no
 * entendía qué eran. Ahora hay UNA sola verdad, quieta y en el flujo:
 *
 *   · colapsada, la fila dice «Del cerebro · N fuentes» — qué es y cuántas;
 *   · expandida, lista cada fuente con EL MISMO NÚMERO que su pastilla en el
 *     texto, el título completo y su procedencia (edad, minuto, coincidencia);
 *   · pulsar una pastilla del texto expande esto y resalta la fila que le
 *     toca — `focus` viene de MessageBubble, que es quien ve a los dos.
 *
 * Una respuesta con fuentes y CERO marcas en el texto (pasa) lista sus fuentes
 * igual: la sección sale de `sources`, no de las marcas.
 *
 * Sigue la regla de `docs/design-system.md` para la procedencia: **un valor
 * sin procedencia no lleva chip**. Sin fuentes esto no dibuja nada — ni un
 * «sin fuentes», ni un hueco.
 */

/** Una pulsación en una marca del texto. `nonce` distingue dos clics a la
 *  misma cita — un estado que no cambia no dispara nada. */
export interface CiteFocus {
  cite: number;
  nonce: number;
}

/** Cuánto dura el resaltado de la fila aterrizada, en ms. Lo justo para
 *  encontrarla con el ojo; no un estado que se queda encendido. */
const HIGHLIGHT_MS = 1600;

export function BrainSources({
  sources,
  focus,
}: {
  sources: readonly BrainSource[];
  /** La marca pulsada en el texto, si alguien pulsó una. Ver MessageBubble. */
  focus?: CiteFocus | null;
}) {
  const [open, setOpen] = useState(false);
  /** El documento aterrizado, mientras dura su resaltado. */
  const [lit, setLit] = useState<string | null>(null);
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    if (!focus) return;
    setOpen(true);
    const target = sources.find((s) => s.citations?.includes(focus.cite));
    // Una marca que no resuelve (número inventado, fila vieja sin números)
    // abre la sección y nada más: mejor la lista entera que un resalte falso.
    if (!target) return;
    setLit(target.documentId);
    const dim = setTimeout(() => setLit(null), HIGHLIGHT_MS);
    // Tras el paint: la lista puede estar recién abierta en este mismo commit.
    const raf = requestAnimationFrame(() => {
      const el = listRef.current?.querySelector(`[data-doc="${target.documentId}"]`);
      // El guard de movimiento: con prefers-reduced-motion el salto es
      // instantáneo — se llega igual, sin animar el viaje.
      const reduced =
        typeof window !== 'undefined' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      el?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'nearest' });
    });
    return () => {
      clearTimeout(dim);
      cancelAnimationFrame(raf);
    };
  }, [focus, sources]);

  const label = brainSourceLabel(sources);
  if (!label) return null;

  return (
    <section aria-label="Fuentes de esta respuesta" className="mt-2.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="-ml-1.5 inline-flex items-center gap-1.5 rounded-full py-1 pl-1.5 pr-2 text-micro text-ink-faint transition-colors duration-150 hover:bg-primary-soft hover:text-primary-ink motion-reduce:transition-none"
      >
        <Brain className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>Del cerebro · {label}</span>
        <ChevronDown
          className={clsx(
            'h-3 w-3 shrink-0 transition-transform duration-150 motion-reduce:transition-none',
            open && 'rotate-180',
          )}
          aria-hidden
        />
      </button>

      {open && (
        // En el flujo, no flotando: la lista empuja lo de abajo en vez de
        // taparlo — un panel absoluto sobre el último mensaje quedaba debajo
        // del compositor, y sobre uno de en medio tapaba la respuesta.
        <ol ref={listRef} className="mt-1 list-none space-y-0.5">
          {sources.map((s) => (
            <li
              key={s.documentId}
              data-doc={s.documentId}
              className={clsx(
                'flex items-start gap-2 rounded-sm px-1.5 py-1',
                'transition-colors duration-300 motion-reduce:transition-none',
                // El resaltado del aterrizaje usa el mismo token que la
                // pastilla que lo trajo: primary-soft, y nada inventado.
                lit === s.documentId && 'bg-primary-soft',
              )}
            >
              {s.citations && s.citations.length > 0 ? (
                // EL MISMO NÚMERO QUE LA PASTILLA DEL TEXTO — es lo que ata la
                // frase con su documento. Un documento citado dos veces lleva
                // sus dos números.
                <span className="flex shrink-0 flex-wrap gap-0.5 pt-px">
                  {s.citations.map((n) => (
                    <span
                      key={n}
                      className="tabular rounded-pill bg-primary-soft px-1.5 font-mono text-micro font-semibold leading-snug text-primary-ink"
                    >
                      {n}
                    </span>
                  ))}
                </span>
              ) : (
                // Filas de antes de que existieran los números: el punto de
                // siempre, que no promete una marca que el texto no tiene.
                <span
                  aria-hidden
                  className={clsx(
                    'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-pill',
                    s.relevance === 'weak' ? 'bg-ink-faint' : 'bg-primary',
                  )}
                />
              )}
              <span className="min-w-0 flex-1">
                {/*
                  EL TÍTULO COMPLETO, sin truncar: la fila ya no vive en un
                  panel de 22rem — tiene el ancho de la respuesta, y el título
                  es lo único que deja reconocer el documento.

                  UN TÍTULO, NO UN ENLACE. Comprobado: no existe ninguna ruta
                  `/kb/documents/[id]` en esta app, y `/kb` no abre un documento
                  por parámetro. Un enlace que lleva a un 404 es peor que un
                  título quieto. El día que exista esa pantalla, esto se vuelve
                  un enlace en una línea.
                */}
                <span className="block text-xs text-ink">{s.title}</span>
                {/* La edad va en monoespaciada porque es evidencia — regla 3
                    del sistema de diseño — y porque «de hace 8 días» y «del 3
                    de marzo de 2026» cambian lo que vale la cita. */}
                <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-micro text-ink-faint">
                  {s.age && <span className="tabular font-mono">{s.age}</span>}
                  {s.spokenAt && <span className="tabular font-mono">min {s.spokenAt}</span>}
                  {s.relevance === 'weak' && <span>coincidencia floja</span>}
                </span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
