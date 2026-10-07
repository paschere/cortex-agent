'use client';

import { requestAppCodeAction, verifyAppCodeAction } from '@/lib/apps/external-actions';
import { Loader2, Mail } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/** La entrada: correo → código de 6 dígitos por correo. No dice si el correo existe. */
export function EntryForm({ appId, appName }: { appId: string; appName: string }) {
  const router = useRouter();
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const field =
    'w-full rounded-sm border border-border-strong bg-surface px-3 py-2.5 text-sm text-ink outline-none focus:border-primary focus-visible:ring-2 focus-visible:ring-primary/30';

  return (
    <div className="mx-auto mt-10 max-w-sm rounded-card border border-border bg-surface p-6 shadow-card sm:mt-16">
      <span className="grid h-10 w-10 place-items-center rounded-full bg-primary-soft text-primary">
        <Mail className="h-5 w-5" />
      </span>
      <h1 className="mt-4 text-lg font-bold text-ink">Entrar a {appName}</h1>
      <p className="mt-1 text-sm text-ink-muted">
        {step === 'email'
          ? 'Escribe tu correo y te enviamos un código para entrar.'
          : 'Escribe el código de 6 dígitos que te llegó al correo.'}
      </p>
      <form
        className="mt-5 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          start(async () => {
            if (step === 'email') {
              const res = await requestAppCodeAction(appId, email);
              if (!res.ok) return setError(res.error);
              setNote(res.message);
              setStep('code');
              return;
            }
            const res = await verifyAppCodeAction(appId, email, code);
            if (!res.ok) return setError(res.error);
            router.refresh();
          });
        }}
      >
        {step === 'email' ? (
          <input
            type="email"
            inputMode="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="tu@correo.com"
            className={field}
          />
        ) : (
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9 ]*"
            maxLength={7}
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="000000"
            className={`${field} text-center font-mono text-lg tracking-[0.4em]`}
          />
        )}
        {note && step === 'code' && <p className="text-xs text-ink-muted">{note}</p>}
        {error && (
          <p role="alert" className="text-xs text-rose">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={pending || (step === 'email' ? !email : code.replace(/\D/g, '').length !== 6)}
          className="cortex-primary-button inline-flex w-full items-center justify-center gap-1.5 rounded-pill bg-primary px-4 py-2.5 text-sm font-semibold text-white transition-all duration-150 hover:bg-primary-strong disabled:opacity-45"
        >
          {pending && <Loader2 className="h-4 w-4 animate-spin" />}
          {step === 'email' ? 'Enviarme el código' : 'Entrar'}
        </button>
        {step === 'code' && (
          <button
            type="button"
            onClick={() => {
              setStep('email');
              setCode('');
              setError(null);
            }}
            className="w-full text-center text-xs font-semibold text-ink-faint hover:text-ink"
          >
            Usar otro correo o pedir un código nuevo
          </button>
        )}
      </form>
    </div>
  );
}
