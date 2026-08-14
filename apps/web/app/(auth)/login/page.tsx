'use client';

import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';
import { FileCheck2, Repeat2, ShieldCheck } from 'lucide-react';
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

const CLAIMS = [
  { icon: FileCheck2, text: 'Cada respuesta dice de qué sistema salió y cuándo se leyó' },
  { icon: Repeat2, text: 'Flujos reutilizables y rutinas que corren sin que estés encima' },
  { icon: ShieldCheck, text: 'Tú apruebas cada escritura, y toda acción queda registrada' },
];

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState<'google' | 'email' | null>(null);
  const [err, setErr] = useState<string | null>(null);

  function nextUrl() {
    return new URLSearchParams(window.location.search).get('next') ?? '/';
  }

  async function signInGoogle() {
    setLoading('google');
    setErr(null);
    try {
      await authClient.signIn.social({ provider: 'google', callbackURL: nextUrl() });
    } catch (e) {
      setErr(
        e instanceof Error
          ? e.message
          : 'No se pudo abrir el ingreso con Google. Inténtalo de nuevo o entra con tu correo y contraseña.',
      );
      setLoading(null);
    }
  }

  async function signInEmail(e: React.FormEvent) {
    e.preventDefault();
    setLoading('email');
    setErr(null);
    const { error } = await authClient.signIn.email({
      email,
      password,
      callbackURL: nextUrl(),
    });
    if (error) {
      setErr(
        error.message ??
          'Ese correo y esa contraseña no coinciden con ninguna cuenta. Revísalos e inténtalo de nuevo.',
      );
      setLoading(null);
    }
  }

  return (
    <AuthDocument>
      <AuthMasthead />

      <AuthBody>
        <AuthTitle hint="Cortex responde con los sistemas que tu empresa ya usa, y te muestra de dónde salió cada dato.">
          Iniciar sesión
        </AuthTitle>

        <form onSubmit={signInEmail} className="space-y-3">
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
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Button type="submit" disabled={loading !== null} className="w-full py-2.5">
            {loading === 'email' ? 'Iniciando sesión…' : 'Iniciar sesión'}
          </Button>
        </form>

        <AuthDivider />

        <Button
          type="button"
          variant="outline"
          onClick={signInGoogle}
          disabled={loading !== null}
          className="w-full py-2.5"
        >
          {loading === 'google' ? 'Redirigiendo…' : 'Continuar con Google'}
        </Button>

        <div className="mt-4 flex items-center justify-between gap-3 text-xs">
          <Link href="/forgot-password" className="text-ink-faint hover:text-ink-muted">
            ¿Olvidaste tu contraseña?
          </Link>
          <Link href="/signup" className="font-semibold text-primary hover:underline">
            Crear una cuenta
          </Link>
        </div>

        {err && <AuthError>{err}</AuthError>}
      </AuthBody>

      {/* A soft fade rather than a hard rule — structure without turning the
          card into a form. Used once, here, to separate the act of signing in
          from what signing in gets you. */}
      <div className="rule-double mx-6 sm:mx-8" />
      <ul className="divide-y divide-border px-6 pb-4 sm:px-8">
        {CLAIMS.map((c) => (
          <li
            key={c.text}
            className="flex items-start gap-2.5 py-2.5 text-xs leading-snug text-ink-muted"
          >
            <c.icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
            {c.text}
          </li>
        ))}
      </ul>
    </AuthDocument>
  );
}
