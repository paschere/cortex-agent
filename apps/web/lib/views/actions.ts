'use server';

import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  SubmissionLimitError,
  ViewConflictError,
  archiveView,
  createView,
  defineTracker,
  getTrackerBySlug,
  mustGetView,
  restoreViewVersion,
  setViewAccess,
  submitViewForm,
  trackerFieldsSchema,
  trackerSlugSchema,
  updateView,
  validateSpec,
} from '@cortex/agent-tools';
import { NotFoundError, ValidationError } from '@cortex/core';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

/**
 * Lo que hacen los botones de /views.
 *
 * Pasan por las mismas funciones que las herramientas `views.*` del chat: una
 * vista guardada desde el editor y una guardada desde una conversación tienen
 * que ser la misma cosa, validada contra el mismo catálogo.
 *
 * QUIÉN PUEDE QUÉ. Cualquiera del espacio crea y edita (cada guardado es una
 * versión que se deshace). Abrir la puerta de afuera, ponerle contraseña o
 * archivar la vista es de quien la creó o de un administrador: es la decisión
 * de sacar filas de la empresa, y no la toma cualquiera que pasaba por ahí.
 */

export type ViewActionResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

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

const newTrackerSchema = z.object({
  slug: trackerSlugSchema,
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(''),
  fields: trackerFieldsSchema,
});
export type NewTracker = z.infer<typeof newTrackerSchema>;

const saveInput = z.object({
  viewId: z.string().uuid().optional(),
  expectedVersion: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(''),
  spec: z.unknown(),
  newTrackers: z.array(newTrackerSchema).max(3).default([]),
  prompt: z.string().trim().max(2000).optional(),
});

export async function saveViewAction(
  raw: z.input<typeof saveInput>,
): Promise<ViewActionResult<{ slug: string; version: number }>> {
  try {
    const input = saveInput.parse(raw);
    const user = await requireSession();
    const db = getOrgScopedClient(user.organization.id);
    // Las tablas nuevas que propuso el diseñador se crean SÓLO si no existen:
    // guardar una vista nunca le cambia el esquema a una tabla que ya tiene
    // filas. Eso sigue siendo `trackers.define`, con su confirmación.
    for (const t of input.newTrackers) {
      if (await getTrackerBySlug(db, t.slug)) continue;
      await defineTracker(db, { ...t, userId: user.id });
    }
    const spec = await validateSpec(db, input.spec);
    const view = input.viewId
      ? await updateView(db, input.viewId, {
          name: input.name,
          description: input.description,
          spec,
          userId: user.id,
          prompt: input.prompt ?? null,
          expectedVersion: input.expectedVersion,
        })
      : await createView(db, {
          name: input.name,
          description: input.description,
          spec,
          userId: user.id,
          prompt: input.prompt ?? null,
        });
    revalidatePath('/views');
    revalidatePath(`/views/${view.slug}`);
    return { ok: true, slug: view.slug, version: view.version };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo guardar la vista.') };
  }
}

async function manageable(viewId: string) {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const view = await mustGetView(db, viewId);
  if (user.role !== 'org_admin' && view.created_by !== user.id)
    throw new ValidationError(
      'Sólo quien creó la vista o un administrador puede cambiar cómo se comparte.',
    );
  return { user, db, view };
}

const accessInput = z.object({
  visibility: z.enum(['workspace', 'link', 'password']),
  password: z.string().max(200).optional(),
  days: z.number().int().min(1).max(365).nullable().optional(),
  rotate: z.boolean().optional(),
});

export async function setViewAccessAction(
  viewId: string,
  raw: z.input<typeof accessInput>,
): Promise<ViewActionResult<{ token: string | null; expiresAt: string | null }>> {
  try {
    const input = accessInput.parse(raw);
    const { user, db, view } = await manageable(viewId);
    const next = await setViewAccess(db, view.id, {
      visibility: input.visibility,
      password: input.password || undefined,
      days: input.visibility === 'workspace' ? undefined : (input.days ?? null),
      rotate: input.rotate,
      userId: user.id,
    });
    revalidatePath(`/views/${view.slug}`);
    revalidatePath('/views');
    return { ok: true, token: next.share_token, expiresAt: next.share_expires_at };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo cambiar el acceso.') };
  }
}

export async function setViewPinnedAction(
  viewId: string,
  pinned: boolean,
): Promise<ViewActionResult> {
  try {
    const user = await requireSession();
    const db = getOrgScopedClient(user.organization.id);
    const view = await setViewAccess(db, viewId, { pinned, userId: user.id });
    revalidatePath(`/views/${view.slug}`);
    revalidatePath('/views');
    revalidatePath('/dashboard');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo fijar la vista.') };
  }
}

export async function restoreViewVersionAction(
  viewId: string,
  version: number,
): Promise<ViewActionResult<{ version: number }>> {
  try {
    const user = await requireSession();
    const db = getOrgScopedClient(user.organization.id);
    const view = await restoreViewVersion(db, viewId, version, user.id);
    revalidatePath(`/views/${view.slug}`);
    return { ok: true, version: view.version };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo restaurar esa versión.') };
  }
}

export async function archiveViewAction(viewId: string): Promise<ViewActionResult> {
  try {
    const { db, view } = await manageable(viewId);
    await archiveView(db, view.id);
    revalidatePath('/views');
    revalidatePath('/dashboard');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo archivar la vista.') };
  }
}

export async function submitViewFormAction(
  viewId: string,
  blockId: string,
  values: Record<string, string>,
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  try {
    const user = await requireSession();
    const db = getOrgScopedClient(user.organization.id);
    const view = await mustGetView(db, viewId);
    const res = await submitViewForm(db, view, { blockId, values, submittedBy: user.id });
    revalidatePath(`/views/${view.slug}`);
    return { ok: true, message: res.message };
  } catch (err) {
    if (err instanceof SubmissionLimitError) return { ok: false, error: err.message };
    return { ok: false, error: describe(err, 'No se pudo enviar el formulario.') };
  }
}
