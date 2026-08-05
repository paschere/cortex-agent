'use client';

import { Provenance } from '@/components/ui/provenance';

/**
 * Where an answer came from, under the answer.
 *
 * This is the product's whole claim rendered at its smallest scale: a sentence
 * Cortex quoted from Brain Knowledge, the space it was read from, and — when
 * the material was a recording — the minute it was said and who said it. A
 * quote from a call is only worth as much as the ability to go and check it,
 * so `[12:34] Ana:` is not decoration, it is the address of the evidence.
 *
 * The shape mirrors what kb.search / kb.context already return
 * (packages/agent-tools/src/kb): document title, space, chunk index, and
 * `spokenAt` on hits that came from a recording.
 */

export interface ChatCitation {
  index: number;
  documentTitle: string;
  /** The space it was read from — company-wide knowledge or a personal note. */
  space?: string;
  spaceKind?: 'global' | 'personal';
  chunkIndex?: number;
  /** `mm:ss` into the recording, on citations that came from one. */
  spokenAt?: string;
  /** Who was speaking at that offset. */
  speaker?: string;
  /** When the brain was read. Already formatted — this does not guess a locale. */
  readAt?: string;
  /** The quoted sentence itself, when the answer carries one. */
  excerpt?: string;
}

interface CitationFootnoteProps {
  citations?: ChatCitation[];
}

export function CitationFootnote({ citations }: CitationFootnoteProps) {
  if (!citations || citations.length === 0) return null;

  return (
    <div className="mt-3">
      <div className="rule-double" />
      <div className="field-label mt-2.5">Fuentes</div>
      <ol className="mt-1.5 space-y-2">
        {citations.map((c) => {
          // A provenance chip with nothing to attest is decoration, and one
          // empty chip devalues every real one. Without a space or a read time
          // there is nothing to show, so the citation is left plain.
          const hasProvenance = Boolean(c.space || c.readAt);
          const detail =
            c.spaceKind === 'personal'
              ? 'tus propias notas'
              : c.chunkIndex !== undefined
                ? `fragmento ${c.chunkIndex}`
                : undefined;

          return (
            <li key={c.index} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[12px]">
              <span className="tabular shrink-0 text-ink-faint">[{c.index}]</span>
              <span className="min-w-0 font-medium text-ink">{c.documentTitle}</span>
              {hasProvenance && (
                <Provenance
                  source={c.space ?? 'Brain Knowledge'}
                  {...(c.readAt ? { readAt: c.readAt } : {})}
                  {...(detail ? { detail } : {})}
                />
              )}
              {c.excerpt && (
                <p className="w-full leading-snug text-ink-muted">
                  {(c.spokenAt || c.speaker) && (
                    <span className="tabular mr-1.5 text-primary">
                      {c.spokenAt && `[${c.spokenAt}]`}
                      {c.speaker && ` ${c.speaker}:`}
                    </span>
                  )}
                  {c.excerpt}
                </p>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
