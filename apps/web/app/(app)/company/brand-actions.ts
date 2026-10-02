'use server';

import { MAX_LOGO_BYTES, parseBrandInput, sniffLogo } from '@/lib/branding/shape';
import { removeLogo, saveBrandingFields, saveLogo } from '@/lib/branding/store';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { revalidatePath } from 'next/cache';

/**
 * GUARDAR LA MARCA (migración 0170): nombre para mostrar, colores y logo.
 *
 * Sólo administradores, comprobado aquí en cada llamada: esconder el botón no
 * esconde la acción. El logo llega ya reducido por el navegador (PNG de 512 px
 * como mucho), pero aquí se vuelve a exigir todo: tamaño, y que los primeros
 * bytes digan PNG, JPEG o WebP — no lo que diga el nombre del archivo ni el
 * navegador. Un SVG no entra (ver `sniffLogo`).
 *
 * Una sola exportación a propósito: cada función exportada de un archivo
 * 'use server' es un endpoint.
 */

export type BrandSaveResult =
  | { ok: true; logoVersion: string | null }
  | { ok: false; error: string };

export async function saveBrandAction(form: FormData): Promise<BrandSaveResult> {
  const user = await requireSession();
  if (user.role !== 'org_admin')
    return { ok: false, error: 'Sólo un administrador puede cambiar la marca de la empresa.' };

  const parsed = parseBrandInput({
    displayName: form.get('displayName'),
    primary: form.get('primary'),
    secondary: form.get('secondary'),
  });
  if (!parsed.ok) return parsed;

  const logo = form.get('logo');
  let bytes: Uint8Array | null = null;
  if (logo instanceof File && logo.size > 0) {
    if (logo.size > MAX_LOGO_BYTES)
      return { ok: false, error: 'El logo pesa demasiado. Usa una imagen de menos de 600 KB.' };
    bytes = new Uint8Array(await logo.arrayBuffer());
  }
  const type = bytes ? sniffLogo(bytes) : null;
  if (bytes && !type) return { ok: false, error: 'El logo tiene que ser PNG, JPG o WebP.' };

  const db = getOrgScopedClient(user.organization.id);
  try {
    await saveBrandingFields(
      db,
      {
        display_name: parsed.value.displayName,
        primary_color: parsed.value.primary,
        secondary_color: parsed.value.secondary,
      },
      user.id,
    );
    let logoVersion: string | null = null;
    if (bytes && type) logoVersion = await saveLogo(db, user.organization.id, bytes, type, user.id);
    else if (form.get('removeLogo') === '1') await removeLogo(db, user.id);
    revalidatePath('/company');
    revalidatePath('/views', 'layout');
    return { ok: true, logoVersion };
  } catch (err) {
    console.error('[branding] no se pudo guardar:', err);
    return { ok: false, error: 'No se pudo guardar la marca. Inténtalo otra vez en un momento.' };
  }
}
