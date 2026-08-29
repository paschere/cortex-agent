import { graphFetch } from '../msgraph/client';
import type { ToolContext } from '../types';

/**
 * Los adjuntos de un mensaje de Outlook.
 *
 * DOS LLAMADAS Y NO UNA, a diferencia de Gmail, y es culpa del modelo de Graph:
 * un mensaje no trae el árbol MIME, así que enumerar los adjuntos es una
 * petición aparte. Se pide sólo `$select` de lo que hace falta para decidir —
 * nombre, tipo, tamaño, si va incrustado — porque el campo `contentBytes` viene
 * dentro de la misma respuesta si no se acota, y eso convertiría «enumerar» en
 * «descargarlo todo», que es exactamente lo que el filtro existe para evitar.
 *
 * Y por eso quien llama enumera sólo los mensajes con `hasAttachments`: sin ese
 * filtro serían tantas llamadas como mensajes tenga el hilo, casi todas para
 * recibir una lista vacía.
 */
export type GraphAttachment = {
  id?: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
  '@odata.type'?: string;
};

export type OutlookAttachmentRef = {
  key: string | null;
  filename: string;
  mime: string;
  sizeBytes: number;
};

export async function listOutlookAttachments(
  ctx: Pick<ToolContext, 'integrations' | 'signal'>,
  messageId: string,
): Promise<OutlookAttachmentRef[]> {
  const res = await graphFetch<{ value?: GraphAttachment[] }>(
    ctx,
    `/me/messages/${encodeURIComponent(messageId)}/attachments?$select=id,name,contentType,size,isInline`,
  );
  return (
    (res?.value ?? [])
      // Un `itemAttachment` es otro correo o una cita pegada dentro, y un
      // `referenceAttachment` es un enlace a OneDrive sin bytes detrás. Ninguno de
      // los dos es un archivo que se pueda abrir aquí, y tratarlos como si lo
      // fueran produce una descarga que falla todos los días.
      .filter((a) => (a['@odata.type'] ?? '').includes('fileAttachment'))
      // Incrustado quiere decir que va dentro del cuerpo: la firma, el logo, la
      // imagen pegada en mitad del texto. Nunca es el contrato.
      .filter((a) => a.isInline !== true)
      .map((a) => ({
        key: a.id ?? null,
        filename: (a.name ?? '').trim(),
        mime: a.contentType ?? '',
        sizeBytes: a.size ?? 0,
      }))
  );
}

/**
 * Los bytes.
 *
 * `/$value` devuelve el archivo crudo en vez del recurso JSON con su
 * `contentBytes` en base64 — un tercio menos de tráfico y ninguna decodificación
 * de por medio. `graphFetch` parsea JSON, así que esta llamada va por `fetch`
 * directo con el mismo token.
 */
export async function fetchOutlookAttachment(
  ctx: Pick<ToolContext, 'integrations' | 'signal'>,
  messageId: string,
  attachmentId: string,
): Promise<Buffer> {
  const { token } = await ctx.integrations.getAccessToken('microsoft');
  const r = await fetch(
    `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/$value`,
    { headers: { Authorization: `Bearer ${token}` }, signal: ctx.signal },
  );
  if (!r.ok) {
    throw new Error(`Graph ${r.status} al bajar el adjunto: ${await r.text().catch(() => '')}`);
  }
  return Buffer.from(await r.arrayBuffer());
}
