'use client';

interface CitationFootnoteProps {
  citations?: Array<{
    index: number;
    documentTitle: string;
    chunkIndex?: number;
  }>;
}

/**
 * CitationFootnote — renders [1]-style KB citations.
 * MVP: placeholder — RAG context is prepended to system prompt,
 * citation markers are not yet emitted by the API.
 */
export function CitationFootnote({ citations }: CitationFootnoteProps) {
  if (!citations || citations.length === 0) return null;

  return (
    <div className="mt-2 border-t pt-1 text-xs text-neutral-500 space-y-0.5">
      {citations.map((c) => (
        <div key={c.index}>
          <span className="font-mono">[{c.index}]</span>{' '}
          <span>{c.documentTitle}</span>
          {c.chunkIndex !== undefined && (
            <span className="text-neutral-400"> (chunk {c.chunkIndex})</span>
          )}
        </div>
      ))}
    </div>
  );
}
