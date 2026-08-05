'use client';

import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';
import Link from 'next/link';
import { useState } from 'react';
import {
  AuthBody,
  AuthDivider,
  AuthDocument,
  AuthError,
  AuthField,
  AuthMasthead,
  AuthTitle,
} from '../_components/AuthDocument';

export default function SignupPage() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState<'google' | 'email' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function signUpGoogle() {
    setLoading('google');
    setErr(null);
    try {
      await authClient.signIn.social({ provider: 'google', callbackURL: '/' });
    } catch (e) {
      setErr(
        e instanceof Error
          ? e.message
          : 'No se pudo abrir el registro con Google. Inténtalo de nuevo o usa tu correo y contraseña.',
      );
      setLoading(null);
    }
  }

  async function signUpEmail(e: React.FormEvent) {
    e.preventDefault();
    setLoading('email');
    setErr(null);
    const { error } = await authClient.signUp.email({
      name,
      email,
      password,
      callbackURL: '/',
    });
    if (error) {
      setErr(error.message ?? 'No se pudo crear la cuenta. Revisa los datos e inténtalo de nuevo.');
      setLoading(null);
      return;
    }
    // With no email provider configured, verification is off and sign-up
    // already returns a live session — send them into the product instead of
    // to a screen telling them to check an inbox nothing was sent to. Asking
    // the client for the session is what makes this self-correcting: configure
    // Resend and the same code shows the inbox screen again.
    const { data: session } = await authClient.getSession();
    if (session?.user) {
      window.location.href = '/';
      return;
    }
    setDone(true);
  }

  if (done) {
    return (
      <AuthDocument>
        <AuthMasthead />
        <AuthBody>
          <AuthTitle
            hint={
              <>
                El enlace de verificación salió para{' '}
                <span className="font-mono text-ink">{email}</span>. Ábrelo para activar la cuenta.
              </>
            }
          >
            Revisa tu correo
          </AuthTitle>
          {/* A link, not a Button, because it navigates — nesting a button
              inside an anchor is invalid and breaks keyboard activation. Styled
              to match the outline Button so it still reads as the one action
              on the screen. */}
          <Link
            href="/login"
            className="inline-flex w-full items-center justify-center rounded-pill border border-border bg-surface px-3.5 py-2.5 text-[13px] font-semibold text-ink shadow-card transition-all duration-150 hover:-translate-y-px hover:border-border-strong hover:bg-surface-2 motion-reduce:transform-none motion-reduce:transition-none"
          >
            Volver a iniciar sesión
          </Link>
        </AuthBody>
      </AuthDocument>
    );
  }

  return (
    <AuthDocument>
      <AuthMasthead />

      <AuthBody>
        <AuthTitle hint="Empieza gratis. Invita a tu equipo a un espacio compartido cuando quieras.">
          Crea tu cuenta
        </AuthTitle>

        <form onSubmit={signUpEmail} className="space-y-3">
          <AuthField
            label="Nombre completo"
            type="text"
            required
            autoComplete="name"
            placeholder="Ana Restrepo"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
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
          <AuthField
            label="Contraseña"
            mono
            type="password"
            required
            minLength={10}
            autoComplete="new-password"
            placeholder="10 caracteres o más"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Button type="submit" disabled={loading !== null} className="w-full py-2.5">
            {loading === 'email' ? 'Creando cuenta…' : 'Crear cuenta'}
          </Button>
        </form>

        <AuthDivider />

        <Button
          type="button"
          variant="outline"
          onClick={signUpGoogle}
          disabled={loading !== null}
          className="w-full py-2.5"
        >
          {loading === 'google' ? 'Redirigiendo…' : 'Continuar con Google'}
        </Button>

        <p className="mt-4 text-center text-[12px] text-ink-faint">
          ¿Ya tienes cuenta?{' '}
          <Link href="/login" className="font-semibold text-primary hover:underline">
            Inicia sesión
          </Link>
        </p>

        {err && <AuthError>{err}</AuthError>}
      </AuthBody>
    </AuthDocument>
  );
}
