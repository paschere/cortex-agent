'use client';

import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';
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

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setErr(null);
    const { error } = await authClient.requestPasswordReset({
      email,
      redirectTo: '/reset-password',
    });
    setLoading(false);
    if (error) {
      setErr(
        error.message ?? 'No se pudo enviar la solicitud. Revisa el correo e inténtalo de nuevo.',
      );
      return;
    }
    setSent(true);
  }

  return (
    <AuthDocument>
      <AuthMasthead />

      <AuthBody>
        {sent ? (
          <AuthTitle
            hint={
              <>
                Si existe una cuenta para <span className="font-mono text-ink">{email}</span>, el
                enlace ya va en camino. Vence en <span className="tabular">1 hora</span>.
              </>
            }
          >
            Revisa tu correo
          </AuthTitle>
        ) : (
          <>
            <AuthTitle hint="Dinos el correo de la cuenta y te enviamos un enlace para elegir una nueva.">
              Recupera tu contraseña
            </AuthTitle>
            <form onSubmit={submit} className="space-y-3">
              <AuthField
                label="Correo"
                mono
                type="email"
                required
                autoComplete="email"
                placeholder="tu@empresa.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <Button type="submit" disabled={loading} className="w-full py-2.5">
                {loading ? 'Enviando…' : 'Enviar enlace'}
              </Button>
            </form>
          </>
        )}

        <p className="mt-4 text-center text-xs">
          <Link href="/login" className="font-semibold text-primary hover:underline">
            Volver a iniciar sesión
          </Link>
        </p>

        {err && <AuthError>{err}</AuthError>}
      </AuthBody>
    </AuthDocument>
  );
}
