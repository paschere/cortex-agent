'use server';

import { appCookieName, cookieOptions, openExternalApp } from '@/lib/apps/external-session';
import { codeAttemptsByIp, codeRequestsByEmail, codeRequestsByIp } from '@/lib/apps/rate-limit';
import { sendEmail } from '@/lib/email';
import { renderAppLoginCodeEmail } from '@/lib/email-templates/app-access';
import {
  CODE_TTL_MINUTES,
  deviceLabel,
  isValidEmail,
  normalizeAppEmail,
  requestLoginCode,
  resolveExternalSession,
  revokeSessionByToken,
  revokeUserSessions,
  verifyLoginCode,
} from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { cookies, headers } from 'next/headers';

/**
 * LA ENTRADA DE UN USUARIO EXTERNO (/a/<app>): pedir el código, usarlo y salir.
 *
 * LO QUE NO DICE. Ninguna respuesta revela si un correo está invitado: «te
 * enviamos un código si ese correo tiene acceso» sale igual exista o no, esté
 * desactivado o tope la hora; y un código malo, vencido o bloqueado es el
 * mismo «código incorrecto». Sólo hay dos respuestas distintas y ninguna habla
 * de la persona: el tope por IP («demasiados intentos») y el formato.
 */

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const CODE_SENT_MESSAGE =
  'Si ese correo tiene acceso a esta aplicación, te enviamos un código. Revisa tu bandeja (y la carpeta de no deseados).';
const WRONG_CODE = 'El código no es correcto o ya venció. Pide uno nuevo si hace falta.';
const TOO_MANY = 'Demasiados intentos. Espera un rato y vuelve a intentar.';

function secret(): string {
  const key = (process.env.BETTER_AUTH_SECRET ?? '').trim();
  if (!key && process.env.NODE_ENV === 'production') throw new Error('BETTER_AUTH_SECRET missing');
  return key || 'cortex-dev-app-login';
}

async function clientIp(): Promise<string> {
  const h = await headers();
  return (
    h.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    h.get('x-real-ip')?.trim() ||
    'sin-ip'
  ).slice(0, 64);
}

/** Pedir el código por correo. Responde lo mismo exista o no el correo. */
export async function requestAppCodeAction(
  appId: string,
  rawEmail: string,
): Promise<Result<{ message: string }>> {
  const email = normalizeAppEmail(String(rawEmail ?? ''));
  if (!isValidEmail(email)) return { ok: false, error: 'Escribe un correo válido.' };
  const ip = await clientIp();
  if (!codeRequestsByIp.take(`${appId}:${ip}`) || !codeRequestsByEmail.take(`${appId}:${email}`))
    return { ok: false, error: TOO_MANY };
  try {
    const opened = await openExternalApp(appId);
    if (opened) {
      const issued = await requestLoginCode(opened.db, opened.app, email, { secret: secret() });
      if (issued.issued) {
        const mail = renderAppLoginCodeEmail({
          appName: opened.app.name,
          code: issued.code,
          minutes: CODE_TTL_MINUTES,
        });
        const sent = await sendEmail({ to: email, ...mail });
        if (!sent.sent) logger.warn({ reason: sent.reason }, 'apps: login code email not sent');
      }
    }
  } catch (err) {
    // Un fallo interno no cambia lo que ve quien pide: tampoco lo delata.
    logger.error({ err }, 'apps: request login code failed');
  }
  return { ok: true, message: CODE_SENT_MESSAGE };
}

/** Comprobar el código y abrir la sesión (cookie httpOnly de esta app). */
export async function verifyAppCodeAction(
  appId: string,
  rawEmail: string,
  rawCode: string,
): Promise<Result> {
  const email = normalizeAppEmail(String(rawEmail ?? ''));
  const ip = await clientIp();
  if (!codeAttemptsByIp.take(`${appId}:${ip}`)) return { ok: false, error: TOO_MANY };
  try {
    const opened = await openExternalApp(appId);
    if (!opened) return { ok: false, error: WRONG_CODE };
    const h = await headers();
    const outcome = await verifyLoginCode(opened.db, opened.app, email, String(rawCode ?? ''), {
      secret: secret(),
      device: deviceLabel(h.get('user-agent')),
    });
    if (!outcome.ok) return { ok: false, error: WRONG_CODE };
    const jar = await cookies();
    jar.set(
      appCookieName(opened.app.id),
      outcome.token,
      cookieOptions(new Date(outcome.expiresAt)),
    );
    return { ok: true };
  } catch (err) {
    logger.error({ err }, 'apps: verify login code failed');
    return { ok: false, error: 'No se pudo entrar ahora. Intenta de nuevo.' };
  }
}

/** Cerrar ESTA sesión: se revoca en el servidor y se borra la cookie. */
export async function signOutAppAction(appId: string): Promise<Result> {
  try {
    const opened = await openExternalApp(appId);
    const jar = await cookies();
    const name = appCookieName(opened?.app.id ?? appId);
    const token = jar.get(name)?.value;
    if (opened && token) await revokeSessionByToken(opened.db, opened.app, token);
    jar.delete(name);
    return { ok: true };
  } catch (err) {
    logger.error({ err }, 'apps: sign out failed');
    return { ok: false, error: 'No se pudo cerrar la sesión.' };
  }
}

/** «Cerrar todas mis sesiones»: todos los dispositivos de esta persona. */
export async function signOutEverywhereAction(appId: string): Promise<Result> {
  try {
    const opened = await openExternalApp(appId);
    if (!opened) return { ok: false, error: 'Esa aplicación no existe.' };
    const jar = await cookies();
    const name = appCookieName(opened.app.id);
    const session = await resolveExternalSession(opened.db, opened.app, jar.get(name)?.value);
    if (session) await revokeUserSessions(opened.db, session.user.id);
    jar.delete(name);
    return { ok: true };
  } catch (err) {
    logger.error({ err }, 'apps: sign out everywhere failed');
    return { ok: false, error: 'No se pudo cerrar las sesiones.' };
  }
}
