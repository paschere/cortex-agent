/**
 * RE-AUTENTICACIÓN ANTES DE CAMBIAR QUIÉN ES FUNDADOR — la decisión, sin base.
 *
 * Dar la propiedad es lo más caro que se puede hacer en una empresa: un
 * cofundador puede borrarla y retirar a los demás. Una sesión abierta no basta
 * para pedir eso: el portátil prestado, la cookie robada o la pestaña que
 * alguien dejó abierta tienen sesión válida. Por eso se pide volver a probar
 * quién es, con el factor más fuerte que esa cuenta tenga:
 *
 *   1. `totp`          — la cuenta tiene verificación en dos pasos: se pide el
 *                        código actual de la app. Una sesión robada sin el
 *                        teléfono no pasa.
 *   2. `password`      — sin 2FA pero con contraseña: se vuelve a escribir. Se
 *                        pide SIEMPRE, aunque la sesión sea nueva: teclearla es
 *                        una prueba más fuerte que «hace poco entró».
 *   3. `fresh_session` — la cuenta sólo entra con Google (no tiene contraseña
 *                        que verificar): se acepta si la sesión se abrió hace
 *                        menos de 10 minutos.
 *   4. `sign_in_again` — lo mismo, pero con la sesión vieja: hay que salir y
 *                        volver a entrar.
 */

export const FRESH_SESSION_MS = 10 * 60 * 1000;

export type StepUpRequirement = 'totp' | 'password' | 'fresh_session' | 'sign_in_again';

export interface StepUpFacts {
  twoFactorEnabled: boolean;
  hasPassword: boolean;
  /** Milisegundos desde que se abrió la sesión (`ba_session.createdAt`). */
  sessionAgeMs: number;
}

export function stepUpRequirement(facts: StepUpFacts): StepUpRequirement {
  if (facts.twoFactorEnabled) return 'totp';
  if (facts.hasPassword) return 'password';
  return facts.sessionAgeMs <= FRESH_SESSION_MS ? 'fresh_session' : 'sign_in_again';
}

/** Qué se le pide a la persona, en la voz del diálogo. */
export const STEP_UP_COPY: Record<StepUpRequirement, string> = {
  totp: 'Escribe el código de 6 dígitos de tu app de autenticación.',
  password: 'Escribe tu contraseña para confirmar que eres tú.',
  fresh_session: 'Tu sesión es reciente, así que no necesitas escribir nada más.',
  sign_in_again:
    'Tu sesión lleva más de 10 minutos abierta y tu cuenta entra con Google. Cierra sesión y vuelve a entrar para poder hacer este cambio.',
};

/** Lo que manda el navegador; el servidor decide cuál campo se mira. */
export interface StepUpInput {
  password?: string;
  code?: string;
}
