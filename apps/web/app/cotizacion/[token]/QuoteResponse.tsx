'use client';

import { CheckCircle2, Download, Loader2, XCircle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/**
 * Lo que el cliente puede hacer con la cotización: bajar el PDF, aceptarla
 * (con su nombre, que queda en la línea de tiempo) o decir que no. Aceptar no
 * pide cuenta ni contraseña: el enlace que le llegó al correo es la llave.
 */

type State = 'open' | 'accepted' | 'rejected' | 'expired';

const when = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat('es-CO', {
        dateStyle: 'long',
        timeStyle: 'short',
        timeZone: 'America/Bogota',
      }).format(new Date(iso))
    : '';

export function QuoteResponse(props: {
  token: string;
  state: State;
  number: string;
  companyName: string;
  acceptedBy: string | null;
  acceptedAt: string | null;
  pdfUrl: string;
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'idle' | 'reject'>('idle');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function send(action: 'accept' | 'reject') {
    setError(null);
    start(async () => {
      const res = await fetch('/api/sales/public/accept', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: props.token, name, action, reason }),
      }).catch(() => null);
      if (res?.ok) {
        router.refresh();
        return;
      }
      const body = (await res?.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? 'No se pudo enviar. Inténtalo otra vez en un momento.');
    });
  }

  const pdf = (
    <a
      href={props.pdfUrl}
      className="inline-flex items-center gap-1.5 rounded-pill border border-border-strong bg-surface px-4 py-2 text-sm font-semibold text-ink transition-colors duration-150 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      <Download className="h-4 w-4" aria-hidden />
      Descargar PDF
    </a>
  );

  if (props.state !== 'open')
    return (
      <div
        aria-live="polite"
        className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-border bg-surface p-4 shadow-card"
      >
        <p className="flex items-center gap-2 text-sm text-ink">
          {props.state === 'accepted' ? (
            <>
              <CheckCircle2 className="h-5 w-5 text-emerald" aria-hidden />
              <span>
                <strong>Cotización aceptada</strong>
                {props.acceptedBy ? ` por ${props.acceptedBy}` : ''}
                {props.acceptedAt ? ` el ${when(props.acceptedAt)}` : ''}. {props.companyName} ya
                recibió la confirmación.
              </span>
            </>
          ) : props.state === 'rejected' ? (
            <>
              <XCircle className="h-5 w-5 text-ink-faint" aria-hidden />
              <span>
                Esta cotización fue rechazada. Si cambiaste de opinión, escríbele a{' '}
                {props.companyName}.
              </span>
            </>
          ) : (
            <>
              <XCircle className="h-5 w-5 text-amber" aria-hidden />
              <span>Esta cotización ya venció. Pídele una actualizada a {props.companyName}.</span>
            </>
          )}
        </p>
        {pdf}
      </div>
    );

  return (
    <section
      aria-labelledby="responder"
      className="rounded-card border border-border bg-surface p-4 shadow-card sm:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 id="responder" className="text-lg font-extrabold tracking-tight text-ink">
            Cotización {props.number} de {props.companyName}
          </h1>
          <p className="mt-0.5 text-sm text-ink-muted">
            Revísala abajo. Si estás de acuerdo, escribe tu nombre y acéptala: {props.companyName}{' '}
            recibe la confirmación al instante.
          </p>
        </div>
        {pdf}
      </div>

      <form
        className="mt-4 flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          send(mode === 'reject' ? 'reject' : 'accept');
        }}
      >
        <label className="sr-only" htmlFor="quote-name">
          Tu nombre
        </label>
        <input
          id="quote-name"
          required
          minLength={2}
          maxLength={120}
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Tu nombre"
          className="min-w-0 flex-1 rounded-sm border border-border-strong bg-surface px-3 py-2.5 text-sm text-ink outline-none focus:border-primary focus-visible:ring-2 focus-visible:ring-primary/30"
        />
        {mode === 'reject' && (
          <>
            <label className="sr-only" htmlFor="quote-reason">
              ¿Por qué no? (opcional)
            </label>
            <input
              id="quote-reason"
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="¿Por qué no? (opcional)"
              className="min-w-0 flex-1 rounded-sm border border-border-strong bg-surface px-3 py-2.5 text-sm text-ink outline-none focus:border-primary focus-visible:ring-2 focus-visible:ring-primary/30"
            />
          </>
        )}
        <button
          type="submit"
          disabled={pending || name.trim().length < 2}
          className={
            mode === 'reject'
              ? 'inline-flex items-center justify-center gap-1.5 rounded-pill border border-border-strong bg-surface px-5 py-2.5 text-sm font-bold text-ink transition-colors hover:bg-surface-2 disabled:opacity-45'
              : 'cortex-primary-button inline-flex items-center justify-center gap-1.5 rounded-pill bg-primary px-5 py-2.5 text-sm font-bold text-white transition-colors hover:bg-primary-strong disabled:opacity-45'
          }
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
          {mode === 'reject' ? 'Rechazar cotización' : 'Aceptar cotización'}
        </button>
      </form>
      <div className="mt-2 flex items-center justify-between gap-3">
        {error ? (
          <p role="alert" className="text-xs text-rose">
            {error}
          </p>
        ) : (
          <span />
        )}
        <button
          type="button"
          onClick={() => setMode(mode === 'reject' ? 'idle' : 'reject')}
          className="text-xs font-medium text-ink-muted underline-offset-2 hover:text-ink hover:underline"
        >
          {mode === 'reject' ? 'Mejor aceptarla' : 'No me interesa'}
        </button>
      </div>
    </section>
  );
}
