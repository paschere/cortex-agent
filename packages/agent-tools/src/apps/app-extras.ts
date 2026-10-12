import { ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { z } from 'zod';
import { viewCatalog } from '../views/store';
import { updateView, validateSpec } from '../views/store';
import {
  createAutomation,
  listAutomations,
  setAutomationEnabled,
  updateAutomation,
} from './automations/store';
import {
  type ClientPortal,
  PORTAL_AUTOMATION_NAME,
  PORTAL_UPLOAD_SCREEN,
  buildPortalRole,
  mergePortal,
  portalAutomationInput,
  portalPatchSchema,
  portalProblems,
  portalUploadSpec,
} from './client-portal';
import {
  type CustomAppRow,
  MAX_APP_ROLES,
  addScreen,
  listRoles,
  listScreens,
  removeScreen,
  saveRoles,
  updateApp,
} from './store';
import { type Tablero, tableroProblems, tablerosSchema } from './tablero';

/**
 * Guardar tableros y portal con TODA la validación contra lo que existe
 * (tablas, campos, pantallas, roles). Lo comparten el editor, el chat
 * (`apps.update`) y la plantilla. Todo cambio cae en el BORRADOR: publicar es
 * `publishVersion` (versions.ts).
 */

export async function saveTableros(
  db: SupabaseClient,
  app: CustomAppRow,
  raw: unknown,
  userId: string,
): Promise<{ app: CustomAppRow; tableros: Tablero[] }> {
  const parsed = tablerosSchema.safeParse(raw);
  if (!parsed.success)
    throw new ValidationError(
      `Los tableros no tienen la forma esperada: ${parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || 'tableros'}: ${i.message}`)
        .join('; ')}.`,
    );
  const [catalog, screens, roles] = await Promise.all([
    viewCatalog(db, {}),
    listScreens(db, app.id),
    listRoles(db, app.id),
  ]);
  const problems = tableroProblems(parsed.data, {
    trackers: catalog,
    screenSlugs: screens.map((s) => s.slug),
    roleKeys: roles.map((r) => r.key),
  });
  if (problems.length) throw new ValidationError(problems.slice(0, 8).join(' '));
  const updated = await updateApp(db, app.id, { dashboards: parsed.data, userId });
  return { app: updated, tableros: parsed.data };
}

export async function savePortal(
  db: SupabaseClient,
  app: CustomAppRow,
  patch: z.input<typeof portalPatchSchema>,
  userId: string,
): Promise<{ app: CustomAppRow; portal: ClientPortal; notes: string[] }> {
  const parsedPatch = portalPatchSchema.parse(patch);
  const portal = mergePortal(app.portal, parsedPatch);
  const notes: string[] = [];
  const [catalog, screens] = await Promise.all([viewCatalog(db, {}), listScreens(db, app.id)]);
  const problems = portalProblems(portal, {
    trackers: catalog,
    screenSlugs: [...screens.map((s) => s.slug), PORTAL_UPLOAD_SCREEN],
  });
  if (problems.length) throw new ValidationError(problems.slice(0, 8).join(' '));

  if (portal.enabled) {
    // El rol de los clientes: sus permisos salen del portal.
    const roles = await listRoles(db, app.id);
    const role = buildPortalRole(portal);
    const others = roles.filter((r) => r.key !== role.key);
    if (others.length >= MAX_APP_ROLES)
      throw new ValidationError(
        `Una aplicación lleva hasta ${MAX_APP_ROLES} roles; quita uno para el portal.`,
      );
    await saveRoles(db, app.id, [
      ...others.map((r) => ({
        key: r.key,
        name: r.name,
        description: r.description,
        permissions: r.permissions,
      })),
      role,
    ]);
    notes.push(`rol «${role.key}» con lectura por $user.${portal.attribute}`);
  }

  // La pantalla de «Subir soporte».
  const current = (await listScreens(db, app.id)).find((s) => s.slug === PORTAL_UPLOAD_SCREEN);
  const spec = portal.enabled ? portalUploadSpec(portal) : null;
  if (spec) {
    const valid = await validateSpec(db, spec, { viewerId: userId });
    if (current) {
      await updateView(db, current.view_id, {
        spec: valid,
        userId,
        prompt: 'Portal de clientes',
        appScreen: true,
      });
    } else {
      await addScreen(db, app, {
        title: portal.upload?.title ?? 'Subir soporte',
        slug: PORTAL_UPLOAD_SCREEN,
        icon: 'Upload',
        roles: [portal.roleKey],
        spec: valid,
        userId,
        prompt: 'Portal de clientes',
      });
    }
    notes.push('pantalla «Subir soporte»');
  } else if (current) {
    await removeScreen(db, app.id, current.id);
  }

  // El aviso a la empresa cuando llega un soporte.
  const rules = await listAutomations(db, app.id);
  const existing = rules.find((r) => r.name === PORTAL_AUTOMATION_NAME);
  const input = spec ? portalAutomationInput(portal) : null;
  if (input) {
    if (existing) await updateAutomation(db, app.id, existing.id, input);
    else await createAutomation(db, app.id, input, userId);
    notes.push('aviso «Un cliente subió un soporte»');
  } else if (existing?.enabled) {
    await setAutomationEnabled(db, app.id, existing.id, false);
  }

  const updated = await updateApp(db, app.id, { portal, userId });
  return { app: updated, portal, notes };
}
