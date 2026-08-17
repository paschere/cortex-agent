'use client';

import type { BrainSource } from '@/lib/brain-sources-shape';
import { citationLabel, citationSource, rehypeCitations } from '@/lib/citations';
import { clsx } from 'clsx';
import type { ComponentPropsWithoutRef } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

/**
 * The single markdown renderer for anything Cortex says — live chat and
 * archived transcripts alike. Kept in one place so a transcript can never
 * drift into looking like a different product.
 */
export function ChatMarkdown({
  content,
  isStreaming,
  sources,
  onCiteClick,
  className,
}: {
  content: string;
  isStreaming?: boolean;
  /**
   * Los documentos del cerebro que se pegaron encima de la pregunta, para poder
   * resolver las marcas `[^1]` de esta respuesta. Ausente —transcripciones
   * viejas, informes, el turno en vuelo antes de que lleguen— dibuja el número
   * apagado y no promete nada. Ver lib/citations.ts.
   */
  sources?: readonly BrainSource[];
  /**
   * Qué hacer cuando alguien pulsa una marca de cita: en el chat, abrir la
   * sección de fuentes de la respuesta y resaltar la que le toca — ver
   * BrainSources y el estado que MessageBubble teje entre los dos. Ausente
   * (informes, transcripciones), la marca no es un botón: un botón que no hace
   * nada es peor que un número quieto.
   */
  onCiteClick?: (cite: number) => void;
  className?: string;
}) {
  return (
    <div
      className={clsx(
        'prose prose-sm max-w-none text-ink',
        /*
          UN SOLO TAMAÑO DE ENCABEZADO DENTRO DE UNA RESPUESTA.

          Eran `font-bold` en la escala del plugin, o sea un `##` a ~16,6px en
          negrita. Ahora que la pregunta es el titular de su respuesta —19px,
          semibold, colgada al margen— un encabezado del modelo a 16,6px negrita
          competía por el mismo papel a dos píxeles de distancia. Se fija en
          `text-base`, que es el token que el sistema de diseño reserva para «el
          nombre de lo que estás mirando»: manda dentro de la respuesta y nunca
          sobre ella. Lo que separa de verdad a los dos es la sangría, no el
          tamaño — ver MessageBubble.
        */
        'prose-headings:mt-5 prose-headings:mb-1.5 prose-headings:text-base',
        'prose-headings:font-semibold prose-headings:text-ink',
        /*
          LA MEDIDA DE LA PROSA, Y POR QUÉ NO ES LA DE LA COLUMNA.

          Medido en pantalla: con el ancho entero del cuerpo, un renglón de una
          respuesta llegaba a ~110 caracteres. La tipografía lleva un siglo
          diciendo que el ojo pierde el principio del renglón siguiente por
          encima de 90, y esta gente lee aquí ocho horas.

          Se limita el PÁRRAFO y el punto de una lista, no el contenedor: una
          tabla o un bloque de código dentro de una respuesta necesitan el ancho
          entero, y `prose` lo capa a 65ch si se le deja (por eso el
          `max-w-none` de arriba, que se queda). Columna de texto estrecha y
          figuras anchas es lo que hace un documento, y es exactamente lo que
          esta pantalla dice que es.

          En `ch` y no en píxeles a propósito: la medida se cuenta en
          caracteres, así que se escribe en caracteres.
        */
        'prose-p:my-2.5 prose-p:leading-relaxed prose-p:max-w-[64ch]',
        'prose-li:my-0.5 prose-li:max-w-[62ch]',
        'prose-strong:text-ink prose-strong:font-semibold',
        'prose-a:text-primary prose-a:no-underline hover:prose-a:underline',
        'prose-code:rounded-sm prose-code:bg-surface-2 prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.85em] prose-code:font-medium prose-code:text-primary-ink prose-code:before:content-[""] prose-code:after:content-[""]',
        'prose-pre:rounded-card prose-pre:border prose-pre:border-border prose-pre:shadow-card',
        'prose-table:text-sm prose-th:text-ink prose-td:text-ink-muted',
        /*
          EL TEXTO QUE TODAVÍA SE ESTÁ RESOLVIENDO.
          Una máscara sobre el borde final mientras llega. Ver `.answer-landing`
          en globals.css — el argumento entero, y la medición que descartó
          animar palabra por palabra, están ahí.
        */
        isStreaming && 'answer-landing',
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // `rehypeCitations` después de `rehypeHighlight`: el resaltado sólo toca
        // `code`, que es justo donde las citas no entran. El orden da igual y se
        // deja explícito para que se vea que se pensó.
        rehypePlugins={[rehypeHighlight, rehypeCitations]}
        components={{
          /**
           * LA CITA EN LÍNEA.
           *
           * `sup` sin `data-cite` no es una cita: markdown no genera esta
           * etiqueta por ningún camino, pero se comprueba igual antes de
           * dibujar una pastilla — un componente que se fía de que nadie más va
           * a producir su etiqueta es un componente que se rompe el día que
           * alguien active `rehype-raw`.
           *
           * =================================================================
           * EN LA LÍNEA BASE Y SIN TOOLTIP, Y LAS DOS COSAS SON EL ARREGLO
           * =================================================================
           * Esto era un superíndice con un panel flotante en hover. El
           * superíndice rompía el interlineado —el renglón con cita quedaba
           * más alto que sus vecinos y el número flotaba huérfano tras un
           * paréntesis— y el panel TAPABA el texto del mensaje para decir algo
           * que ya tiene su sitio: la sección de fuentes bajo la respuesta.
           * El dueño lo dijo exacto: «aparecen feo, y solo al hover».
           *
           * Ahora es una pastilla micro alineada a la base, pegada a la
           * palabra que cita, y PULSARLA lleva a la fuente: abre la sección de
           * abajo y resalta la fila con su mismo número. El hover no tapa
           * nada; el `title` nativo queda como pista para quien pase por
           * encima sin pulsar.
           */
          sup({
            children,
            // `react-markdown` pasa el nodo de hast a cada componente. Se saca
            // aquí para que no acabe esparcido sobre un elemento del DOM, que
            // es un aviso de React y un atributo inventado en el HTML.
            node: _node,
            ...props
          }: ComponentPropsWithoutRef<'sup'> & { node?: unknown; 'data-cite'?: string }) {
            const cite = Number(props['data-cite']);
            if (!Number.isInteger(cite) || cite <= 0) return <sup {...props}>{children}</sup>;

            const source = citationSource(sources, cite);
            if (!source) {
              // Sin documento no hay nada que prometer: el número, apagado y
              // quieto — también en la línea base, que un huérfano no tiene
              // por qué romper además el renglón.
              return (
                <span className="tabular ml-0.5 inline-block align-baseline font-mono text-micro text-ink-faint">
                  {cite}
                </span>
              );
            }

            const label = citationLabel(source);
            const pill = clsx(
              'tabular ml-0.5 inline-block rounded-pill bg-primary-soft px-1.5 align-baseline',
              'font-mono text-micro font-semibold leading-snug text-primary-ink',
            );
            if (!onCiteClick) {
              // Sin sección a la que llevar (informes, transcripciones) la
              // marca nombra su documento en el `title` y nada más.
              return (
                <span title={label} aria-label={`Fuente ${cite}: ${label}`} className={pill}>
                  {cite}
                </span>
              );
            }
            return (
              <button
                type="button"
                onClick={() => onCiteClick(cite)}
                title={label}
                aria-label={`Fuente ${cite}: ${label}. Ver en las fuentes de la respuesta.`}
                className={clsx(
                  pill,
                  'cursor-pointer transition-colors duration-150 hover:bg-primary/15 motion-reduce:transition-none',
                )}
              >
                {cite}
              </button>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
