'use server';

import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  type AppPreview,
  appDraftSchema,
  buildAppPreview,
  getTrackerBySlug,
  trackersOf,
  viewerFromSession,
} from '@cortex/agent-tools';
import { z } from 'zod';

/**
 * LA VISTA PREVIA DE UN BORRADOR DE APP («Vista previa de la app», en el chat).
 *
 * Recibe el borrador tal como lo devolvió `apps.design`, lee SÓLO el esquema de
 * las tablas que ya existen (nunca filas) y devuelve la app calculada para un
 * rol con filas de ejemplo. No escribe nada. Sólo quien administra la empresa
 * (es quien puede crear la app).
 */

export type PreviewActionResult = { ok: true; preview: AppPreview } | { ok: false; error: string };

const input = z.object({
  draft: z.unknown(),
  roleKey: z.string().trim().max(40).nullish(),
  record: z
    .object({
      screen: z.string().max(60),
      blockId: z.string().max(60),
      rowId: z.string().max(60),
    })
    .nullish(),
});

export async function previewAppDraftAction(
  raw: z.input<typeof input>,
): Promise<PreviewActionResult> {
  try {
    const { draft, roleKey, record } = input.parse(raw);
    const user = await requireSession();
    if (!viewerFromSession(user).companyAdmin)
      return { ok: false, error: 'Sólo quien administra la empresa ve la vista previa.' };
    const parsed = appDraftSchema.safeParse(draft);
    if (!parsed.success) return { ok: false, error: 'El borrador no tiene la forma esperada.' };
    const db = getOrgScopedClient(user.organization.id);
    const slugs = [...new Set(parsed.data.screens.flatMap((s) => trackersOf(s.spec)))].filter(
      (s) => !s.includes('.'),
    );
    const catalog = [];
    for (const slug of slugs) {
      const t = await getTrackerBySlug(db, slug);
      if (t) catalog.push({ slug: t.slug, name: t.name, fields: t.fields });
    }
    return {
      ok: true,
      preview: buildAppPreview(parsed.data, catalog, {
        roleKey: roleKey ?? null,
        record: record ?? null,
      }),
    };
  } catch {
    return { ok: false, error: 'No se pudo armar la vista previa.' };
  }
}
