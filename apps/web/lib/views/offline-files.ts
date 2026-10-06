/**
 * FOTOS QUE NO SE PUDIERON SUBIR. Sin señal, la foto no sube: el Blob se guarda
 * en el teléfono (IndexedDB) y el campo `file` queda con una URL provisional
 * `pending:<id>`. Al reintentar el envío, ANTES de mandar el registro se suben
 * las fotos pendientes y se cambia cada URL provisional por la real.
 *
 * La parte pura (`pendingIds`, `swapPending`) no toca el navegador y se prueba
 * sola; `stashBlob` y `resolvePending` usan el almacén.
 */

import { type UploadedFile, parseFileValue, serializeFileValue } from './upload-rules';

export const PENDING_PREFIX = 'pending:';

export function isPendingUrl(url: string): boolean {
  return url.startsWith(PENDING_PREFIX);
}

/** Los ids de las fotos pendientes que un valor `file` menciona. */
export function pendingIds(value: string | null | undefined): string[] {
  return parseFileValue(value)
    .filter((f) => isPendingUrl(f.url))
    .map((f) => f.url.slice(PENDING_PREFIX.length));
}

/** Cambia las URL provisionales por las reales (`done`: id → archivo ya subido). */
export function swapPending(value: string, done: Record<string, UploadedFile>): string {
  const files = parseFileValue(value);
  const swapped = files.map((f) => {
    if (!isPendingUrl(f.url)) return f;
    return done[f.url.slice(PENDING_PREFIX.length)] ?? f;
  });
  return serializeFileValue(swapped, value.trim().startsWith('['));
}

/** ¿Alguno de estos valores trae una foto sin subir? */
export function hasPending(values: Record<string, string>): boolean {
  return Object.values(values).some((v) => pendingIds(v).length > 0);
}

/** Para validar en el navegador: la URL provisional se cambia por una que pasa el esquema. */
export function forValidation(value: string): string {
  if (!pendingIds(value).length) return value;
  const files = parseFileValue(value).map((f) =>
    isPendingUrl(f.url) ? { ...f, url: '/api/files/blob/pending' } : f,
  );
  return serializeFileValue(files, value.trim().startsWith('['));
}

// Los Blob en memoria para dibujar la miniatura mientras tanto.
const previews = new Map<string, string>();

export function previewUrl(url: string): string | null {
  return isPendingUrl(url) ? (previews.get(url.slice(PENDING_PREFIX.length)) ?? null) : null;
}

/** Guarda la foto en el teléfono y devuelve el archivo provisional que va en el campo. */
export async function stashBlob(file: File): Promise<UploadedFile> {
  const { putBlob } = await import('./offline-store');
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  await putBlob(id, file);
  try {
    previews.set(id, URL.createObjectURL(file));
  } catch {}
  return { url: `${PENDING_PREFIX}${id}`, name: file.name, mime: file.type, size: file.size };
}

/**
 * Sube las fotos pendientes de `values` (con `uploader`) y devuelve los valores
 * con las URL reales. Lanza si alguna no se puede subir: el envío se reintenta
 * después con la cola igual que estaba.
 */
export async function resolvePending(
  values: Record<string, string>,
  uploader: (file: File, field: string) => Promise<UploadedFile>,
): Promise<Record<string, string>> {
  const { getBlob, removeBlob } = await import('./offline-store');
  const out: Record<string, string> = { ...values };
  const uploaded: string[] = [];
  for (const [field, value] of Object.entries(values)) {
    const ids = pendingIds(value);
    if (!ids.length) continue;
    const done: Record<string, UploadedFile> = {};
    for (const id of ids) {
      const blob = await getBlob(id);
      if (!blob) throw new Error('Una foto guardada ya no está en el teléfono.');
      const meta = parseFileValue(value).find((f) => f.url === `${PENDING_PREFIX}${id}`);
      const file = new File([blob], meta?.name || 'foto.jpg', { type: meta?.mime || blob.type });
      done[id] = await uploader(file, field);
      uploaded.push(id);
    }
    out[field] = swapPending(value, done);
  }
  for (const id of uploaded) await removeBlob(id);
  return out;
}
