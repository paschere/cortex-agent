'use client';

import { clsx } from 'clsx';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { useState, useTransition } from 'react';

/**
 * La encuesta que ve el cliente: una pregunta de 0 a 10 y un comentario. No
 * pide cuenta ni contraseña (el enlace es la llave). Contestar dos veces no
 * cuenta dos: la segunda muestra la primera.
 *
 * `onSubmit` existe para el escaparate de desarrollo; en la página real se
 * manda a /api/crm/public/respond.
 */

type Answered = { score: number; comment: string | null };

const SCALE = Array.from({ length: 11 }, (_, i) => i);

function tone(n: number): string {
  if (n >= 9) return 'peer-checked:border-emerald peer-checked:bg-emerald peer-checked:text-white';
  if (n >= 7) return 'peer-checked:border-amber peer-checked:bg-amber peer-checked:text-white';
  return 'peer-checked:border-rose peer-checked:bg-rose peer-checked:text-white';
}

export function SurveyForm(props: {
  token: string;
  companyName: string;
  contactName: string | null;
  answered: Answered | null;
  onSubmit?: (input: { score: number; comment: string; name: string }) => Promise<string | null>;
}) {
  const [score, setScore] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [name, setName] = useState(props.contactName ?? '');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Answered | null>(props.answered);
  const [pending, start] = useTransition();

  function send() {
    if (score === null) {
      setError('Elige un número de 0 a 10.');
      return;
    }
    setError(null);
    start(async () => {
      if (props.onSubmit) {
        const err = await props.onSubmit({ score, comment, name });
        if (err) setError(err);
        else setDone({ score, comment: comment.trim() || null });
        return;
      }
      const res = await fetch('/api/crm/public/respond', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: props.token, score, comment, name }),
      }).catch(() => null);
      const body = (await res?.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
        score?: number;
        comment?: string | null;
      } | null;
      if (res?.ok && body?.ok) {
        setDone({ score: body.score ?? score, comment: body.comment ?? null });
        return;
      }
      setError(body?.error ?? 'No se pudo enviar. Inténtalo otra vez en un momento.');
    });
  }

  if (done)
    return (
      <section
        aria-live="polite"
        className="mx-auto max-w-xl rounded-card border border-border bg-surface p-6 text-center shadow-card sm:p-8"
      >
        <CheckCircle2 className="mx-auto h-10 w-10 text-emerald" aria-hidden />
        <h1 className="mt-3 text-xl font-extrabold tracking-tight text-ink">
          ¡Gracias por responder!
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-muted">
          Calificaste a {props.companyName} con{' '}
          <strong className="text-ink">{done.score} de 10</strong>.
          {done.comment ? ' Tu comentario le llegó al equipo.' : ''}{' '}
          {done.score <= 6
            ? 'Alguien del equipo te va a buscar para entender qué pasó.'
            : 'Nos sirve mucho para seguir mejorando.'}
        </p>
      </section>
    );

  return (
    <section
      aria-labelledby="encuesta-titulo"
      className="mx-auto max-w-2xl rounded-card border border-border bg-surface p-5 shadow-card sm:p-8"
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
        Una pregunta · menos de un minuto
      </p>
      <h1
        id="encuesta-titulo"
        className="mt-2 text-xl font-extrabold leading-snug tracking-tight text-ink sm:text-2xl"
      >
        {props.contactName ? `${props.contactName.split(' ')[0]}, ¿qué` : '¿Qué'} tan probable es
        que le recomiendes {props.companyName} a un colega o a otra empresa?
      </h1>

      <form
        className="mt-6 space-y-6"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <fieldset className="m-0 border-0 p-0">
          <legend className="sr-only">Calificación de 0 a 10</legend>
          <div className="grid grid-cols-6 gap-2 sm:grid-cols-11">
            {SCALE.map((n) => (
              <label key={n} className="relative">
                <input
                  type="radio"
                  name="score"
                  value={n}
                  checked={score === n}
                  onChange={() => setScore(n)}
                  className="peer sr-only"
                />
                <span
                  className={clsx(
                    'tabular flex h-11 cursor-pointer items-center justify-center rounded-sm border border-border-strong bg-surface text-base font-bold text-ink transition-colors duration-150 hover:bg-surface-2 peer-focus-visible:ring-2 peer-focus-visible:ring-primary/40 motion-reduce:transition-none',
                    tone(n),
                  )}
                >
                  {n}
                </span>
              </label>
            ))}
          </div>
          <div className="mt-2 flex justify-between text-micro text-ink-faint">
            <span>0 · Nada probable</span>
            <span>10 · Muy probable</span>
          </div>
        </fieldset>

        <div>
          <label htmlFor="encuesta-comentario" className="text-sm font-semibold text-ink">
            {score !== null && score <= 6
              ? '¿Qué podríamos haber hecho mejor?'
              : '¿Por qué esa calificación? (opcional)'}
          </label>
          <textarea
            id="encuesta-comentario"
            rows={4}
            maxLength={2000}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            className="mt-1.5 w-full rounded-sm border border-border-strong bg-surface px-3 py-2.5 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-primary focus-visible:ring-2 focus-visible:ring-primary/30"
            placeholder="Lo que quieras contarnos"
          />
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <label htmlFor="encuesta-nombre" className="text-sm font-semibold text-ink">
              Tu nombre <span className="font-normal text-ink-faint">(opcional)</span>
            </label>
            <input
              id="encuesta-nombre"
              maxLength={120}
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1.5 min-h-11 w-full rounded-sm border border-border-strong bg-surface px-3 text-sm text-ink outline-none focus:border-primary focus-visible:ring-2 focus-visible:ring-primary/30"
            />
          </div>
          <button
            type="submit"
            disabled={pending}
            className="cortex-primary-button inline-flex min-h-11 items-center justify-center gap-2 rounded-pill bg-primary px-6 text-sm font-bold text-white transition-colors duration-150 hover:bg-primary-strong disabled:opacity-60 motion-reduce:transition-none"
          >
            {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            Enviar respuesta
          </button>
        </div>
        {error && (
          <p role="alert" className="rounded-sm bg-rose-soft px-3 py-2 text-xs text-rose">
            {error}
          </p>
        )}
      </form>
    </section>
  );
}
