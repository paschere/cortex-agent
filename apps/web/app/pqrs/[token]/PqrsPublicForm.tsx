'use client';

import { clsx } from 'clsx';
import { CheckCircle2, LoaderCircle, Send } from 'lucide-react';
import { useState } from 'react';

/**
 * El formulario: qué se presenta, quién, cómo contactarlo, el asunto y el
 * detalle, y la autorización de tratamiento de datos (Ley 1581 de 2012), que
 * es obligatoria. Al radicar enseña el número y la fecha límite.
 */

const KINDS = [
  { value: 'peticion', label: 'Petición', hint: 'Pedir información, un documento o una actuación' },
  { value: 'queja', label: 'Queja', hint: 'Inconformidad con la atención o una conducta' },
  { value: 'reclamo', label: 'Reclamo', hint: 'Un producto o servicio que no salió bien' },
  { value: 'sugerencia', label: 'Sugerencia', hint: 'Una idea para mejorar' },
  { value: 'felicitacion', label: 'Felicitación', hint: 'Algo que salió bien' },
] as const;

const field =
  'min-h-11 w-full rounded-sm border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-primary focus:ring-2 focus:ring-primary/15';

function longDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const months = [
    'enero',
    'febrero',
    'marzo',
    'abril',
    'mayo',
    'junio',
    'julio',
    'agosto',
    'septiembre',
    'octubre',
    'noviembre',
    'diciembre',
  ];
  return `${d} de ${months[m - 1]} de ${y}`;
}

