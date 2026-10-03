import { clsx } from 'clsx';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Un artículo de ayuda, pintado en el servidor. La misma receta de prosa que
 * el chat, un poco más amplia para leer de corrido. Los enlaces internos
 * (`/pagar`, `/ayuda/por-pagar`) van por `next/link`; los externos abren
 * aparte.
 */
const PROSE = clsx(
  'prose max-w-none text-ink',
  'prose-headings:font-extrabold prose-headings:text-ink prose-h2:mt-8 prose-h2:text-xl',
  'prose-p:leading-relaxed prose-li:my-1',
  'prose-strong:text-ink prose-strong:font-semibold',
  'prose-a:text-primary prose-a:font-semibold prose-a:no-underline hover:prose-a:underline',
  'prose-ol:pl-5 prose-ul:pl-5 marker:text-ink-faint',
  'prose-table:text-sm prose-th:text-ink prose-td:text-ink-muted',
);

export function HelpMarkdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={clsx(PROSE, className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children: label }) =>
            href?.startsWith('/') ? (
              <Link href={href}>{label}</Link>
            ) : (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {label}
              </a>
            ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
