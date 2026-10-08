'use server';

import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  type AppRoleRow,
  type AppScreenRow,
  type CustomAppRow,
  ViewConflictError,
  addScreen,
  appTemplate,
  appThemeSchema,
  archiveApp,
  attributesSchema,
  createApp,
  deleteApp,
  installAppTemplate,
  locationSettingsPatchSchema,
  mustGetApp,
  removeMember,
  removeScreen,
  reorderScreens,
  restoreApp,
  roleInputSchema,
  saveRoles,
  setMember,
  updateApp,
  updateScreen,
  viewerFromSession,
} from '@cortex/agent-tools';
import { NotFoundError, ValidationError } from '@cortex/core';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

/**
 * Lo que hacen los botones de /apps y del editor /apps/<id>/edit.
 *
 * QUIÉN PUEDE QUÉ. Crear, editar, publicar y archivar una aplicación, y
 * decidir qué rol tiene cada miembro, es de quien administra la empresa
 * (owner/admin): es repartir pantallas y filas a gente que no es «del
 * equipo» en el sentido de las vistas. Las pantallas se editan con el
 * editor de vistas (`saveViewAction`, lib/views/actions.ts): una pantalla ES
 * una vista, y guardar su spec pasa por el mismo contrato y el mismo catálogo.
 */

export type AppActionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

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
  const viewer = viewerFromSession(user);
  if (!viewer.companyAdmin)
    throw new ValidationError('Sólo quien administra la empresa puede cambiar una aplicación.');
  return { user, db: getOrgScopedClient(user.organization.id) };
}

function touched(app: Pick<CustomAppRow, 'id' | 'slug'>) {
  revalidatePath('/apps');
  revalidatePath(`/apps/${app.id}`);
  revalidatePath(`/apps/${app.slug}`);
  revalidatePath(`/apps/${app.id}/edit`);
}

const createInput = z.object({
  template: z.string().trim().max(40).optional(),
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).optional(),
  icon: z.string().trim().max(400).optional(),
});

/** Nueva aplicación: desde una plantilla (con sus tablas, roles y pantallas) o en blanco. */
export async function createAppAction(
  raw: z.input<typeof createInput>,
): Promise<AppActionResult<{ id: string; slug: string }>> {
  try {
    const input = createInput.parse(raw);
    const { user, db } = await admin();
    if (input.template) {
      const template = appTemplate(input.template);
      if (!template) throw new ValidationError('Esa plantilla no existe.');
      const { app } = await installAppTemplate(db, template, {
        userId: user.id,
        name: input.name,
        description: input.description,
      });
      touched(app);
      return { ok: true, id: app.id, slug: app.slug };
    }
    const app = await createApp(db, {
      name: input.name ?? 'Aplicación nueva',
      description: input.description,
      icon: input.icon,
      userId: user.id,
    });
    touched(app);
    return { ok: true, id: app.id, slug: app.slug };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo crear la aplicación.') };
  }
}

const updateInput = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).optional(),
  icon: z.string().trim().max(400).optional(),
  theme: appThemeSchema.optional(),
  homeScreen: z.string().trim().max(48).nullable().optional(),
  status: z.enum(['draft', 'published']).optional(),
});

export async function updateAppAction(
  appId: string,
  raw: z.input<typeof updateInput>,
): Promise<AppActionResult<{ status: CustomAppRow['status'] }>> {
  try {
    const input = updateInput.parse(raw);
    const { user, db } = await admin();
    const app = await updateApp(db, appId, { ...input, userId: user.id });
    touched(app);
    return { ok: true, status: app.status };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo guardar la aplicación.') };
  }
}

/**
 * «Compartir ubicación del equipo»: encender o apagar y cuántos días se guarda el
 * rastro. Es de quien administra: decide si una app sabe dónde está su gente.
 * Apagarla borra todas las posiciones guardadas.
 */
export async function saveLocationSettingsAction(
  appId: string,
  raw: unknown,
): Promise<AppActionResult<{ enabled: boolean; retentionDays: number }>> {
  try {
    const patch = locationSettingsPatchSchema.parse(raw);
    const { user, db } = await admin();
    const app = await updateApp(db, appId, { location: patch, userId: user.id });
    touched(app);
    return { ok: true, ...app.location };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo guardar la ubicación del equipo.') };
  }
}

export async function archiveAppAction(appId: string): Promise<AppActionResult> {
  try {
    const { db } = await admin();
    const app = await mustGetApp(db, appId);
    await archiveApp(db, app.id);
    touched(app);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo archivar la aplicación.') };
  }
}

