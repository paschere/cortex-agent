'use server';

import { appSecret } from '@/lib/apps/server-util';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  clearUserPin,
  createPairing,
  mustGetApp,
  revokeDevice,
  setKioskSettings,
  setUserPin,
  viewerFromSession,
} from '@cortex/agent-tools';
import { NotFoundError, ValidationError } from '@cortex/core';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

/**
 * EL MODO KIOSCO EN EL EDITOR DE LA APP (0211): activarlo y fijar los minutos
 * sin uso, agregar un dispositivo (enlace de un solo uso), revocarlo y asignar
 * o reiniciar el PIN de una persona. Como el resto del editor, sólo de quien
 * administra la empresa (aquí la misma regla: una server action no pasa por la
 * página).
 */

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

function describe(err: unknown, fallback: string): string {
  if (err instanceof z.ZodError) return err.issues[0]?.message ?? fallback;
  if (err instanceof ValidationError || err instanceof NotFoundError) return err.message;
  return fallback;
}

async function admin(appRef: string) {
  const user = await requireSession();
  if (!viewerFromSession(user).companyAdmin)
    throw new ValidationError('Sólo quien administra la empresa puede cambiar una aplicación.');
  const db = getOrgScopedClient(user.organization.id);
  const app = await mustGetApp(db, z.string().trim().min(1).max(80).parse(appRef));
  return { user, db, app };
}

function touched(appId: string) {
  revalidatePath(`/apps/${appId}/edit`);
}

export async function setKioskSettingsAction(
  appRef: string,
  input: { enabled?: boolean; idleMinutes?: number },
): Promise<Result> {
  try {
    const { db, app } = await admin(appRef);
    await setKioskSettings(db, app.id, input);
    touched(app.id);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo guardar el modo kiosco.') };
  }
}

/** Crea el dispositivo y devuelve la ruta con el código (un solo uso, 15 min): el editor la muestra para abrirla en el celular. */
export async function createKioskPairingAction(
  appRef: string,
  name: string,
): Promise<Result<{ path: string; expiresAt: string }>> {
  try {
    const { user, db, app } = await admin(appRef);
    const { code, expiresAt } = await createPairing(db, app, { name, by: user.id });
    touched(app.id);
    return { ok: true, path: `/a/${app.id}/kiosco?c=${encodeURIComponent(code)}`, expiresAt };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo agregar el dispositivo.') };
  }
}

export async function revokeKioskDeviceAction(appRef: string, deviceId: string): Promise<Result> {
  try {
    const { db, app } = await admin(appRef);
    await revokeDevice(db, app.id, z.string().uuid().parse(deviceId));
    touched(app.id);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo revocar el dispositivo.') };
  }
}

/** Asignar o reiniciar el PIN de una persona (también la destraba). */
export async function setUserPinAction(
  appRef: string,
  userId: string,
  pin: string,
): Promise<Result> {
  try {
    const { db, app } = await admin(appRef);
    await setUserPin(db, app.id, z.string().uuid().parse(userId), String(pin ?? ''), {
      secret: appSecret(),
    });
    touched(app.id);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo guardar el PIN.') };
  }
}

export async function clearUserPinAction(appRef: string, userId: string): Promise<Result> {
  try {
    const { db, app } = await admin(appRef);
    await clearUserPin(db, app.id, z.string().uuid().parse(userId));
    touched(app.id);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo quitar el PIN.') };
  }
}
