'use client';

import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { useState } from 'react';
import {
  AuthBody,
  AuthDocument,
  AuthError,
  AuthField,
  AuthMasthead,
  AuthTitle,
} from '../_components/AuthDocument';

/**
 * El formulario público de «Pide tu acceso». Guarda la solicitud; operaciones
 * la revisa en /overview/access y, al aprobarla, sale por correo un código
 * personal de un solo uso para /signup.
 */
export function AccessRequestForm() {
  const [form, setForm] = useState({
    name: '',
    company: '',
    email: '',
    phone: '',
    message: '',
    website: '',
  });
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [err, setErr] = useState<string | null>(null);

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState('sending');
    setErr(null);
    try {
      const res = await fetch('/api/access-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setErr(body.error ?? 'No se pudo enviar. Inténtalo de nuevo.');
        setState('idle');
        return;
      }
      setState('sent');
    } catch {
      setErr('No se pudo enviar. Revisa tu conexión e inténtalo de nuevo.');
      setState('idle');
    }
  }

  if (state === 'sent') {
    return (
      <AuthDocument>
        <AuthMasthead note="Inteligencia conectada a tu operación." />
        <AuthBody>
          <AuthTitle
            hint={
              <>
                Revisamos cada solicitud a mano. Cuando la aprobemos te llega un correo a{' '}
                <span className="font-mono text-ink">{form.email}</span> con tu código para crear el
                espacio.
              </>
            }
          >
            Recibimos tu solicitud
          </AuthTitle>
          <Link
            href="/"
            className="inline-flex w-full items-center justify-center rounded-pill border border-border bg-surface px-3.5 py-2.5 text-sm font-semibold text-ink shadow-card transition-all duration-150 hover:-translate-y-px hover:border-border-strong hover:bg-surface-2 motion-reduce:transform-none motion-reduce:transition-none"
          >
            Volver al inicio
          </Link>
        </AuthBody>
      </AuthDocument>
    );
  }

  return (
    <AuthDocument>
      <AuthMasthead note="Inteligencia conectada a tu operación." />
      <AuthBody>
        <AuthTitle hint="Cuéntanos quién eres y de qué empresa. Revisamos cada solicitud y te mandamos un código para crear tu espacio.">
          Pide tu acceso
        </AuthTitle>

        <form onSubmit={submit} className="space-y-3">
          <AuthField
            label="Nombre completo"
            type="text"
            required
            minLength={2}
            maxLength={120}
            autoComplete="name"
            placeholder="Ana Restrepo"
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
          />
          <AuthField
            label="Empresa"
            type="text"
            required
            minLength={2}
            maxLength={160}
            autoComplete="organization"
            placeholder="Transportes del Valle"
            value={form.company}
            onChange={(e) => set('company', e.target.value)}
          />
          <AuthField
            label="Correo"
            mono
            type="email"
            required
            autoComplete="email"
            placeholder="tu@empresa.com"
            value={form.email}
            onChange={(e) => set('email', e.target.value)}
          />
          <AuthField
            label="Teléfono o WhatsApp (opcional)"
            mono
            type="tel"
            autoComplete="tel"
            placeholder="+57 300 000 0000"
            value={form.phone}
            onChange={(e) => set('phone', e.target.value)}
          />
          <div>
            <label htmlFor="access-message" className="field-label">
              ¿Qué quieres resolver con Cortex? (opcional)
            </label>
            <textarea
              id="access-message"
              rows={3}
              maxLength={2000}
              value={form.message}
              onChange={(e) => set('message', e.target.value)}
              placeholder="Somos 12 personas y perdemos el hilo de los pendientes con clientes…"
              className="mt-1 w-full rounded-sm border border-border bg-surface-2 px-3 py-2.5 text-sm text-ink transition-colors placeholder:text-ink-faint focus:border-primary focus:bg-surface focus:outline-none focus:ring-4 focus:ring-primary/10"
            />
          </div>
          {/* Trampa para robots: invisible para personas y lectores de pantalla. */}
          <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
            <label>
              Sitio web
              <input
                type="text"
                tabIndex={-1}
                autoComplete="off"
                value={form.website}
                onChange={(e) => set('website', e.target.value)}
              />
            </label>
          </div>
          <Button type="submit" disabled={state === 'sending'} className="w-full py-2.5">
            {state === 'sending' ? 'Enviando…' : 'Pedir acceso'}
          </Button>
        </form>

        <p className="mt-4 text-center text-xs text-ink-faint">
          ¿Ya tienes tu código?{' '}
          <Link href="/signup" className="font-semibold text-primary hover:underline">
            Crea tu espacio
          </Link>
        </p>

        {err && <AuthError>{err}</AuthError>}
      </AuthBody>
    </AuthDocument>
  );
}
