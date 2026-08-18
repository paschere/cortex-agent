'use client';

import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';
import { safeNextPath } from '@/lib/invite-landing';
import {
  SIGNUP_CODE_COOKIE,
  SIGNUP_CODE_MAX_AGE_SECONDS,
  SIGNUP_CODE_MAX_LENGTH,
  normalizeSignupCode,
} from '@/lib/signup-code';
import {
  WORKSPACE_NAME_COOKIE,
  WORKSPACE_NAME_MAX_AGE_SECONDS,
  WORKSPACE_NAME_MAX_LENGTH,
} from '@/lib/workspace-cookie';
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

/** Carry the company name to the request that provisions the workspace. */
function rememberCompany(company: string): void {
  const trimmed = company.trim().slice(0, WORKSPACE_NAME_MAX_LENGTH);
  if (!trimmed) return;
  document.cookie =
    `${WORKSPACE_NAME_COOKIE}=${encodeURIComponent(trimmed)}; Path=/; ` +
    `Max-Age=${WORKSPACE_NAME_MAX_AGE_SECONDS}; SameSite=Lax`;
}

/**
 * Carry the invite code to the request that creates the account.
 *
 * Una cookie y no un campo enviado a `signUp.email`, por lo mismo que la del
 * nombre de la empresa: con Google el navegador se va a otro dominio y vuelve, y
 * un campo del formulario no sobrevive ese viaje. Aquí sólo se transporta — la
 * comprobación está en el servidor, en `assertMaySignUp` (lib/auth.ts), donde
 * nadie puede saltársela editando esto.
 */
function rememberSignupCode(code: string): void {
  const normalized = normalizeSignupCode(code).slice(0, SIGNUP_CODE_MAX_LENGTH);
  if (!normalized) return;
  document.cookie =
    `${SIGNUP_CODE_COOKIE}=${encodeURIComponent(normalized)}; Path=/; ` +
    `Max-Age=${SIGNUP_CODE_MAX_AGE_SECONDS}; SameSite=Lax`;
}

/**
 * A dónde va la persona después de registrarse.
 *
 * `/` mientras nadie pida otra cosa — pero un invitado SÍ pide otra cosa. El
 * middleware manda a `/login?next=/accept-invitation/<id>` a quien abre el
 * enlace sin sesión, `login` ya lo honraba, y `signup` no: tenía `'/'` escrito a
 * mano en los dos caminos. El resultado era que quien no tenía cuenta —o sea el
 * caso NORMAL de una invitación— perdía el destino justo al registrarse y
 * aterrizaba en cualquier otro sitio con la invitación sin aceptar.
 *
 * `safeNextPath` es lo que impide que esto se convierta en una redirección
 * abierta; ver su comentario.
 */
function nextUrl(): string {
  if (typeof window === 'undefined') return '/';
  const requested = new URLSearchParams(window.location.search).get('next');
  return safeNextPath(requested) ?? '/';
}

export default function SignupPage() {
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [code, setCode] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState<'google' | 'email' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function signUpGoogle() {
    // El botón de Google vive FUERA del formulario, así que el `required` del
    // campo no lo detiene. Sin esta guarda, quien no traiga código se va a
    // Google, se autentica, vuelve, y sólo entonces recibe la negativa — con una
    // cuenta de Google ya vinculada a nada. Es más honesto pararlo aquí.
    if (!normalizeSignupCode(code)) {
      setErr('Escribe el código de invitación antes de continuar con Google.');
      return;
    }
    setLoading('google');
    setErr(null);
    rememberCompany(company);
    rememberSignupCode(code);
    try {
      await authClient.signIn.social({ provider: 'google', callbackURL: nextUrl() });
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
    rememberCompany(company);
    rememberSignupCode(code);
    const { error } = await authClient.signUp.email({
      name,
      email,
      password,
      callbackURL: nextUrl(),
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
            className="inline-flex w-full items-center justify-center rounded-pill border border-border bg-surface px-3.5 py-2.5 text-sm font-semibold text-ink shadow-card transition-all duration-150 hover:-translate-y-px hover:border-border-strong hover:bg-surface-2 motion-reduce:transform-none motion-reduce:transition-none"
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
        <AuthTitle hint="Empieza gratis, sin tarjeta. Creas el espacio de tu empresa e invitas a tu equipo tú mismo.">
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
          {/* Optional on purpose. It names the workspace and it is the first
              thing the person's colleagues will see, but a required field
              between somebody and the product they have not tried yet is a
              field that loses signups. Left blank, the workspace gets their
              name and can be renamed later. */}
          <AuthField
            label="Empresa"
            type="text"
            autoComplete="organization"
            placeholder="Transportes del Valle"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
          />
          {/* Obligatorio mientras el acceso sea por invitación. Va DESPUÉS de la
              empresa y antes del correo a propósito: quien tiene el código lo
              tiene a mano y lo pega sin pensar, y quien no lo tiene se entera
              antes de escribir una contraseña que no le va a servir. */}
          <AuthField
            label="Código de invitación"
            type="text"
            required
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="CORTEX-2026-…"
            value={code}
            onChange={(e) => setCode(e.target.value)}
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

        <p className="mt-4 text-center text-xs text-ink-faint">
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
