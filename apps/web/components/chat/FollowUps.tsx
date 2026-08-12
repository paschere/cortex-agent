'use client';

import { CornerDownRight } from 'lucide-react';
import { useEffect, useState } from 'react';

/**
 * THREE THINGS WORTH ASKING NEXT — or fewer, or none.
 *
 * ===========================================================================
 * THE RULE THIS COMPONENT ENFORCES: NEVER OCCUPY THE SPACE FOR NOTHING
 * ===========================================================================
 * A strip of suggestions is a promise about the quality of what is in it. The
 * first time somebody clicks "¿quieres saber más?" and gets a paragraph they
 * did not want, the strip becomes furniture and every good suggestion after it
 * is invisible. That is why the route behind this filters its own model's
 * output, and why this renders NOTHING at all when nothing came back — no
 * skeleton, no "sin sugerencias", no reserved height. An empty result should
 * leave the transcript exactly as it would have been.
 *
 * The same reasoning shapes the loading state, which is also nothing. These
 * arrive a second or two after the answer finished; a shimmering placeholder
 * under a completed answer says "wait, there is more coming", which is a claim
 * this feature cannot honour — sometimes there is nothing coming.
 *
 * ===========================================================================
 * WHY IT FETCHES INSTEAD OF ARRIVING WITH THE ANSWER
 * ===========================================================================
 * Because it must never be able to slow the answer down or break it. It runs
 * after `isStreaming` goes false, on a cheap model, and every failure path ends
 * in an empty array. See `/api/chat/followups`.
 */

export function FollowUps({
  conversationId,
  messageId,
  ready,
  onPick,
}: {
  conversationId?: string;
  /** Keys the fetch, so a regenerated answer gets its own suggestions. */
  messageId: string;
  /** False while the turn is still streaming. */
  ready: boolean;
  onPick: (question: string) => void;
}) {
  const [suggestions, setSuggestions] = useState<string[]>([]);

  useEffect(() => {
    if (!ready || !conversationId) return;
    let alive = true;

    // A beat after the last token, so the request never competes with the
    // stream's own final frames for the connection.
    const timer = setTimeout(() => {
      fetch('/api/chat/followups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId, messageId }),
      })
        .then((r) => (r.ok ? r.json() : { suggestions: [] }))
        .then((data: { suggestions?: string[] }) => {
          if (alive) setSuggestions(data.suggestions ?? []);
        })
        .catch(() => {
          // Silent by design: a strip that failed to load is indistinguishable
          // from a turn that had nothing worth asking next, and both are fine.
        });
    }, 400);

    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [conversationId, messageId, ready]);

  if (suggestions.length === 0) return null;

  return (
    <nav aria-label="Preguntas de seguimiento" className="mt-2.5">
      <ul className="flex flex-wrap gap-1.5">
        {suggestions.map((question) => (
          <li key={question}>
            <button
              type="button"
              onClick={() => onPick(question)}
              className="animate-rise group inline-flex max-w-full items-start gap-1.5 rounded-pill border border-border bg-surface px-3 py-1.5 text-left text-[12.5px] leading-snug text-ink-muted transition-all duration-150 hover:-translate-y-px hover:border-primary/30 hover:bg-primary-soft hover:text-primary-ink hover:shadow-card motion-reduce:transform-none motion-reduce:transition-none"
            >
              <CornerDownRight
                className="mt-0.5 h-3 w-3 shrink-0 text-ink-faint group-hover:text-primary"
                aria-hidden
              />
              <span className="min-w-0">{question}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
