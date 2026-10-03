'use client';

import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';
import { authErrorMessage } from '@/lib/auth-error-message';
import {
  SIGNUP_PLAN_COOKIE,
  type SignupMode,
  TRIAL_PLAN_LABEL,
  type TrialPlanCode,
} from '@/lib/billing/config';
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
import { type ReactNode, useRef, useState } from 'react';
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

/** Carry the trial plan (SIGNUP_MODE=open) to the request that creates the company. */
function rememberPlan(plan: string): void {
  document.cookie = `${SIGNUP_PLAN_COOKIE}=${encodeURIComponent(plan)}; Path=/; Max-Age=${WORKSPACE_NAME_MAX_AGE_SECONDS}; SameSite=Lax`;
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

export interface SignupFormProps {
  /** SIGNUP_MODE, resuelto en el servidor (lib/billing/config.ts). */
  mode: SignupMode;
  /** ¿Pide código? 'request' siempre; 'invite' sólo con SIGNUP_INVITE_CODE. */
  needsCode: boolean;
  /** Días de prueba en 'open'. */
  trialDays: number;
  /** Plan de prueba preseleccionado (de ?plan= o TRIAL_PLAN). */
  defaultPlan: TrialPlanCode;
  /**
   * ======================================================================
   * RANURA DEL CONSENTIMIENTO (legal, migración 0188)
   * ======================================================================
   * Lo que se pinte aquí va DENTRO del formulario, justo antes del botón.
   * Si incluye un `<input type="checkbox" required data-signup-consent />`:
   *   - con correo, el navegador no deja enviar sin marcarlo (`required`);
   *   - con Google (botón fuera del formulario), este componente lo
   *     comprueba antes de salir hacia Google.
   * El flujo (modos, código, prueba) es de este archivo; el texto legal y
   * lo que se guarda del consentimiento son de quien llena la ranura.
   */
  consent?: ReactNode;
}

export function SignupForm({ mode, needsCode, trialDays, defaultPlan, consent }: SignupFormProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const [plan, setPlan] = useState<TrialPlanCode>(defaultPlan);
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
    if (needsCode && !normalizeSignupCode(code)) {
      setErr('Escribe el código de invitación antes de continuar con Google.');
      return;
    }
    if (mode === 'open' && !company.trim()) {
      setErr('Escribe el nombre de tu empresa antes de continuar con Google.');
      return;
    }
    const consentBox = formRef.current?.querySelector<HTMLInputElement>(
      'input[data-signup-consent]',
    );
    if (consentBox && !consentBox.checked) {
      setErr('Acepta las condiciones antes de continuar con Google.');
      consentBox.focus();
      return;
    }
    setLoading('google');
    setErr(null);
    rememberCompany(company);
    if (needsCode) rememberSignupCode(code);
    if (mode === 'open') rememberPlan(plan);
    try {
      await authClient.signIn.social({ provider: 'google', callbackURL: nextUrl() });
    } catch (e) {
      setErr(
        authErrorMessage(
          e,
          'No se pudo abrir el registro con Google. Inténtalo de nuevo o usa tu correo y contraseña.',
        ),
      );
      setLoading(null);
    }
  }

  async function signUpEmail(e: React.FormEvent) {
    e.preventDefault();
    setLoading('email');
    setErr(null);
    rememberCompany(company);
    if (needsCode) rememberSignupCode(code);
    if (mode === 'open') rememberPlan(plan);
    const { error } = await authClient.signUp.email({
      name,
      email,
      password,
      callbackURL: nextUrl(),
    });
    if (error) {
      setErr(
        authErrorMessage(
          error,
          'No se pudo crear la cuenta. Revisa los datos e inténtalo de nuevo.',
        ),
      );
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
        <AuthMasthead note="Inteligencia conectada a tu operación." />
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
      <AuthMasthead note="Inteligencia conectada a tu operación." />

      <AuthBody>
        <AuthTitle
          hint={
            mode === 'open'
              ? `Sin tarjeta. Tu empresa empieza con ${trialDays} días de prueba con todo incluido; después eliges si sigues.`
              : 'Sin tarjeta. Con tu código de invitación creas el espacio de tu empresa y después invitas a tu equipo tú mismo.'
          }
        >
          Crea tu cuenta
        </AuthTitle>

        <form ref={formRef} onSubmit={signUpEmail} className="space-y-3">
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
            required={mode === 'open'}
            autoComplete="organization"
            placeholder="Transportes del Valle"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
          />
          {/* Obligatorio mientras el acceso sea por invitación. Va DESPUÉS de la
              empresa y antes del correo a propósito: quien tiene el código lo
              tiene a mano y lo pega sin pensar, y quien no lo tiene se entera
              antes de escribir una contraseña que no le va a servir. */}
          {needsCode && (
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
          )}
          {/* Registro abierto: la prueba es de un plan, y se elige aquí. Se
              puede cambiar después en Plan y consumo sin perder nada. */}
          {mode === 'open' && (
            <fieldset className="space-y-1.5">
              <legend className="mb-1.5 text-xs font-semibold text-ink-muted">
                Plan para tu prueba de {trialDays} días
              </legend>
              <div className="grid grid-cols-2 gap-2">
                {(Object.keys(TRIAL_PLAN_LABEL) as TrialPlanCode[]).map((code) => (
                  <label
                    key={code}
                    className={`flex cursor-pointer items-center gap-2 rounded-sm border px-3 py-2 text-sm ${
                      plan === code
                        ? 'border-primary bg-primary-soft text-ink'
                        : 'border-border bg-surface text-ink-muted'
                    }`}
                  >
                    <input
                      type="radio"
                      name="trial-plan"
                      value={code}
                      checked={plan === code}
                      onChange={() => setPlan(code)}
                      className="accent-[var(--color-primary,#4f46e5)]"
                    />
                    {TRIAL_PLAN_LABEL[code]}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
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
          {/* RANURA DEL CONSENTIMIENTO (legal, 0188): ver `consent` arriba. */}
          {consent}
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

        {mode === 'request' && (
          <p className="mt-4 text-center text-xs text-ink-faint">
            ¿No tienes código?{' '}
            <Link href="/acceso" className="font-semibold text-primary hover:underline">
              Pide tu acceso
            </Link>
          </p>
        )}
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
