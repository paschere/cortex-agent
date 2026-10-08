'use client';

import { AppIllustration } from '@/components/apps/AppIllustration';
import { BrandMark, useViewBrand } from '@/components/views/blocks/brand';
import { requestAppCodeAction, verifyAppCodeAction } from '@/lib/apps/external-actions';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/** La entrada: correo → código de 6 dígitos por correo. No dice si el correo existe. */
export function EntryForm({
  appId,
  appName,
  welcome = null,
}: {
  appId: string;
  appName: string;
  /** La bienvenida de la app (0215): título, texto e imagen opcional. */
  welcome?: { title: string; text: string; imageUrl: string | null } | null;
}) {
  const router = useRouter();
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const brand = useViewBrand();

  const field =
    'min-h-14 w-full rounded-card border border-border-strong bg-surface px-4 text-base text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-primary focus-visible:ring-2 focus-visible:ring-primary/30';

  return (
    <div className="mx-auto mt-2 max-w-sm sm:mt-10">
      <div className="app-hero overflow-hidden rounded-[1.75rem] border border-border shadow-pop">
        {welcome?.imageUrl ? (
          <img
            src={welcome.imageUrl}
            alt=""
            decoding="async"
            className="h-44 w-full object-cover"
          />
        ) : (
          <div className="flex flex-col items-center px-6 pt-8">
            {brand ? <BrandMark brand={brand} size="lg" /> : <AppIllustration kind="lock" />}
          </div>
        )}
        <div className="p-6 pt-5">
          <h1 className="text-center text-xl font-extrabold leading-tight tracking-tight text-ink">
            {welcome?.title || `Entrar a ${appName}`}
          </h1>
          {welcome?.text && (
            <p className="mt-2 text-center text-sm text-ink-muted">{welcome.text}</p>
          )}

          <div
            role="img"
            aria-label={step === 'email' ? 'Paso 1 de 2' : 'Paso 2 de 2'}
            className="mx-auto mt-5 flex w-24 gap-1.5"
          >
            <span aria-hidden className="h-1 flex-1 rounded-pill bg-primary" />
            <span
              aria-hidden
              className={`h-1 flex-1 rounded-pill transition-colors duration-300 motion-reduce:transition-none ${step === 'code' ? 'bg-primary' : 'bg-border-strong'}`}
            />
          </div>
          <p className="mt-3 text-center text-sm font-medium text-ink">
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
                aria-label="Tu correo"
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
                aria-label="Código de 6 dígitos"
                pattern="[0-9 ]*"
                maxLength={7}
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="000000"
                className={`${field} min-h-16 text-center font-mono text-xl font-bold tracking-[0.45em]`}
              />
            )}
            {note && step === 'code' && <p className="text-xs text-ink-muted">{note}</p>}
            {error && (
              <p
                role="alert"
                className="rounded-sm bg-rose-soft px-3 py-2 text-xs font-semibold text-rose"
              >
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={
                pending || (step === 'email' ? !email : code.replace(/\D/g, '').length !== 6)
              }
              className="app-press cortex-primary-button inline-flex min-h-14 w-full items-center justify-center gap-2 rounded-pill bg-primary px-4 text-base font-bold text-white shadow-pop hover:bg-primary-strong disabled:opacity-45 disabled:shadow-none"
            >
              {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
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
                className="app-press inline-flex min-h-11 w-full items-center justify-center gap-1.5 text-xs font-semibold text-ink-muted hover:text-ink"
              >
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
                Usar otro correo o pedir un código nuevo
              </button>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}
