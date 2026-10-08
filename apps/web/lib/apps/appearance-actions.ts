'use server';

import { dropAppImage, putAppImage } from '@/lib/apps/app-assets';
import { colorReport } from '@/lib/apps/app-brand';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  APP_FONTS,
  type AppBrand,
  type AppImageKind,
  type AppImageRef,
  IMAGE_KINDS,
  appHomeSchema,
  appWelcomeSchema,
  listScreens,
  mustGetApp,
  updateApp,
  viewerFromSession,
} from '@cortex/agent-tools';
import { NotFoundError, ValidationError } from '@cortex/core';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

/**
 * GUARDAR LA APARIENCIA Y EL INICIO DE UNA APP (0215), desde la pestaña
 * «Apariencia» y «Inicio» del editor. Sólo quien administra la empresa,
 * comprobado en cada llamada.
 *
 * Las imágenes llegan reducidas por el navegador (PNG/JPG/WebP; un SVG se
 * dibuja en un canvas allá y llega como PNG: nunca se guarda un SVG) y aquí se
 * vuelven a comprobar por sus bytes. Los colores se aceptan si son un color y
 * pasan AA ya con el ajuste automático (`colorReport`).
 */

export type AppearanceResult =
  | { ok: true; files: NonNullable<AppBrand['files']> }
  | { ok: false; error: string };

const fields = z.object({
  primary: z.string().trim().max(9).optional(),
  accent: z.string().trim().max(9).optional(),
  shortName: z.string().trim().max(12).optional(),
  font: z.enum(APP_FONTS).optional(),
  welcome: appWelcomeSchema.optional(),
});

function describe(err: unknown, fallback: string): string {
  if (err instanceof ValidationError || err instanceof NotFoundError) return err.message;
  const message = err instanceof Error ? err.message : '';
  return message && message.length < 240 && !/[{}]|relation|column|violates/.test(message)
    ? message
    : fallback;
}

export async function saveAppearanceAction(
  appId: string,
  form: FormData,
): Promise<AppearanceResult> {
  try {
    const user = await requireSession();
    if (!viewerFromSession(user).companyAdmin)
      return { ok: false, error: 'Sólo quien administra la empresa puede cambiar la apariencia.' };
    const raw = form.get('fields');
    const input = fields.parse(typeof raw === 'string' ? JSON.parse(raw) : {});
    const db = getOrgScopedClient(user.organization.id);
    const app = await mustGetApp(db, appId);
    const ref = { id: app.id, organization_id: user.organization.id };

    const next: AppBrand = { ...app.brand };
    for (const key of ['primary', 'accent'] as const) {
      const value = input[key];
      if (value === undefined) continue;
      if (!value) {
        next[key] = undefined;
        continue;
      }
      const report = colorReport(value);
      if (!report.valid || !report.hex)
        return {
          ok: false,
          error: `${key === 'primary' ? 'Color principal' : 'Acento'}: usa un color como #1F6FEB.`,
        };
      if (!report.passes)
        return {
          ok: false,
          error:
            'Ese color no se puede leer ni ajustándolo. Prueba con uno más oscuro o más saturado.',
        };
      next[key] = report.hex;
    }
    if (input.shortName !== undefined) {
      if (input.shortName) next.shortName = input.shortName;
      else next.shortName = undefined;
    }
    if (input.font !== undefined) next.font = input.font;
    if (input.welcome !== undefined) {
      if (input.welcome.title || input.welcome.text) next.welcome = input.welcome;
      else next.welcome = undefined;
    }

    // Imágenes: subir las nuevas, desligarlas de la fila, y sólo entonces borrar las viejas.
    const stale: Array<[AppImageKind, AppImageRef]> = [];
    const files = { ...(app.brand.files ?? {}) };
    for (const kind of IMAGE_KINDS) {
      const upload = form.get(kind);
      if (upload instanceof File && upload.size > 0) {
        const put = await putAppImage(db, ref, kind, new Uint8Array(await upload.arrayBuffer()));
        if (!put.ok) return put;
        if (files[kind]) stale.push([kind, files[kind]]);
        files[kind] = put.ref;
      } else if (form.get(`remove_${kind}`) === '1' && files[kind]) {
        stale.push([kind, files[kind]]);
        files[kind] = undefined;
      }
    }
    const kept = Object.fromEntries(Object.entries(files).filter(([, v]) => v)) as typeof files;
    next.files = Object.keys(kept).length ? kept : undefined;

    await updateApp(db, app.id, { brand: next, userId: user.id });
    for (const [kind, old] of stale) await dropAppImage(db, ref, kind, old);
    revalidatePath(`/apps/${app.id}`, 'layout');
    revalidatePath(`/a/${app.id}`, 'layout');
    return { ok: true, files: kept };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo guardar la apariencia.') };
  }
}

export async function saveHomeAction(
  appId: string,
  raw: z.input<typeof appHomeSchema>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const user = await requireSession();
    if (!viewerFromSession(user).companyAdmin)
      return { ok: false, error: 'Sólo quien administra la empresa puede cambiar el inicio.' };
    const home = appHomeSchema.parse(raw);
    const db = getOrgScopedClient(user.organization.id);
    const app = await mustGetApp(db, appId);
    const slugs = new Set((await listScreens(db, app.id)).map((s) => s.slug));
    for (const card of home.cards)
      if ('screen' in card && card.screen && !slugs.has(card.screen))
        return {
          ok: false,
          error: `La tarjeta «${card.id}» apunta a una pantalla que ya no existe.`,
        };
    await updateApp(db, app.id, { home, userId: user.id });
    revalidatePath(`/apps/${app.id}`, 'layout');
    revalidatePath(`/a/${app.id}`, 'layout');
    return { ok: true };
  } catch (err) {
    if (err instanceof z.ZodError)
      return { ok: false, error: err.issues[0]?.message ?? 'El inicio tiene un dato que no vale.' };
    return { ok: false, error: describe(err, 'No se pudo guardar el inicio.') };
  }
}
