'use client';

import { clsx } from 'clsx';
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
  className,
}: {
  content: string;
  isStreaming?: boolean;
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
        isStreaming && 'after:ml-0.5 after:animate-pulse after:text-primary after:content-["▋"]',
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
