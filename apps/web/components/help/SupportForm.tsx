'use client';

import { createSupportTicketAction } from '@/app/(app)/ayuda/actions';
import { recentErrors } from '@/lib/help/recent-errors';
import {
  MESSAGE_MAX,
  SCREENSHOT_TYPES,
  SUBJECT_MAX,
  browserLabel,
  draftProblem,
  screenshotProblem,
} from '@/lib/support/shape';
import { CheckCircle2, ImagePlus, Loader2, Send } from 'lucide-react';
import { useEffect, useRef, useState, useTransition } from 'react';

/**
 * «Escribir a soporte»: asunto, mensaje y un pantallazo opcional. Lo demás
 * (la pantalla de la que viene, el navegador, la empresa, los errores
 * recientes) lo adjunta la app y se lo dice a la persona antes de enviar, para
 * que sepa exactamente qué sale.
 */
export function SupportForm({ from, organization }: { from: string | null; organization: string }) {
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const [pending, start] = useTransition();
  const [browser, setBrowser] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setBrowser(browserLabel(navigator.userAgent));
    setErrors(recentErrors());
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const problem = draftProblem({ subject, message }) ?? screenshotProblem(file);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    const form = new FormData();
    form.set('subject', subject);
    form.set('message', message);
    if (file) form.set('screenshot', file);
    form.set(
      'context',
      JSON.stringify({
        route: from ?? undefined,
        userAgent: navigator.userAgent,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        language: navigator.language,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        recentErrors: errors,
      }),
    );
    start(async () => {
      const result = await createSupportTicketAction(form);
      if (result.ok) {
        setDone(result.number);
        setSubject('');
        setMessage('');
        setFile(null);
      } else setError(result.error);
    });
  };

  if (done !== null) {
    return (
      <div
        className="rounded-card border border-emerald/30 bg-emerald-soft p-6"
        aria-live="polite"
        data-support-sent
      >
        <p className="flex items-center gap-2 text-base font-bold text-ink">
          <CheckCircle2 className="h-5 w-5 text-emerald" /> Recibimos tu mensaje (caso #{done})
        </p>
        <p className="mt-1 text-sm text-ink-muted">
          Te contestamos al correo de tu cuenta y la respuesta queda también aquí abajo.
        </p>
        <button
          type="button"
          onClick={() => setDone(null)}
          className="mt-4 text-sm font-semibold text-primary hover:underline"
        >
          Escribir otro mensaje
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-4 rounded-card border border-border bg-surface p-5 shadow-card md:p-6"
      data-support-form
    >
      <div>
        <label htmlFor="support-subject" className="text-sm font-bold text-ink">
          Asunto
        </label>
        <input
          id="support-subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          maxLength={SUBJECT_MAX}
          placeholder="Ej.: No me deja subir el extracto de Davivienda"
          className="mt-1 h-11 w-full rounded-sm border border-border-strong bg-surface px-3 text-sm text-ink placeholder:text-ink-faint focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        />
      </div>
      <div>
        <label htmlFor="support-message" className="text-sm font-bold text-ink">
          ¿Qué pasó?
        </label>
        <textarea
          id="support-message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          maxLength={MESSAGE_MAX}
          rows={6}
          placeholder="Cuéntanos qué intentabas hacer, qué esperabas y qué pasó."
          className="mt-1 w-full resize-y rounded-sm border border-border-strong bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        />
      </div>
      <div>
        <span className="text-sm font-bold text-ink">Pantallazo (opcional)</span>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            className="inline-flex min-h-10 items-center gap-2 rounded-pill border border-border-strong bg-surface px-4 text-sm font-semibold text-ink hover:bg-surface-2"
          >
            <ImagePlus className="h-4 w-4" /> {file ? 'Cambiar imagen' : 'Adjuntar imagen'}
          </button>
          {file && (
            <span className="flex items-center gap-2 text-sm text-ink-muted">
              {file.name}
              <button
                type="button"
                onClick={() => setFile(null)}
                className="text-xs font-semibold text-rose hover:underline"
              >
                Quitar
              </button>
            </span>
          )}
          <input
            ref={fileInput}
            type="file"
            accept={SCREENSHOT_TYPES.join(',')}
            className="sr-only"
            aria-label="Pantallazo"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setFile(f);
              setError(screenshotProblem(f));
              e.target.value = '';
            }}
          />
        </div>
        <p className="mt-1 text-xs text-ink-faint">
          PNG, JPG o WebP de hasta 5 MB. Revisa que no muestre claves.
        </p>
      </div>

      <div className="rounded-sm bg-surface-2 px-4 py-3 text-xs leading-relaxed text-ink-muted">
        <p className="font-semibold text-ink">Se adjunta solo:</p>
        <ul className="mt-1 list-disc pl-4">
          <li>Empresa: {organization}</li>
          <li>Pantalla: {from ?? 'la ayuda'}</li>
          {browser && <li>Navegador: {browser}</li>}
          {errors.length > 0 && <li>{errors.length} errores recientes del navegador</li>}
        </ul>
        <p className="mt-1">Nunca tus documentos ni tus conversaciones.</p>
      </div>

      {error && (
        <p className="text-sm font-semibold text-rose" role="alert">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending}
        className="cortex-primary-button inline-flex min-h-11 items-center gap-2 rounded-pill bg-primary px-6 text-sm font-bold text-white hover:bg-primary-strong disabled:opacity-60"
      >
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        Enviar a soporte
      </button>
    </form>
  );
}
