import 'server-only';
import { createHash } from 'node:crypto';
import { LOGO_BUCKET, MAX_LOGO_BYTES, sniffLogo } from '@/lib/branding/shape';
import {
  type AppBrand,
  type AppImageKind,
  type AppImageRef,
  type CustomAppRow,
  getFile,
  putFile,
  removeFiles,
} from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * LAS IMÁGENES PROPIAS DE UNA APP (logo, ícono cuadrado, bienvenida; 0215).
 *
 * Mismo bucket y mismas reglas que el logo de la empresa (lib/branding/store.ts):
 * el navegador las redujo a PNG/JPG/WebP, y aquí se exige otra vez que los
 * primeros bytes lo digan. La ruta sale SIEMPRE de la fila de la app
 * (huella + tipo guardados en `brand.files`), nunca de lo que mande quien pide.
 */

/** Cuánto pesa, como mucho, la imagen de bienvenida (una foto reducida). */
export const MAX_WELCOME_BYTES = 900_000;

/** La app con la empresa dueña: la ruta del archivo las lleva a las dos. */
export interface AppRef {
  id: string;
  organization_id: string;
}

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const;
const MIME: Record<AppImageRef['t'], string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
};

function pathOf(app: AppRef, kind: AppImageKind, ref: AppImageRef) {
  return `${app.organization_id}/apps/${app.id}/${kind}-${ref.v}.${ref.t}`;
}

/** Sube la imagen y devuelve su referencia (huella + tipo). No toca la fila. */
export async function putAppImage(
  db: SupabaseClient,
  app: AppRef,
  kind: AppImageKind,
  bytes: Uint8Array,
): Promise<{ ok: true; ref: AppImageRef } | { ok: false; error: string }> {
  const max = kind === 'welcome' ? MAX_WELCOME_BYTES : MAX_LOGO_BYTES;
  if (bytes.byteLength > max)
    return { ok: false, error: 'La imagen pesa demasiado. Usa una de menos de 600 KB.' };
  const type = sniffLogo(bytes);
  if (!type) return { ok: false, error: 'La imagen tiene que ser PNG, JPG o WebP.' };
  const ref: AppImageRef = {
    v: createHash('sha256').update(bytes).digest('hex').slice(0, 16),
    t: EXT[type],
  };
  await putFile(db, {
    bucket: LOGO_BUCKET,
    path: pathOf(app, kind, ref),
    content: bytes,
    contentType: type,
  });
  return { ok: true, ref };
}

/** Borra un archivo ya desligado de la fila; si falla queda un huérfano, no una imagen rota. */
export async function dropAppImage(
  db: SupabaseClient,
  app: AppRef,
  kind: AppImageKind,
  ref: AppImageRef | undefined,
): Promise<void> {
  if (!ref) return;
  await removeFiles(db, LOGO_BUCKET, [pathOf(app, kind, ref)]).catch(() => undefined);
}

/** Los bytes de una imagen de ESTA app, o null si no tiene esa. */
export async function readAppImage(
  db: SupabaseClient,
  app: AppRef & Pick<CustomAppRow, 'brand'>,
  kind: AppImageKind,
): Promise<{ content: Uint8Array; contentType: string; version: string } | null> {
  const ref = (app.brand as AppBrand).files?.[kind];
  if (!ref) return null;
  const file = await getFile(db, LOGO_BUCKET, pathOf(app, kind, ref)).catch((e: unknown) => {
    console.warn('[app-assets] no se pudo leer la imagen:', e instanceof Error ? e.message : e);
    return null;
  });
  if (!file) return null;
  return { content: file.content, contentType: file.contentType ?? MIME[ref.t], version: ref.v };
}

/** La URL con la que se pide una imagen, por la ruta pública (entrada) o la de sesión. */
export function appAssetUrl(appId: string, scope: 'public' | 'member') {
  return (kind: AppImageKind, v: string): string =>
    `/api/apps/${scope === 'public' ? 'public/' : ''}${encodeURIComponent(appId)}/asset/${kind}?v=${v}`;
}
