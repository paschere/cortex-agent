'use client';

import type { ComputedBlock } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { Info } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useBlockDesign } from './design';

/**
 * EL TEXTO, EN TRES TONOS (`design.variant`).
 *   - `plain`: el párrafo de siempre.
 *   - `callout`: un aviso con barra del acento y fondo suave, para lo que no
 *     se debe pasar por alto (una instrucción, una advertencia).
 *   - `quote`: una cita o una frase de la casa, grande y en la tipografía de
 *     títulos del cuaderno.
 * El markdown se pinta igual en las tres (sin imágenes, iframes ni scripts).
 */

type Text = Extract<ComputedBlock, { type: 'text' }>;

const PROSE =
  'prose max-w-none text-ink prose-headings:mb-2 prose-headings:font-extrabold prose-headings:tracking-tight prose-headings:text-ink prose-h1:text-xl prose-h2:text-lg prose-h3:text-base prose-p:my-2 prose-p:text-sm prose-p:leading-relaxed prose-p:text-ink-muted prose-a:font-semibold prose-a:text-primary prose-a:no-underline hover:prose-a:underline prose-blockquote:border-l-primary prose-blockquote:font-normal prose-blockquote:not-italic prose-blockquote:text-ink-muted prose-strong:text-ink prose-code:rounded prose-code:bg-surface-2 prose-code:px-1 prose-code:font-mono prose-code:text-xs prose-code:text-ink prose-code:before:content-none prose-code:after:content-none prose-ol:text-sm prose-ul:text-sm prose-li:text-ink-muted prose-li:marker:text-primary prose-hr:border-border prose-th:text-ink prose-td:text-ink-muted';

const QUOTE =
  'max-w-none font-display text-ink prose-p:my-0 prose-p:text-lg prose-p:font-medium prose-p:leading-snug prose-p:tracking-tight prose-p:text-ink sm:prose-p:text-xl prose-strong:text-ink prose-a:text-primary';

export function TextBlock({ block }: { block: Text }) {
  const { variant, design } = useBlockDesign();
  const strong = design?.emphasis === 'strong';
  const markdown = (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      disallowedElements={['img', 'iframe', 'script']}
      components={{
        a: ({ href, children }) => (
          <a href={href} target="_blank" rel="noopener noreferrer nofollow">
            {children}
          </a>
        ),
      }}
    >
      {block.markdown}
    </ReactMarkdown>
  );

  if (variant === 'callout')
    return (
      <div className="view-lite min-w-0">
        <div className="flex gap-3 rounded-card border border-primary/20 border-l-4 border-l-primary bg-primary-soft px-4 py-3.5">
          <span
            aria-hidden
            className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-pill bg-surface text-primary"
          >
            <Info className="h-4 w-4" />
          </span>
          <div className={clsx(PROSE, 'min-w-0 prose-p:text-ink', strong && 'prose-p:font-semibold')}>
            {markdown}
          </div>
        </div>
      </div>
    );

  if (variant === 'quote')
    return (
      <figure className="view-lite relative min-w-0 px-1 py-2 sm:px-3">
        <span
          aria-hidden
          className="absolute -top-2 left-0 select-none font-display text-6xl leading-none text-primary/40"
        >
          “
        </span>
        <div className={clsx(QUOTE, 'relative pl-7 sm:pl-9')}>{markdown}</div>
      </figure>
    );

  return <div className={clsx(PROSE, 'view-lite px-1', strong && 'prose-p:text-base prose-p:font-semibold prose-p:text-ink')}>{markdown}</div>;
}
