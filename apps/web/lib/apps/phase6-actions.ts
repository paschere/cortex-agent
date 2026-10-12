'use server';

import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  type ClientPortal,
  type Tablero,
  ViewConflictError,
  listRoles,
  listScreens,
  listTrackers,
  mustGetApp,
  publishVersion,
  restoreVersion,
  savePortal,
  saveTableros,
  screenViews,
  suggestPortal,
  suggestTableros,
  unpublishApp,
  viewCatalog,
  viewerFromSession,
} from '@cortex/agent-tools';
import { NotFoundError, ValidationError } from '@cortex/core';
import { revalidatePath } from 'next/cache';

/**
 * Acciones del editor de apps de la fase 6 (0225): publicar con versión,
 * historial, tableros y portal. Todo cambio cae en el BORRADOR; sólo
 * `publishAppAction` (o restaurar con «y publicar») cambia lo que ven los
 * usuarios. Es de quien administra la empresa.
 */

export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

function describe(err: unknown, fallback: string): string {
  if (
    err instanceof ViewConflictError ||
    err instanceof ValidationError ||
    err instanceof NotFoundError
  )
    return err.message;
  const message = err instanceof Error ? err.message : '';
  return message && message.length < 240 && !/[{}]|relation|column|violates/.test(message)
    ? message
    : fallback;
}

async function admin() {
  const user = await requireSession();
  if (!viewerFromSession(user).companyAdmin)
    throw new ValidationError('Sólo quien administra la empresa puede cambiar una aplicación.');
  return { user, db: getOrgScopedClient(user.organization.id) };
}

function touched(app: { id: string; slug: string }) {
  revalidatePath('/apps');
  revalidatePath(`/apps/${app.id}/edit`);
  revalidatePath(`/apps/${app.slug}`);
}

export async function publishAppAction(
  appId: string,
  note?: string,
): Promise<Result<{ number: number; created: boolean; changes: string[] }>> {
  try {
    const { user, db } = await admin();
    const res = await publishVersion(db, appId, { userId: user.id, note });
    touched(res.app);
    return {
      ok: true,
      number: res.number,
      created: res.created,
      changes: res.changes.map((c) => c.text),
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo publicar la aplicación.') };
  }
}

export async function unpublishAppAction(appId: string): Promise<Result> {
  try {
    const { user, db } = await admin();
    touched(await unpublishApp(db, appId, user.id));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo despublicar la aplicación.') };
  }
}

export async function restoreVersionAction(
  appId: string,
  number: number,
  publish: boolean,
): Promise<Result<{ done: string[]; skipped: string[] }>> {
  try {
    const { user, db } = await admin();
    const res = await restoreVersion(db, appId, number, { userId: user.id, publish });
    touched(res.app);
    return { ok: true, done: res.done, skipped: res.skipped };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo volver a esa versión.') };
  }
}

export async function saveTablerosAction(appId: string, raw: unknown): Promise<Result> {
  try {
    const { user, db } = await admin();
    const app = await mustGetApp(db, appId);
    const res = await saveTableros(db, app, raw, user.id);
    touched(res.app);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudieron guardar los tableros.') };
  }
}

/** Un tablero por rol sobre la tabla que más usan las pantallas. No guarda: devuelve la propuesta. */
export async function suggestTablerosAction(
  appId: string,
): Promise<Result<{ tableros: Tablero[] }>> {
  try {
    const { db } = await admin();
    const app = await mustGetApp(db, appId);
    const screens = await listScreens(db, app.id);
    const views = await screenViews(db, screens);
    const used = new Map<string, number>();
    for (const v of views.values())
      for (const b of v.spec.blocks)
        if ('tracker' in b) used.set(b.tracker, (used.get(b.tracker) ?? 0) + 1);
    const catalog = await viewCatalog(db, {});
    const ordered = [...used.entries()]
      .sort((a, b) => b[1] - a[1])
      .flatMap(([slug]) => catalog.filter((c) => c.slug === slug));
    const tableros = suggestTableros({
      trackers: ordered,
      roles: await listRoles(db, app.id),
      screen: screens[0]?.slug,
    });
    if (!tableros.length)
      throw new ValidationError(
        'Las pantallas todavía no leen una tabla propia sobre la cual sugerir.',
      );
    return { ok: true, tableros };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo sugerir tableros.') };
  }
}

export async function savePortalAction(
  appId: string,
  raw: unknown,
): Promise<Result<{ portal: ClientPortal; notes: string[] }>> {
  try {
    const { user, db } = await admin();
    const app = await mustGetApp(db, appId);
    const res = await savePortal(db, app, raw as never, user.id);
    touched(res.app);
    return { ok: true, portal: res.portal, notes: res.notes };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo guardar el portal.') };
  }
}

export async function suggestPortalAction(): Promise<Result<{ portal: ClientPortal }>> {
  try {
    const { db } = await admin();
    const trackers = await listTrackers(db, 40);
    return { ok: true, portal: suggestPortal(trackers) };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo sugerir el portal.') };
  }
}
