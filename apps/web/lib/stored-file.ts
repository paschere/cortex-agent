import 'server-only';
import { verifyBlobToken } from '@/lib/blob-token';
import { getFileDirect } from '@/lib/files-db';
import { VIEW_FILES_BUCKET } from '@/lib/views/upload-rules';

/**
 * Los bytes de un archivo subido a un campo `file` (lib/views/upload.ts), a
 * partir del valor guardado en la fila: `/api/files/blob/<token>`.
 *
 * Tres candados: la firma del token tiene que verificar (la emitió este
 * servidor), el cubo tiene que ser el de los archivos de formularios y la ruta
 * tiene que empezar por el id de LA EMPRESA que pregunta. Un valor pegado de
 * otra empresa (o de otro cubo, como una grabación de reunión) no se lee.
 */
export async function readStoredFileByUrl(
  organizationId: string,
  url: string,
): Promise<{ bytes: Buffer; mime: string | null } | null> {
  const m = /\/api\/files\/blob\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)(?:[?#].*)?$/.exec(url);
  if (!m) return null;
  const payload = verifyBlobToken(m[1] as string);
  if (!payload) return null;
  if (payload.bucket !== VIEW_FILES_BUCKET) return null;
  if (!payload.path.startsWith(`${organizationId}/`)) return null;
  const file = await getFileDirect(payload.bucket, payload.path);
  return file ? { bytes: file.content, mime: file.contentType } : null;
}
