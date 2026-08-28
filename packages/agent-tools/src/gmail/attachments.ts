import { type GmailFetchContext, gmailFetch } from './client';

/**
 * Los bytes de un adjunto de Gmail.
 *
 * Es una llamada aparte por diseño de Gmail y conviene que lo sea también aquí:
 * enumerar los adjuntos de un hilo es gratis y descargarlos no, así que el
 * filtro de `mail/attachments.ts` corre entero antes de que esto se llame ni
 * una vez.
 *
 * El cuerpo viene en base64url, que NO es base64: cambia dos caracteres del
 * alfabeto. Decodificarlo como base64 a secas no falla — produce bytes
 * ligeramente distintos — y el síntoma sería un PDF que casi abre.
 */
export async function fetchGmailAttachment(
  ctx: GmailFetchContext,
  messageId: string,
  attachmentId: string,
): Promise<Buffer> {
  const res = await gmailFetch<{ data?: string; size?: number }>(
    ctx,
    `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
  );
  if (!res.data) throw new Error('Gmail devolvió el adjunto sin contenido');
  return Buffer.from(res.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
