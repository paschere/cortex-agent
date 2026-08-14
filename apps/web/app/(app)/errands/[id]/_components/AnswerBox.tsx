'use client';

import { clsx } from 'clsx';
import { Loader2, Send, TriangleAlert } from 'lucide-react';
import { useState } from 'react';

/**
 * Answering the one question an errand stopped to ask.
 *
 * The options are the point. A person who has to compose a sentence answers
 * tomorrow; a person who can click "Marítima" answers now, and the errand
 * resumes while they are still thinking about it. The free-text box stays
 * because the options are the engine's guess at the answer space and are
 * sometimes wrong — but it is the fallback, not the default.
 *
 * Clicking an option SENDS it. There is no select-then-confirm step: this is
 * one question with a handful of answers, and a second click would only be
 * ceremony.
 */
export function AnswerBox({
  errandId,
  questionId,
  options,
  onAnswered,
}: {
  errandId: string;
  questionId: string;
  options: string[];
  onAnswered: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(answer: string) {
    const trimmed = answer.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/errands/${errandId}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionId, answer: trimmed }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(body?.error ?? 'No se pudo enviar la respuesta.');
      setText('');
      onAnswered();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3">
      {options.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {options.map((option) => (
            <button
              key={option}
              type="button"
              disabled={busy}
              onClick={() => void send(option)}
              className="rounded-pill border border-amber/30 bg-surface px-3 py-1 text-xs font-semibold text-ink transition-all duration-150 hover:-translate-y-px hover:border-amber hover:bg-amber-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber/40 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transform-none motion-reduce:transition-none"
            >
              {option}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send(text);
            }
          }}
          rows={2}
          maxLength={2000}
          disabled={busy}
          placeholder={
            options.length > 0
              ? 'O escribe tu propia respuesta…'
              : 'Escribe tu respuesta y el encargo sigue desde donde iba…'
          }
          className="scroll-slim min-w-0 flex-1 resize-y rounded-card border border-border bg-surface px-3 py-2 text-sm leading-relaxed text-ink transition-colors placeholder:text-ink-faint focus:border-amber/50 focus:outline-none focus:ring-4 focus:ring-amber/10 disabled:opacity-60"
        />
        <button
          type="button"
          onClick={() => void send(text)}
          disabled={busy || text.trim().length === 0}
          className={clsx(
            'inline-flex shrink-0 items-center gap-1.5 rounded-pill px-3.5 py-2 text-xs font-semibold shadow-pop transition-all duration-150',
            'bg-primary text-white hover:-translate-y-px hover:bg-primary-strong',
            'disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none',
            'motion-reduce:transform-none motion-reduce:transition-none',
          )}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <Send className="h-3.5 w-3.5" />
          )}
          Responder
        </button>
      </div>

      {error && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-rose">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
