'use server';

import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  defineTracker,
  flowSchema,
  getTrackerBySlug,
  trackerFieldsSchema,
  viewerFromSession,
} from '@cortex/agent-tools';
import { NotFoundError, ValidationError } from '@cortex/core';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

/**
 * Guardar (o quitar) el flujo por estados de una tabla desde el editor.
 *
 * El flujo vive en la definición del campo de estado; aquí se reconstruye el
 * esquema de la tabla con el flujo puesto y se valida con el mismo contrato
 * que usa el chat (`trackerFieldsSchema`). Sólo quien administra la empresa
 * cambia el esquema de una tabla.
 */

export type FlowActionResult = { ok: true } | { ok: false; error: string };

const input = z.object({
  slug: z.string().trim().min(1).max(60),
  field: z.string().trim().min(1).max(40),
  flow: flowSchema.nullable(),
  /** Estados que aún no son opciones del campo: se agregan. */
  addOptions: z.array(z.string().trim().min(1).max(80)).max(12).optional(),
});

export async function saveTrackerFlowAction(raw: z.input<typeof input>): Promise<FlowActionResult> {
  try {
    const parsed = input.parse(raw);
    const user = await requireSession();
    if (!viewerFromSession(user).companyAdmin)
      throw new ValidationError('Sólo quien administra la empresa puede cambiar una tabla.');
    const db = getOrgScopedClient(user.organization.id);
    const tracker = await getTrackerBySlug(db, parsed.slug);
    if (!tracker) throw new NotFoundError('Esa tabla ya no existe.');
    const target = tracker.fields.find((f) => f.key === parsed.field);
    if (!target || target.type !== 'select')
      throw new ValidationError('El estado tiene que ser un campo de opciones.');
    const fields = trackerFieldsSchema.parse(
      tracker.fields.map((f) => {
        const { flow: _old, ...rest } = f;
        if (f.key !== parsed.field) return rest;
        const options = [...new Set([...(f.options ?? []), ...(parsed.addOptions ?? [])])];
        return parsed.flow ? { ...rest, options, flow: parsed.flow } : { ...rest, options };
      }),
    );
    await defineTracker(db, {
      slug: tracker.slug,
      name: tracker.name,
      description: tracker.description,
      fields,
      userId: user.id,
    });
    revalidatePath('/apps');
    revalidatePath(`/trackers/${tracker.slug}`);
    return { ok: true };
  } catch (err) {
    if (err instanceof z.ZodError)
      return {
        ok: false,
        error: err.issues
          .slice(0, 3)
          .map((i) => i.message)
          .join(' '),
      };
    if (err instanceof ValidationError || err instanceof NotFoundError)
      return { ok: false, error: err.message };
    return { ok: false, error: 'No se pudo guardar el flujo.' };
  }
}
