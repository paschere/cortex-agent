'use server';

import { sendAppInvitations } from '@/lib/apps/invitations';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  type AppUserInput,
  importAppUsers,
  inviteAppUser,
  mustGetApp,
  parseUsersCsv,
  removeAppUser,
  setAppUserStatus,
  updateAppUser,
  viewerFromSession,
} from '@cortex/agent-tools';
import { NotFoundError, ValidationError } from '@cortex/core';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

/**
 * «Usuarios» del editor de la app (0209): invitar uno por uno o por CSV,
 * reenviar, cambiar rol o atributos, desactivar (corta sus sesiones) y quitar.
 * Como el resto del editor, es sólo de quien administra la empresa
 * (`requireAppAdmin`: aquí la misma regla, porque una server action no pasa
 * por la página).
 */

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

function describe(err: unknown, fallback: string): string {
  if (err instanceof z.ZodError) return err.issues[0]?.message ?? fallback;
  if (err instanceof ValidationError || err instanceof NotFoundError) return err.message;
  const message = err instanceof Error ? err.message : '';
  return message && message.length < 240 && !/[{}]|relation|column|violates/.test(message)
    ? message
    : fallback;
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

export async function inviteAppUserAction(
  appRef: string,
  raw: AppUserInput,
  options: { send?: boolean } = {},
): Promise<Result<{ emailed: boolean; note: string | null }>> {
  try {
    const { user, db, app } = await admin(appRef);
    const { user: invited } = await inviteAppUser(db, app.id, raw, user.id);
    let emailed = false;
    let note: string | null = null;
    if (options.send !== false) {
      const res = await sendAppInvitations(db, app.id, [invited.id]);
      emailed = res.sent > 0;
      note = res.failed[0]?.reason ?? null;
    }
    touched(app.id);
    return { ok: true, emailed, note };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo invitar.') };
  }
}

export async function importAppUsersAction(
  appRef: string,
  csv: string,
  options: { send?: boolean } = {},
): Promise<
  Result<{ invited: number; emailed: number; skipped: Array<{ line: number; reason: string }> }>
> {
  try {
    const { user, db, app } = await admin(appRef);
    const parsed = parseUsersCsv(String(csv).slice(0, 400_000));
    if (parsed.error) return { ok: false, error: parsed.error };
    const res = await importAppUsers(db, app.id, parsed.rows, user.id);
    let emailed = 0;
    if (options.send !== false && res.invited.length)
      emailed = (
        await sendAppInvitations(
          db,
          app.id,
          res.invited.map((u) => u.id),
        )
      ).sent;
    touched(app.id);
    return { ok: true, invited: res.invited.length, emailed, skipped: res.skipped };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo importar.') };
  }
}

export async function resendAppInvitationAction(
  appRef: string,
  userId: string,
): Promise<Result<{ message: string }>> {
  try {
    const { db, app } = await admin(appRef);
    const res = await sendAppInvitations(db, app.id, [userId]);
    touched(app.id);
    if (res.sent) return { ok: true, message: 'Invitación reenviada.' };
    return { ok: false, error: res.failed[0]?.reason ?? 'No se pudo enviar.' };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo reenviar.') };
  }
}

const patchInput = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  roleKey: z.string().trim().max(32).optional(),
  attributes: z.record(z.string(), z.string().max(120)).optional(),
});

export async function updateAppUserAction(
  appRef: string,
  userId: string,
  raw: z.input<typeof patchInput>,
): Promise<Result> {
  try {
    const { db, app } = await admin(appRef);
    await updateAppUser(db, app.id, userId, patchInput.parse(raw));
    touched(app.id);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo guardar.') };
  }
}

/** Desactivar corta todas sus sesiones en el mismo paso; reactivar lo deja entrar con código. */
export async function setAppUserStatusAction(
  appRef: string,
  userId: string,
  status: 'active' | 'disabled',
): Promise<Result> {
  try {
    const { db, app } = await admin(appRef);
    await setAppUserStatus(db, app.id, userId, status);
    touched(app.id);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo cambiar el estado.') };
  }
}

export async function removeAppUserAction(appRef: string, userId: string): Promise<Result> {
  try {
    const { db, app } = await admin(appRef);
    await removeAppUser(db, app.id, userId);
    touched(app.id);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo quitar.') };
  }
}