export async function restoreAppAction(appId: string): Promise<AppActionResult> {
  try {
    const { db } = await admin();
    const app = await mustGetApp(db, appId, { includeArchived: true });
    if (!(await restoreApp(db, app.id)))
      throw new ValidationError('Esa aplicación no está archivada.');
    touched(app);
    revalidatePath('/views');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo restaurar la aplicación.') };
  }
}

export async function deleteAppAction(appId: string): Promise<AppActionResult> {
  try {
    const { db } = await admin();
    // Incluye las archivadas: se eliminan desde «Archivadas».
    const app = await mustGetApp(db, appId, { includeArchived: true });
    await deleteApp(db, app.id);
    touched(app);
    revalidatePath('/views');
    revalidatePath('/dashboard');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo eliminar la aplicación.') };
  }
}

const screenInput = z.object({
  title: z.string().trim().min(1).max(60),
  icon: z.string().trim().max(60).optional(),
  roles: z.array(z.string().trim().max(32)).max(8).default([]),
  /** Un spec de vista; sin él, una pantalla con un texto para empezar. */
  spec: z.unknown().optional(),
});

export async function addScreenAction(
  appId: string,
  raw: z.input<typeof screenInput>,
): Promise<AppActionResult<{ screen: AppScreenRow }>> {
  try {
    const input = screenInput.parse(raw);
    const { user, db } = await admin();
    const app = await mustGetApp(db, appId);
    const screen = await addScreen(db, app, {
      title: input.title,
      icon: input.icon,
      roles: input.roles,
      spec: input.spec ?? {
        version: 1,
        accent: app.theme.accent ?? 'primary',
        refreshSeconds: 30,
        editing: 'team',
        alerts: [],
        blocks: [
          {
            id: 'titulo',
            type: 'text',
            width: 'full',
            markdown: `## ${input.title}\n\nEdita esta pantalla con el lienzo o pídele a Cortex que la arme.`,
          },
        ],
      },
      userId: user.id,
      prompt: 'Pantalla nueva desde el editor',
    });
    touched(app);
    return { ok: true, screen };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo agregar la pantalla.') };
  }
}

const screenPatch = z.object({
  title: z.string().trim().min(1).max(60).optional(),
  icon: z.string().trim().max(60).optional(),
  roles: z.array(z.string().trim().max(32)).max(8).optional(),
});

export async function updateScreenAction(
  appId: string,
  screenId: string,
  raw: z.input<typeof screenPatch>,
): Promise<AppActionResult<{ screen: AppScreenRow }>> {
  try {
    const input = screenPatch.parse(raw);
    const { db } = await admin();
    const app = await mustGetApp(db, appId);
    const screen = await updateScreen(db, app.id, screenId, input);
    touched(app);
    return { ok: true, screen };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo cambiar la pantalla.') };
  }
}

export async function reorderScreensAction(
  appId: string,
  orderedIds: string[],
): Promise<AppActionResult> {
  try {
    const { db } = await admin();
    const app = await mustGetApp(db, appId);
    await reorderScreens(db, app.id, z.array(z.string().uuid()).max(12).parse(orderedIds));
    touched(app);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo ordenar las pantallas.') };
  }
}

export async function removeScreenAction(
  appId: string,
  screenId: string,
): Promise<AppActionResult> {
  try {
    const { db } = await admin();
    const app = await mustGetApp(db, appId);
    await removeScreen(db, app.id, screenId);
    touched(app);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo quitar la pantalla.') };
  }
}

export async function saveRolesAction(
  appId: string,
  raw: unknown,
): Promise<AppActionResult<{ roles: AppRoleRow[] }>> {
  try {
    const roles = z.array(roleInputSchema).max(8).parse(raw);
    const { db } = await admin();
    const app = await mustGetApp(db, appId);
    const saved = await saveRoles(db, app.id, roles);
    touched(app);
    return { ok: true, roles: saved };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudieron guardar los roles.') };
  }
}

const memberInput = z.object({
  userId: z.string().uuid(),
  roleKey: z.string().trim().min(1).max(32),
  attributes: attributesSchema.optional(),
});

export async function setMemberAction(
  appId: string,
  raw: z.input<typeof memberInput>,
): Promise<AppActionResult> {
  try {
    const input = memberInput.parse(raw);
    const { user, db } = await admin();
    const app = await mustGetApp(db, appId);
    await setMember(db, app.id, { ...input, by: user.id });
    touched(app);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo asignar el rol.') };
  }
}

export async function removeMemberAction(appId: string, userId: string): Promise<AppActionResult> {
  try {
    const { db } = await admin();
    const app = await mustGetApp(db, appId);
    await removeMember(db, app.id, z.string().uuid().parse(userId));
    touched(app);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo quitar el miembro.') };
  }
}
