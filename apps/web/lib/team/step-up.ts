import 'server-only';

/**
 * Re-autenticación en el servidor: lee los hechos de la cuenta, decide qué
 * pedir (step-up-rules.ts) y lo VERIFICA con better-auth. Nada de esto se fía
 * del navegador: ni qué factor corresponde, ni que «ya lo confirmé».
 *
 * - `totp`: `auth.api.verifyTOTP` con las cabeceras de la sesión comprueba el
 *   código contra el secreto cifrado de ESA cuenta (la ruta de sesión de
 *   better-auth no crea sesiones nuevas ni toca cookies cuando la 2FA ya está
 *   activa).
 * - `password`: `auth.api.verifyPassword`, un endpoint sólo de servidor que
 *   compara con el hash de la cuenta.
 * - `fresh_session`: la edad de `session.createdAt`. `updateAge` de la sesión
 *   sólo estira `expiresAt`, así que `createdAt` es el momento real de entrada.
 *
 * Freno de fuerza bruta: la ruta de sesión de better-auth no cuenta fallos de
 * TOTP (sólo lo hace en el inicio de sesión), y un código de 6 dígitos con
 * ventana de 30 s es adivinable si nadie cuenta. Aquí se frena a cinco fallos
 * por cuenta cada diez minutos, en memoria del proceso: no es un límite global
 * entre instancias, pero corta el intento automatizado desde una sesión robada.
 */

import { auth, pool } from '../auth';
import {
  STEP_UP_COPY,
  type StepUpFacts,
  type StepUpInput,
  type StepUpRequirement,
  stepUpRequirement,
} from './step-up-rules';

export interface StepUpState {
  requirement: StepUpRequirement;
  twoFactorEnabled: boolean;
  hasPassword: boolean;
}

export async function readStepUp(accountId: string, requestHeaders: Headers): Promise<StepUpState> {
  const { rows } = await pool.query<{ twoFactorEnabled: boolean | null; hasPassword: boolean }>(
    `select u."twoFactorEnabled" as "twoFactorEnabled",
            exists (
              select 1 from public.ba_account a
               where a."userId" = u.id and a."providerId" = 'credential'
            ) as "hasPassword"
       from public.ba_user u
      where u.id = $1`,
    [accountId],
  );
  const row = rows[0];
  const session = await auth.api.getSession({ headers: requestHeaders });
  const createdAt = (session?.session as { createdAt?: Date | string } | undefined)?.createdAt;
  const sessionAgeMs = createdAt
    ? Date.now() - new Date(createdAt).getTime()
    : Number.POSITIVE_INFINITY;
  const facts: StepUpFacts = {
    twoFactorEnabled: row?.twoFactorEnabled === true,
    hasPassword: row?.hasPassword === true,
    sessionAgeMs,
  };
  return {
    requirement: stepUpRequirement(facts),
    twoFactorEnabled: facts.twoFactorEnabled,
    hasPassword: facts.hasPassword,
  };
}

const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES = 5;
const failures = new Map<string, number[]>();

function recentFailures(accountId: string, now: number): number[] {
  const kept = (failures.get(accountId) ?? []).filter((at) => now - at < WINDOW_MS);
  failures.set(accountId, kept);
  return kept;
}

/** Sólo para pruebas. */
export function resetStepUpFailures() {
  failures.clear();
}

export type StepUpResult =
  | { ok: true }
  | { ok: false; requirement: StepUpRequirement; message: string };

export async function verifyStepUp(input: {
  accountId: string;
  requestHeaders: Headers;
  credential: StepUpInput;
}): Promise<StepUpResult> {
  const state = await readStepUp(input.accountId, input.requestHeaders);
  const { requirement } = state;
  if (requirement === 'sign_in_again') {
    return { ok: false, requirement, message: STEP_UP_COPY.sign_in_again };
  }
  if (requirement === 'fresh_session') return { ok: true };

  const now = Date.now();
  if (recentFailures(input.accountId, now).length >= MAX_FAILURES) {
    return {
      ok: false,
      requirement,
      message: 'Demasiados intentos fallidos. Espera unos minutos e inténtalo de nuevo.',
    };
  }
  const fail = (message: string): StepUpResult => {
    recentFailures(input.accountId, now).push(now);
    return { ok: false, requirement, message };
  };

  try {
    if (requirement === 'totp') {
      const code = (input.credential.code ?? '').replace(/\s+/g, '');
      if (!/^\d{6}$/.test(code)) return fail('Escribe el código de 6 dígitos de tu app.');
      await auth.api.verifyTOTP({ body: { code }, headers: input.requestHeaders });
    } else {
      const password = input.credential.password ?? '';
      if (!password) return fail('Escribe tu contraseña.');
      await auth.api.verifyPassword({ body: { password }, headers: input.requestHeaders });
    }
  } catch {
    return fail(
      requirement === 'totp'
        ? 'Ese código no es válido. Cambian cada 30 segundos: escribe el actual.'
        : 'Esa contraseña no es correcta.',
    );
  }
  failures.delete(input.accountId);
  return { ok: true };
}
