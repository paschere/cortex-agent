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
  className?: string;
}) {
  return (
    <div
      className={clsx(
        'prose prose-sm max-w-none text-ink',
        'prose-headings:mt-3 prose-headings:font-bold prose-headings:text-ink',
        'prose-p:my-1.5 prose-p:leading-relaxed prose-li:my-0.5',
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
              // Sin documento no hay nada que prometer: el número, apagado.
              return (
                <sup className="ml-px align-super font-mono text-[0.7em] text-ink-faint">
                  {cite}
                </sup>
              );
            }

            const label = citationLabel(source);
            return (
              // `group` + `focus-within`: se abre con el ratón y también
              // tabulando, que es la única razón por la que el número es
              // enfocable. `title` va además para quien pase por encima antes de
              // que el panel termine de aparecer.
              <span className="group relative inline-block align-baseline">
                <sup
                  tabIndex={0}
                  title={label}
                  aria-label={`Fuente: ${label}`}
                  className={clsx(
                    'tabular ml-0.5 cursor-default rounded-pill bg-primary-soft px-1.5 py-px align-super',
                    'font-mono text-[0.68em] font-semibold text-primary-ink',
                    'transition-colors duration-150 group-hover:bg-primary/15 motion-reduce:transition-none',
                  )}
                >
                  {cite}
                </sup>
                <span
                  role="tooltip"
                  className={clsx(
                    'pointer-events-none absolute bottom-full left-1/2 z-30 mb-1 hidden w-max max-w-[min(20rem,70vw)]',
                    '-translate-x-1/2 rounded-sm border border-border bg-surface px-2.5 py-1.5 shadow-pop',
                    'group-hover:block group-focus-within:block',
                  )}
                >
                  <span className="block truncate text-xs font-medium text-ink">
                    {source.title}
                  </span>
                  {/* La edad es evidencia — regla 3 — y cambia lo que vale la
                      cita: una tarifa de hace un año no es la misma frase que la
                      misma tarifa de la semana pasada. */}
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-micro text-ink-faint">
                    {source.age && <span className="tabular font-mono">{source.age}</span>}
                    {source.spokenAt && (
                      <span className="tabular font-mono">min {source.spokenAt}</span>
                    )}
                    {source.relevance === 'weak' && <span>coincidencia floja</span>}
                  </span>
                </span>
              </span>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