export function PqrsPublicForm({
  token,
  companyName,
  policyUrl,
  onSubmit,
}: {
  token: string;
  companyName: string;
  policyUrl: string | null;
  /** Para la vitrina de desarrollo: contesta sin guardar. */
  onSubmit?: (
    body: Record<string, unknown>,
  ) => Promise<{ ok: boolean; radicado?: string; dueOn?: string; error?: string }>;
}) {
  const [kind, setKind] = useState<string>('peticion');
  const [matter, setMatter] = useState('general');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ radicado: string; dueOn: string } | null>(null);

  async function submit(form: FormData) {
    setBusy(true);
    setError(null);
    const body = {
      token,
      kind,
      matter,
      name: form.get('name'),
      idNumber: form.get('idNumber'),
      email: form.get('email'),
      phone: form.get('phone'),
      subject: form.get('subject'),
      body: form.get('body'),
      website: form.get('website'),
      consent: form.get('consent') === 'on',
    };
    try {
      const json = onSubmit
        ? await onSubmit(body)
        : ((await fetch('/api/pqrs/public', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }).then((r) => r.json())) as {
            ok: boolean;
            radicado?: string;
            dueOn?: string;
            error?: string;
          });
      if (!json.ok || !json.radicado || !json.dueOn) {
        setError(json.error ?? 'No se pudo radicar. Intenta de nuevo.');
        return;
      }
      setDone({ radicado: json.radicado, dueOn: json.dueOn });
    } catch {
      setError('No se pudo radicar. Revisa tu conexión e intenta de nuevo.');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <section className="mx-auto max-w-xl rounded-card border border-border bg-surface p-6 text-center shadow-card sm:p-8">
        <CheckCircle2 className="mx-auto h-10 w-10 text-emerald" aria-hidden />
        <h1 className="mt-3 text-xl font-extrabold text-ink">Quedó radicada</h1>
        <p className="mt-2 text-sm text-ink-muted">Guarda este número para hacerle seguimiento:</p>
        <p className="mt-3 font-mono text-2xl font-bold tracking-wide text-ink">{done.radicado}</p>
        <p className="mt-4 text-sm text-ink-muted">
          {companyName} te responderá a más tardar el{' '}
          <strong className="text-ink">{longDate(done.dueOn)}</strong>, por el correo o teléfono que
          dejaste.
        </p>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-2xl">
      <header className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
          {companyName}
        </p>
        <h1 className="mt-1 text-2xl font-extrabold text-ink sm:text-3xl">
          Peticiones, quejas, reclamos y sugerencias
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-muted">
          Cuéntanos qué necesitas. Al enviarla recibes un número de radicado y la fecha en que te
          responderemos.
        </p>
      </header>
      <form
        action={submit}
        className="space-y-5 rounded-card border border-border bg-surface p-5 shadow-card sm:p-7"
      >
        <fieldset>
          <legend className="text-sm font-bold text-ink">¿Qué quieres presentar?</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {KINDS.map((k) => (
              <label
                key={k.value}
                className={clsx(
                  'flex cursor-pointer flex-col rounded-sm border px-3 py-2.5 transition-colors',
                  kind === k.value
                    ? 'border-primary bg-primary-soft'
                    : 'border-border hover:bg-surface-2',
                )}
              >
                <span className="flex items-center gap-2 text-sm font-semibold text-ink">
                  <input
                    type="radio"
                    name="kind"
                    value={k.value}
                    checked={kind === k.value}
                    onChange={() => setKind(k.value)}
                    className="accent-[var(--color-primary)]"
                  />
                  {k.label}
                </span>
                <span className="mt-0.5 pl-6 text-xs text-ink-muted">{k.hint}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className="block text-sm font-semibold text-ink">
          ¿Sobre qué es?
          <select
            value={matter}
            onChange={(e) => setMatter(e.target.value)}
            className={clsx(field, 'mt-1')}
          >
            <option value="general">Atención o información general</option>
            <option value="consumo">Un producto o servicio que compré</option>
            <option value="datos_personales">
              Mis datos personales (conocer, corregir o suprimir)
            </option>
          </select>
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm font-semibold text-ink">
            Nombre completo
            <input
              name="name"
              required
              minLength={2}
              maxLength={160}
              className={clsx(field, 'mt-1')}
              autoComplete="name"
            />
          </label>
          <label className="block text-sm font-semibold text-ink">
            Documento de identidad <span className="font-normal text-ink-faint">(opcional)</span>
            <input name="idNumber" maxLength={40} className={clsx(field, 'mt-1')} />
          </label>
          <label className="block text-sm font-semibold text-ink">
            Correo
            <input
              name="email"
              type="email"
              maxLength={200}
              className={clsx(field, 'mt-1')}
              autoComplete="email"
            />
          </label>
          <label className="block text-sm font-semibold text-ink">
            Teléfono <span className="font-normal text-ink-faint">(opcional)</span>
            <input name="phone" maxLength={40} className={clsx(field, 'mt-1')} autoComplete="tel" />
          </label>
        </div>
        <label className="block text-sm font-semibold text-ink">
          Asunto
          <input
            name="subject"
            required
            minLength={3}
            maxLength={200}
            className={clsx(field, 'mt-1')}
          />
        </label>
        <label className="block text-sm font-semibold text-ink">
          Cuéntanos con detalle
          <textarea
            name="body"
            required
            rows={6}
            maxLength={8000}
            className={clsx(field, 'mt-1')}
          />
        </label>
        <input
          type="text"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden
          className="hidden"
        />
        <label className="flex items-start gap-2.5 text-sm text-ink-muted">
          <input
            type="checkbox"
            name="consent"
            required
            className="mt-1 accent-[var(--color-primary)]"
          />
          <span>
            Autorizo a {companyName} a tratar los datos que escribo aquí para atender esta
            solicitud, conforme a su política de tratamiento de datos personales
            {policyUrl ? (
              <>
                {' '}
                (
                <a
                  href={policyUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="font-semibold text-primary underline"
                >
                  léela aquí
                </a>
                )
              </>
            ) : null}{' '}
            y a la Ley 1581 de 2012.
          </span>
        </label>
        {error && (
          <p role="alert" className="rounded-sm bg-rose-soft px-3 py-2 text-sm text-rose">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy}
          className="cortex-primary-button inline-flex min-h-11 items-center gap-2 rounded-pill bg-primary px-5 text-sm font-bold text-white hover:bg-primary-strong disabled:opacity-60"
        >
          {busy ? (
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Send className="h-4 w-4" aria-hidden />
          )}
          Radicar
        </button>
      </form>
    </section>
  );
}
