'use client';

import {
  LEGAL_DOCUMENT_PATH,
  SIGNUP_CONSENT_COOKIE,
  SIGNUP_CONSENT_MAX_AGE_SECONDS,
  encodeSignupConsent,
} from '@/lib/legal/versions';

/**
 * La casilla de la autorización en el registro (Ley 1581: previa, expresa e
 * informada). SIN marcar por defecto, `required` para el envío con correo y con
 * `data-signup-consent` para que SignupForm la compruebe antes de salir hacia
 * Google.
 *
 * Marcarla deja una cookie corta con las versiones aceptadas
 * (lib/legal/versions.ts); desmarcarla la borra. La primera página con sesión
 * (components/legal/ConsentGate.tsx) la convierte en la fila de
 * `legal_consents` con IP (huella) y navegador. Una cookie y no un campo del
 * formulario por lo mismo que el nombre de la empresa: con Google el navegador
 * se va y vuelve, y un campo no sobrevive ese viaje.
 */
export function SignupConsent() {
  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    document.cookie = e.target.checked
      ? `${SIGNUP_CONSENT_COOKIE}=${encodeURIComponent(encodeSignupConsent())}; Path=/; Max-Age=${SIGNUP_CONSENT_MAX_AGE_SECONDS}; SameSite=Lax`
      : `${SIGNUP_CONSENT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
  }

  return (
    <label className="flex cursor-pointer items-start gap-2.5 text-xs leading-relaxed text-ink-muted">
      <input
        type="checkbox"
        required
        data-signup-consent
        onChange={onChange}
        className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
      />
      <span>
        Acepto los{' '}
        <a
          href={LEGAL_DOCUMENT_PATH.terminos}
          target="_blank"
          rel="noreferrer"
          className="font-semibold text-primary hover:underline"
        >
          Términos y condiciones
        </a>{' '}
        y autorizo de manera previa, expresa e informada el tratamiento de mis datos personales
        según la{' '}
        <a
          href={LEGAL_DOCUMENT_PATH.tratamiento}
          target="_blank"
          rel="noreferrer"
          className="font-semibold text-primary hover:underline"
        >
          Política de tratamiento de datos
        </a>{' '}
        y la{' '}
        <a
          href={LEGAL_DOCUMENT_PATH.privacidad}
          target="_blank"
          rel="noreferrer"
          className="font-semibold text-primary hover:underline"
        >
          Política de privacidad
        </a>
        , incluida su transmisión a proveedores fuera de Colombia.
      </span>
    </label>
  );
}
