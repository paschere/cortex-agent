'use client';

import { helpFeedbackAction } from '@/app/(app)/ayuda/actions';
import { clsx } from 'clsx';
import { Check, ThumbsDown, ThumbsUp } from 'lucide-react';
import { useState, useTransition } from 'react';

/**
 * «¿Te sirvió?» al pie de cada artículo. Un voto por persona y artículo; votar
 * otra vez lo cambia. Con «No», una caja opcional para decir qué faltó.
 */
export function HelpFeedback({ slug, initial }: { slug: string; initial: boolean | null }) {
  const [vote, setVote] = useState<boolean | null>(initial);
  const [comment, setComment] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const send = (helpful: boolean, note?: string) => {
    setError(null);
    start(async () => {
      const result = await helpFeedbackAction({
        slug,
        helpful,
        ...(note ? { comment: note } : {}),
        route: window.location.pathname,
      });
      if (result.ok) {
        setVote(helpful);
        if (note) setSent(true);
      } else setError(result.error);
    });
  };

  return (
    <section
      aria-label="¿Te sirvió este artículo?"
      className="rounded-card border border-border bg-surface p-5 shadow-card"
      data-help-feedback
    >
      <p className="text-sm font-bold text-ink">¿Te sirvió?</p>
      <div className="mt-3 flex gap-2">
        {[
          { value: true, label: 'Sí', Icon: ThumbsUp },
          { value: false, label: 'No', Icon: ThumbsDown },
        ].map(({ value, label, Icon }) => (
          <button
            key={label}
            type="button"
            disabled={pending}
            aria-pressed={vote === value}
            onClick={() => send(value)}
            className={clsx(
              'inline-flex min-h-10 items-center gap-2 rounded-pill border px-4 text-sm font-semibold transition-colors',
              vote === value
                ? 'border-primary bg-primary-soft text-primary'
                : 'border-border-strong bg-surface text-ink-muted hover:bg-surface-2 hover:text-ink',
            )}
          >
            <Icon className="h-4 w-4" /> {label}
          </button>
        ))}
      </div>
      {vote === true && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-emerald">
          <Check className="h-4 w-4" /> Gracias. Lo tendremos en cuenta.
        </p>
      )}
      {vote === false && !sent && (
        <form
          className="mt-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (comment.trim()) send(false, comment.trim());
          }}
        >
          <label className="text-xs font-semibold text-ink-muted" htmlFor={`fb-${slug}`}>
            ¿Qué te faltó? (opcional)
          </label>
          <textarea
            id={`fb-${slug}`}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={1000}
            rows={3}
            className="mt-1 w-full resize-none rounded-sm border border-border-strong bg-surface px-3 py-2 text-sm text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          />
          <button
            type="submit"
            disabled={pending || !comment.trim()}
            className="mt-2 inline-flex min-h-9 items-center rounded-pill border border-border-strong px-4 text-sm font-semibold text-ink hover:bg-surface-2 disabled:opacity-45"
          >
            Enviar comentario
          </button>
        </form>
      )}
      {sent && (
        <p className="mt-3 text-xs text-ink-muted">Recibido. Vamos a mejorar este artículo.</p>
      )}
      {error && <p className="mt-3 text-xs text-rose">{error}</p>}
    </section>
  );
}
