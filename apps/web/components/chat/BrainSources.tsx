'use client';

import { type BrainSource, brainSourceLabel } from '@/lib/brain-sources-shape';
import { clsx } from 'clsx';
import { Brain, ChevronDown } from 'lucide-react';
import { useState } from 'react';

/**
 * DE DÓNDE SALIÓ ESTO, JUNTO A LOS BOTONES DE LA RESPUESTA.
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
 * POR QUÉ VA EN LA FILA DE LOS BOTONES
 * ===========================================================================
 * Porque es lo que se hace CON una respuesta terminada: copiarla, rehacerla,
 * conservarla… y comprobar de dónde salió. Encima del texto interrumpiría la
 * lectura para decir algo que sólo importa cuando ya se leyó; en una tarjeta
 * propia sería un tercer bloque compitiendo con la respuesta.
 *
 * Y sigue la regla que `docs/design-system.md` fija para la procedencia: **un
 * valor sin procedencia no lleva chip**. Sin fuentes esto no dibuja nada — ni
 * un «sin fuentes», ni un chip apagado, ni un hueco. Un turno que se contestó
 * de memoria y uno que leyó tres contratos tienen que verse distintos, y la
 * única forma es que el segundo añada algo y el primero no.
 *
 * ===========================================================================
 * CERRADO POR DEFECTO, Y LOS TÍTULOS A UN CLIC
 * ===========================================================================
 * La línea dice cuántos y el despliegue dice cuáles, con su edad y con la marca
 * de coincidencia floja. Esa marca se enseña a propósito: un dato traído por
 * una coincidencia justa es un dato que hay que mirar antes de repetírselo a un
 * cliente, y esconder esa diferencia convierte las dos cosas en la misma.
 */
export function BrainSources({ sources }: { sources: readonly BrainSource[] }) {
  const [open, setOpen] = useState(false);
  const label = brainSourceLabel(sources);
  if (!label) return null;

  return (
    <span className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-full py-1.5 pl-1.5 pr-2 text-micro text-ink-faint transition-colors duration-150 hover:bg-primary-soft hover:text-primary-ink motion-reduce:transition-none"
      >
        <Brain className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="truncate">Del cerebro · {label}</span>
        <ChevronDown
          className={clsx(
            'h-3 w-3 shrink-0 transition-transform duration-150 motion-reduce:transition-none',
            open && 'rotate-180',
          )}
          aria-hidden
        />
      </button>

      {open && (
        // Debajo y en el flujo, no flotando: un panel absoluto sobre el último
        // mensaje de una conversación queda tapado por el compositor, que es
        // exactamente donde está esta fila.
        <ul className="absolute bottom-full left-0 z-20 mb-1 w-[min(22rem,80vw)] list-none space-y-1.5 rounded-card border border-border bg-surface p-2.5 shadow-pop">
          {sources.map((s) => (
            <li key={s.documentId} className="flex items-start gap-2">
              <span
                aria-hidden
                className={clsx(
                  'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-pill',
                  s.relevance === 'weak' ? 'bg-ink-faint' : 'bg-primary',
                )}
              />
              <span className="min-w-0 flex-1">
                {/*
                  UN TÍTULO, NO UN ENLACE. Comprobado: no existe ninguna ruta
                  `/kb/documents/[id]` en esta app, y `/kb` no abre un documento
                  por parámetro. Un enlace que lleva a un 404 es peor que un
                  título quieto — promete un sitio al que ir y no lo hay. El día
                  que exista esa pantalla, esto se vuelve un enlace en una línea.
                */}
                <span className="block truncate text-xs text-ink" title={s.title}>
                  {s.title}
                </span>
                {/* La edad va en monoespaciada porque es evidencia — regla 3 del
                    sistema de diseño — y porque «de hace 8 días» y «del 3 de
                    marzo de 2026» cambian lo que vale la cita. */}
                <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-micro text-ink-faint">
                  {s.age && <span className="tabular font-mono">{s.age}</span>}
                  {s.spokenAt && <span className="tabular font-mono">min {s.spokenAt}</span>}
                  {s.relevance === 'weak' && <span>coincidencia floja</span>}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}
