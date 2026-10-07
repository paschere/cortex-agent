'use server';

import { openApp } from '@/lib/apps/access';
import {
  appCookieName,
  cookieOptions,
  getAppUser,
  openExternalApp,
} from '@/lib/apps/external-session';
import { deviceCookieName, deviceCookieOptions, getKioskDevice } from '@/lib/apps/kiosk-session';
import { pinAttemptsByDevice, pinAttemptsByIp } from '@/lib/apps/rate-limit';
import { appSecret, clientIp } from '@/lib/apps/server-util';
import {
  canEnrollKiosk,
  changeOwnPin,
  claimPairing,
  enrollDevice,
  getKioskSettings,
  listKioskPeople,
  pinLogin,
  revokeUserSessions,
} from '@cortex/agent-tools';
import { NotFoundError, ValidationError, logger } from '@cortex/core';
import { cookies } from 'next/headers';

/**
 * EL MODO KIOSCO PARA QUIEN USA EL CELULAR (0211): entrar con PIN, cambiar el
 * propio PIN, dejar este celular en modo kiosco y reclamar el enlace de
 * emparejamiento que creó el administrador. Lo del editor (ajustes, enlaces,
 * revocar, asignar PIN) está en kiosk-admin-actions.ts.
 *
 * NO REVELAN NADA DE MÁS. Un PIN malo, una persona sin PIN o desactivada y un
 * dispositivo revocado dan la misma respuesta; sólo el bloqueo (que la propia
 * persona necesita saber) y los intentos que quedan se dicen.
 */

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const TOO_MANY = 'Demasiados intentos desde este dispositivo. Espera unos minutos.';

function describe(err: unknown, fallback: string): string {
  if (err instanceof ValidationError || err instanceof NotFoundError) return err.message;
  return fallback;
}

/** Tocar el nombre y escribir el PIN. Abre la sesión de la persona en ESTE dispositivo. */
export async function pinLoginAction(appId: string, userId: string, pin: string): Promise<Result> {
  const ip = await clientIp();
  const ctx = await getKioskDevice(appId);
  // Sin dispositivo autorizado el PIN no vale: la misma respuesta que un PIN malo.
  const wrong = { ok: false as const, error: 'PIN incorrecto.' };
  if (!ctx) return wrong;
  if (!pinAttemptsByIp.take(`${ctx.app.id}:${ip}`) || !pinAttemptsByDevice.take(ctx.device.id))
    return { ok: false, error: TOO_MANY };
  try {
    const outcome = await pinLogin(
      ctx.db,
      ctx.app,
      ctx.token,
      String(userId ?? ''),
      String(pin ?? ''),
      {
        secret: appSecret(),
      },
    );
    if (!outcome.ok) {
      if (outcome.reason === 'locked')
        return {
          ok: false,
          error: 'Demasiados intentos con ese PIN. Espera un rato o pide que te reinicien el PIN.',
        };
      return {
        ok: false,
        error:
          outcome.attemptsLeft !== undefined && outcome.attemptsLeft <= 2
            ? `PIN incorrecto. Te quedan ${outcome.attemptsLeft} intentos.`
            : 'PIN incorrecto.',
      };
    }
    const jar = await cookies();
    // La cookie de la persona NO es persistente: vive lo que el navegador. La inactividad
    // y el tope de turno los hace cumplir el servidor en cada petición.
    jar.set(appCookieName(ctx.app.id), outcome.token, {
      ...cookieOptions(new Date(outcome.expiresAt)),
    });
    return { ok: true };
  } catch (err) {
    logger.error({ err }, 'apps: kiosk pin login failed');
    return { ok: false, error: 'No se pudo entrar ahora. Intenta de nuevo.' };
  }
}

/** La lista de nombres del kiosco (sólo con un dispositivo autorizado). */
export async function kioskPeopleAction(
  appId: string,
): Promise<Result<{ people: Array<{ id: string; name: string }> }>> {
  const ctx = await getKioskDevice(appId);
  if (!ctx) return { ok: false, error: 'Este celular no está en modo kiosco.' };
  return { ok: true, people: await listKioskPeople(ctx.db, ctx.app.id) };
}

/** «Mi PIN»: ponerlo o cambiarlo. En un kiosco pide el PIN actual; con sesión por correo, no. */
export async function changeMyPinAction(
  appId: string,
  input: { current?: string; next: string },
): Promise<Result> {
  try {
    const ctx = await getAppUser(appId);
    if (!ctx) return { ok: false, error: 'Tu sesión ya no está abierta.' };
    if (!(await getKioskSettings(ctx.db, ctx.app.id)).enabled)
      return { ok: false, error: 'Esta aplicación no usa PIN.' };
    const res = await changeOwnPin(
      ctx.db,
      ctx.app.id,
      ctx.user.id,
      {
        current: input.current,
        next: String(input.next ?? ''),
        viaDevice: Boolean(ctx.session.deviceId),
      },
      { secret: appSecret() },
    );
    return res.ok ? { ok: true } : { ok: false, error: res.message };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo cambiar el PIN.') };
  }
}

/**
 * Dejar ESTE celular en modo kiosco: lo hace un supervisor con el permiso del
 * rol (o un administrador de la empresa). El dispositivo queda ligado a la app;
 * la sesión de quien lo dejó se cierra para que el celular quede en la lista de
 * nombres.
 */
export async function enrollThisDeviceAction(appId: string, name: string): Promise<Result> {
  try {
    const opened = await openApp(appId);
    if (!opened) return { ok: false, error: 'No tienes acceso a esta aplicación.' };
    if (!canEnrollKiosk(opened.access.role))
      return { ok: false, error: 'Tu rol no puede dejar un celular en modo kiosco.' };
    const ext = await openExternalApp(opened.access.app.id);
    if (!ext) return { ok: false, error: 'La aplicación tiene que estar publicada.' };
    const { token } = await enrollDevice(ext.db, ext.app, {
      name,
      by: opened.actor.id,
      kind: opened.external ? 'app_user' : 'member',
    });
    const jar = await cookies();
    jar.set(deviceCookieName(ext.app.id), token, deviceCookieOptions());
    if (opened.external) {
      const user = await getAppUser(ext.app.id);
      if (user) await revokeUserSessions(ext.db, user.user.id);
      jar.delete(appCookieName(ext.app.id));
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo dejar el celular en modo kiosco.') };
  }
}

/** El celular abre el enlace de emparejamiento y toca «Dejar este celular en modo kiosco». */
export async function claimKioskPairingAction(appId: string, code: string): Promise<Result> {
  const ip = await clientIp();
  if (!pinAttemptsByIp.take(`claim:${appId}:${ip}`)) return { ok: false, error: TOO_MANY };
  try {
    const opened = await openExternalApp(appId);
    const claimed = opened ? await claimPairing(opened.db, opened.app, String(code ?? '')) : null;
    if (!opened || !claimed)
      return {
        ok: false,
        error:
          'Ese enlace ya no sirve (se usó o venció). Pide uno nuevo a quien administra la app.',
      };
    (await cookies()).set(deviceCookieName(opened.app.id), claimed.token, deviceCookieOptions());
    return { ok: true };
  } catch (err) {
    logger.error({ err }, 'apps: kiosk pairing claim failed');
    return { ok: false, error: 'No se pudo emparejar el celular. Intenta de nuevo.' };
  }
}
