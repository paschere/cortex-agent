import 'server-only';
import { createHash } from 'node:crypto';
import { getFile, putFile, removeFiles } from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';
import { LOGO_BUCKET, type LogoType, type ViewBrand } from './shape';

/**
 * LA MARCA EN LA BASE (migración 0170): `company_branding` y el logo en
 * `app_files`.
 *
 * Todo pasa por el handle con alcance de la empresa: la fila lleva su
 * organization_id sin que nadie se acuerde, y el logo se lee por la ruta que
 * la MISMA fila guarda — nunca por una ruta que venga de afuera. Así, el logo
 * de una vista pública es el de la empresa dueña de esa vista y de ninguna
 * otra (ver /api/views/public/logo).
 *
 * Las lecturas miran `error`. La marca es adorno: si la tabla no contesta (la
 * migración aún no se aplicó, la base parpadeó), la vista se pinta con los
 * colores de Cortex y el error queda en el registro, no en la cara de un
 * cliente.
 */

export interface BrandingRow {
  display_name: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  logo_path: string | null;
  logo_version: string | null;
  updated_at: string;
}

const COLUMNS = 'display_name,primary_color,secondary_color,logo_path,logo_version,updated_at';

export async function readBranding(db: SupabaseClient): Promise<BrandingRow | null> {
  const { data, error } = await db.from('company_branding').select(COLUMNS).maybeSingle();
  if (error) {
    console.warn('[branding] no se pudo leer la marca:', error.message);
    return null;
  }
  return (data as BrandingRow | null) ?? null;
}

/**
 * La marca lista para el navegador. `logoUrl` la decide quien llama, porque
 * adentro y afuera el logo se pide por rutas distintas (sesión o token).
 */
export function toViewBrand(
  row: BrandingRow | null,
  fallbackName: string,
  logoUrl: (version: string) => string,
): ViewBrand {
  return {
    name: row?.display_name?.trim() || fallbackName,
    logoUrl: row?.logo_path && row.logo_version ? logoUrl(row.logo_version) : null,
    primary: row?.primary_color ?? null,
    secondary: row?.secondary_color ?? null,
  };
}

/** La marca de la empresa de la sesión, con el logo por la ruta con sesión. */
export async function loadSessionBrand(db: SupabaseClient, orgName: string): Promise<ViewBrand> {
  return toViewBrand(await readBranding(db), orgName, (v) => `/api/branding/logo?v=${v}`);
}

/** La marca de la empresa dueña de una vista compartida, con el logo por el token. */
export async function loadPublicBrand(
  db: SupabaseClient,
  orgName: string,
  token: string,
): Promise<ViewBrand> {
  return toViewBrand(
    await readBranding(db),
    orgName,
    (v) => `/api/views/public/logo?token=${encodeURIComponent(token)}&v=${v}`,
  );
}

export async function saveBrandingFields(
  db: SupabaseClient,
  patch: {
    display_name: string | null;
    primary_color: string | null;
    secondary_color: string | null;
  },
  userId: string,
): Promise<void> {
  const { error } = await db
    .from('company_branding')
    .upsert(
      { ...patch, updated_by: userId, updated_at: new Date().toISOString() },
      { onConflict: 'organization_id' },
    );
  if (error) throw new Error(`No se pudo guardar la marca: ${error.message}`);
}

/**
 * Guarda el logo y apunta la fila a él. La ruta lleva la huella del contenido:
 * subir otro logo deja una ruta nueva, y la vieja se borra después de mover
 * la fila (si el borrado falla, queda un archivo huérfano, no un logo roto).
 */
export async function saveLogo(
  db: SupabaseClient,
  organizationId: string,
  bytes: Uint8Array,
  type: LogoType,
  userId: string,
): Promise<string> {
  const version = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
  const path = `${organizationId}/logo-${version}.${ext}`;
  const before = await readBranding(db);
  await putFile(db, { bucket: LOGO_BUCKET, path, content: bytes, contentType: type });
  const { error } = await db.from('company_branding').upsert(
    {
      logo_path: path,
      logo_version: version,
      updated_by: userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'organization_id' },
  );
  if (error) throw new Error(`No se pudo guardar el logo: ${error.message}`);
  if (before?.logo_path && before.logo_path !== path)
    await removeFiles(db, LOGO_BUCKET, [before.logo_path]).catch(() => undefined);
  return version;
}

export async function removeLogo(db: SupabaseClient, userId: string): Promise<void> {
  const before = await readBranding(db);
  if (!before?.logo_path) return;
  const { error } = await db.from('company_branding').update({
    logo_path: null,
    logo_version: null,
    updated_by: userId,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(`No se pudo quitar el logo: ${error.message}`);
  await removeFiles(db, LOGO_BUCKET, [before.logo_path]).catch(() => undefined);
}

/** Los bytes del logo de ESTA empresa (la ruta sale de su fila), o null. */
export async function readLogo(
  db: SupabaseClient,
): Promise<{ content: Uint8Array; contentType: string; version: string } | null> {
  const row = await readBranding(db);
  if (!row?.logo_path || !row.logo_version) return null;
  const file = await getFile(db, LOGO_BUCKET, row.logo_path).catch((e: unknown) => {
    console.warn('[branding] no se pudo leer el logo:', e instanceof Error ? e.message : e);
    return null;
  });
  if (!file) return null;
  return {
    content: file.content,
    contentType: file.contentType ?? 'image/png',
    version: row.logo_version,
  };
}

/** La respuesta HTTP del logo: misma forma adentro y afuera. */
export function logoResponse(
  logo: { content: Uint8Array; contentType: string; version: string } | null,
  requestedVersion: string | null,
): Response {
  if (!logo)
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  // Con la huella correcta en la URL, el contenido no cambia nunca: caché larga.
  const immutable = requestedVersion === logo.version;
  return new Response(new Uint8Array(logo.content), {
    status: 200,
    headers: {
      'Content-Type': logo.contentType,
      'Content-Length': String(logo.content.byteLength),
      'Cache-Control': immutable ? 'private, max-age=31536000, immutable' : 'private, no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}
