'use client';

import { clsx } from 'clsx';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

/**
 * The very same prose recipe the chat bubbles use (components/chat/MessageBubble),
 * so an agent report reads identically wherever it surfaces: the run dialog on
 * the Routines list, and the run history on the routine detail page.
 */
const PROSE = clsx(
  'prose prose-sm max-w-none text-ink',
  'prose-headings:mt-3 prose-headings:font-bold prose-headings:text-ink',
  'prose-p:my-1.5 prose-p:leading-relaxed prose-li:my-0.5',
  'prose-strong:text-ink prose-strong:font-semibold',
  'prose-a:text-primary prose-a:no-underline hover:prose-a:underline',
  'prose-code:rounded prose-code:bg-surface-2 prose-code:px-1 prose-code:py-0.5 prose-code:text-[0.85em] prose-code:font-medium prose-code:text-primary-ink prose-code:before:content-[""] prose-code:after:content-[""]',
  'prose-pre:rounded-card prose-pre:border prose-pre:border-border',
  'prose-table:text-[13px] prose-th:text-ink prose-td:text-ink-muted',
);

/** Renders GFM markdown — headings, tables, lists — inside a prose container. */
export function RunMarkdown({ children, className }: { children: string; className?: string }) {
  return (
    // Wide GFM tables scroll here instead of stretching the page.
    <div className={clsx('scroll-slim overflow-x-auto', className)}>
      <div className={PROSE}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
          {children}
        </ReactMarkdown>
      </div>
    </div>
  );
}

/** Past this many characters we render a slice first — a 200k report must not block the page. */
export const RENDER_LIMIT = 20_000;

/**
 * A run's output as markdown, capped so an enormous report stays cheap to
 * render until the reader explicitly asks for all of it.
 */
export function RunOutput({ text, className }: { text: string; className?: string }) {
  const [full, setFull] = useState(false);
  const long = text.length > RENDER_LIMIT;
  const shown = long && !full ? `${text.slice(0, RENDER_LIMIT)}\n\n…` : text;

  return (
    <div className={className}>
      <RunMarkdown>{shown}</RunMarkdown>
      {long && (
        <button
          type="button"
          onClick={() => setFull(!full)}
          className="mt-2 inline-flex items-center gap-1.5 rounded-card border border-border-strong bg-surface px-2.5 py-1.5 text-[12px] font-semibold text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          {full ? (
            <>
              <ChevronUp className="h-3.5 w-3.5" /> Show less
            </>
          ) : (
            <>
              <ChevronDown className="h-3.5 w-3.5" /> Show full output (
              <span className="tabular">{Math.round(text.length / 1000)}k</span> characters)
            </>
          )}
        </button>
      )}
    </div>
  );
}
