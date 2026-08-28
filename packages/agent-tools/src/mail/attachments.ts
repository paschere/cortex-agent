import { createHash } from 'node:crypto';
import type { Logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { putFile, removeFiles } from '../files';
import { chunkText } from '../kb/chunker';
import { embedDocuments } from '../kb/embedder';
import { recordEmbeddingUsage } from '../kb/embedding-usage';
import { parseDocument } from '../kb/parsers';

/**
 * LO QUE VENÍA ADJUNTO.
 *
 * ===========================================================================
 * EL HUECO QUE CIERRA
 * ===========================================================================
 * Cortex archivaba el hilo y no el archivo. Quedaba guardada la frase «te
 * adjunto el contrato firmado» y no el contrato, así que «¿qué plazo de pago
 * acordamos con Acme?» devolvía la correspondencia SOBRE el plazo en lugar del
 * plazo. En una empresa el documento que decide algo casi nunca está en el
 * cuerpo del correo: está colgando de él.
 *
 * ===========================================================================
 * UNO SOLO PARA GMAIL Y PARA OUTLOOK
 * ===========================================================================
 * Este módulo vive en `mail/` y no en `gmail/` por la misma razón que
 * `mail/audience.ts`: la regla de qué adjunto merece entrar al cerebro no tiene
 * nada que ver con quién sirve el buzón, y escrita dos veces se convierte en
 * dos reglas distintas en cuanto alguien arregle una sola. Los proveedores
 * aportan lo único que sí es suyo: cómo se enumeran los adjuntos de un mensaje
 * y cómo se piden sus bytes. Eso entra por `attachments` y por `fetchBytes`.
 *
 * ===========================================================================
 * LOS BYTES SE GUARDAN, NO SÓLO EL TEXTO
 * ===========================================================================
 * El archivo original va a `kb-uploads` y `source_ref` apunta ahí, que es
 * exactamente lo que hace la subida a mano. Cuesta almacenamiento y lo vale: un
 * documento del que no se conserva el original no se puede volver a abrir, ni
 * descargar, ni re-extraer el día que haya un parser mejor — y la gente no
 * descubre esa diferencia hasta que la necesita. Ver el bloque «EL ARCHIVO, NO
 * LA TRANSCRIPCIÓN» en attachments/promote.ts, que llegó a la misma conclusión
 * por el otro camino.
 *
 * ===========================================================================
 * SE ANOTA TAMBIÉN LO QUE NO SE GUARDA
 * ===========================================================================
 * Un adjunto descartado deja fila igual, con el motivo. Sin eso el barrido de
 * cada mañana se volvería a descargar el mismo vídeo de 30 MB para volver a
 * tirarlo, todos los días. Y cuando alguien pregunte por qué no está la
 * propuesta que le mandaron, la respuesta está escrita en vez de haber que
 * reproducir el barrido para averiguarla.
 */

export interface MailAttachmentRef {
  /**
   * El id que el proveedor le da al adjunto. Null cuando no hay ninguno; en ese
   * caso la identidad la pone el sha del contenido, que es peor identificador
   * (el mismo archivo adjuntado dos veces al mismo mensaje colapsa en uno) pero
   * nunca falta.
   */
  key: string | null;
  filename: string;
  /** Lo que dice el proveedor. A menudo miente; ver `resolveMime`. */
  mime: string;
  sizeBytes: number;
  /** El mensaje del hilo al que venía pegado. */
  messageId: string;
  /** Cuándo llegó ese mensaje, en ms. Es la fecha que lleva el documento. */
  ms: number;
}

export interface AttachmentIngestContext {
  organizationId: string;
  userId: string;
  db: SupabaseClient;
  logger: Logger;
}

export interface AttachmentIngestInput {
  provider: 'gmail' | 'outlook';
  threadId: string;
  spaceId: string;
  /** El documento del hilo. Es de donde cuelga cada adjunto (`parent_document_id`). */
  parentDocumentId: string | null;
  /** El asunto, que es lo que hace reconocible el título del adjunto. */
  subject: string;
  attachments: MailAttachmentRef[];
  /** Trae los bytes. Sólo se llama para lo que ya pasó el filtro. */
  fetchBytes: (ref: MailAttachmentRef) => Promise<Buffer>;
}

export interface AttachmentIngestResult {
  archived: number;
  /** Vistos y descartados a propósito: no sabemos abrirlos, o no valen la pena. */
  skipped: number;
  failed: number;
  /** Los documentos creados, para que quien llama pueda nombrarlos. */
  documents: Array<{ documentId: string; filename: string }>;
}

/** El bucket del que vive Brain Knowledge, igual que en la subida a mano. */
const KB_BUCKET = 'kb-uploads';

/**
 * El techo. Veinticinco megas cubre cualquier contrato, propuesta o pliego
 * real; por encima es casi siempre un vídeo, un instalador o un volcado, y
 * ninguno de los tres se lee. El coste de equivocarse por arriba es descargar
 * cien megas cada mañana para tirarlos.
 */
const MAX_BYTES = 25 * 1024 * 1024;

/**
 * El suelo. Por debajo de esto no hay un documento: hay el logo de una firma,
 * un píxel de seguimiento o un `.txt` con una línea. El filtro de tipo ya se
 * lleva la mayoría, pero no todos vienen declarados como imagen.
 */
const MIN_BYTES = 512;

/** Lo que `kb/parsers.ts` sabe abrir de verdad. Si crece allí, crece aquí. */
const READABLE: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
};

/** Y la misma lista por extensión, que es lo que queda cuando el tipo miente. */
const BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
};

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
}

/**
 * Qué es esto de verdad.
 *
 * Gmail y Graph declaran `application/octet-stream` con una frecuencia
 * incómoda — depende del cliente que lo mandó, no del archivo — así que un
 * filtro que se fiara sólo del tipo declarado tiraría contratos. Cuando el tipo
 * no dice nada útil, manda la extensión; cuando dice algo que sabemos abrir,
 * manda él.
 */
export function resolveMime(ref: { filename: string; mime: string }): string {
  const declared = (ref.mime || '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (READABLE[declared]) return declared;
  const byExt = BY_EXTENSION[extensionOf(ref.filename)];
  return byExt ?? declared;
}

/**
 * Nombres que delatan que esto no es un adjunto sino parte del sobre: la firma
 * criptográfica, la tarjeta de contacto, la invitación de calendario y las
 * imágenes incrustadas que los clientes de correo numeran solas.
 */
const ENVELOPE = /^(smime\.p7[sm]|winmail\.dat|ATT\d+|image0*\d+\.(png|jpe?g|gif)|.*\.(ics|vcf))$/i;

export type KeepVerdict = { keep: true; mime: string } | { keep: false; reason: string };

/**
 * ¿Merece este adjunto ser un documento del cerebro?
 *
 * Se decide ANTES de descargar nada, con lo que el proveedor ya nos dijo — que
 * es todo el punto: el filtro existe para no bajarse el archivo, no para
 * bajárselo y arrepentirse.
 */
export function worthKeeping(ref: MailAttachmentRef): KeepVerdict {
  const name = (ref.filename || '').trim();
  if (!name) return { keep: false, reason: 'venía sin nombre' };
  if (ENVELOPE.test(name)) {
    return { keep: false, reason: 'es parte del sobre del correo, no un documento' };
  }
  if (ref.sizeBytes > MAX_BYTES) {
    return {
      keep: false,
      reason: `pesa ${Math.round(ref.sizeBytes / 1024 / 1024)} MB, más de los 25 MB que se archivan`,
    };
  }
  if (ref.sizeBytes > 0 && ref.sizeBytes < MIN_BYTES) {
    return { keep: false, reason: 'es demasiado pequeño para ser un documento' };
  }

  const mime = resolveMime(ref);
  if (!READABLE[mime]) {
    return {
      keep: false,
      reason: `todavía no se sabe leer un ${extensionOf(name) || mime || 'archivo así'}`,
    };
  }
  return { keep: true, mime };
}

/** Mismo saneado que la ruta de subida: la ruta es una clave, no un nombre. */
function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
}

interface LedgerRow {
  id: string;
  status: string;
  document_id: string | null;
  sha256: string;
}

/**
 * Archivar los adjuntos de un hilo.
 *
 * Nunca lanza: un adjunto que falla es un adjunto que falla, no un hilo que se
 * pierde. Quien llama ya archivó la correspondencia antes de llegar aquí, y
 * tumbar eso porque un PDF venía corrupto sería cambiar una pérdida pequeña por
 * una grande.
 */
export async function ingestAttachments(
  ctx: AttachmentIngestContext,
  input: AttachmentIngestInput,
): Promise<AttachmentIngestResult> {
  const result: AttachmentIngestResult = {
    archived: 0,
    skipped: 0,
    failed: 0,
    documents: [],
  };
  if (input.attachments.length === 0) return result;

  for (const ref of input.attachments) {
    try {
      const one = await ingestOne(ctx, input, ref);
      if (one === 'skipped') {
        result.skipped += 1;
      } else {
        result.archived += 1;
        result.documents.push(one);
      }
    } catch (err) {
      result.failed += 1;
      ctx.logger.warn(
        { err, filename: ref.filename, thread: input.threadId },
        'un adjunto de correo no se pudo archivar',
      );
      await record(ctx, input, ref, {
        sha256: '',
        status: 'failed',
        reason: (err as Error).message.slice(0, 300),
        documentId: null,
      });
    }
  }

  return result;
}

async function ingestOne(
  ctx: AttachmentIngestContext,
  input: AttachmentIngestInput,
  ref: MailAttachmentRef,
): Promise<'skipped' | { documentId: string; filename: string }> {
  const db = ctx.db;

  // 1. ¿Ya lo vimos? El libro contesta por lo archivado Y por lo descartado, que
  //    es lo que hace que la segunda mañana cueste una consulta y no una
  //    descarga.
  const key = ref.key ?? `sha:${ref.filename}:${ref.sizeBytes}`;
  const { data: seen } = await db
    .from('mail_attachment_ingests')
    .select('id, status, document_id, sha256')
    .eq('user_id', ctx.userId)
    .eq('provider', input.provider)
    .eq('thread_id', input.threadId)
    .eq('message_id', ref.messageId)
    .eq('attachment_key', key)
    .maybeSingle();
  const ledger = (seen ?? null) as LedgerRow | null;
  if (ledger && ledger.status !== 'failed') return 'skipped';

  // 2. El filtro, antes de bajar un solo byte.
  const verdict = worthKeeping(ref);
  if (!verdict.keep) {
    await record(ctx, input, ref, {
      sha256: '',
      status: 'skipped',
      reason: verdict.reason,
      documentId: null,
      ledgerId: ledger?.id ?? null,
    });
    return 'skipped';
  }

  const bytes = await input.fetchBytes(ref);
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  // 3. ¿Este contenido ya está en este espacio? El mismo PDF reenviado tres
  //    veces es un documento, no tres — y tres copias compitiendo entre sí en la
  //    recuperación es peor que ninguna.
  const { data: twin } = await db
    .from('kb_documents')
    .select('id, title')
    .eq('collection_id', input.spaceId)
    .eq('sha256', sha256)
    .maybeSingle();
  if (twin) {
    await record(ctx, input, ref, {
      sha256,
      status: 'ready',
      reason: 'ya estaba en el espacio; se apunta al documento que ya existía',
      documentId: (twin as { id: string }).id,
      ledgerId: ledger?.id ?? null,
    });
    return 'skipped';
  }

  // 4. Abrirlo. Un archivo que el parser rechaza —un PDF escaneado sin capa de
  //    texto, uno cifrado— se anota como descartado con su motivo, no como
  //    fallo: no hay nada que reintentar mañana.
  let text: string;
  let pages: number | undefined;
  try {
    const parsed = await parseDocument(bytes, verdict.mime);
    text = parsed.text;
    pages = parsed.pages;
  } catch (err) {
    await record(ctx, input, ref, {
      sha256,
      status: 'skipped',
      reason: `no se pudo leer por dentro: ${(err as Error).message.slice(0, 160)}`,
      documentId: null,
      ledgerId: ledger?.id ?? null,
    });
    return 'skipped';
  }

  const chunks = chunkText(text);
  if (chunks.length === 0) {
    await record(ctx, input, ref, {
      sha256,
      status: 'skipped',
      // El caso más común de esto es un PDF que es sólo imágenes. Se dice así
      // para que alguien pueda decidir pasarlo por un OCR.
      reason: 'no tiene texto dentro (puede ser un escaneo sin OCR)',
      documentId: null,
      ledgerId: ledger?.id ?? null,
    });
    return 'skipped';
  }

  // 5. Los bytes primero: si el documento existiera sin su archivo detrás sería
  //    un documento de segunda desde el minuto uno, y nadie lo sabría.
  const storagePath = `${ctx.organizationId}/${input.spaceId}/${Date.now()}-${safeName(ref.filename)}`;
  await putFile(db, {
    bucket: KB_BUCKET,
    path: storagePath,
    content: bytes,
    contentType: verdict.mime,
  });

  let documentId: string | null = null;
  try {
    const { data: created, error } = await db
      .from('kb_documents')
      .insert({
        collection_id: input.spaceId,
        source: input.provider,
        // Apunta al archivo, como en la subida a mano: es lo que hace que este
        // documento se pueda abrir y descargar como cualquier otro. De qué
        // correo salió lo dice `parent_document_id`, y con qué id lo dice el
        // libro.
        source_ref: storagePath,
        parent_document_id: input.parentDocumentId,
        title: titleOf(ref.filename, input.subject),
        mime: verdict.mime,
        sha256,
        pages: pages ?? null,
        uploaded_by: ctx.userId,
        status: 'pending',
        error_message: null,
        // La fecha del documento es la del correo que lo trajo, no la de hoy.
        // Es la diferencia entre «una tarifa de hace un año» y «una tarifa
        // recién archivada», que es justo lo que la frescura mide.
        recorded_at: new Date(ref.ms).toISOString(),
        media_kind: 'text',
      })
      .select('id')
      .single();
    if (error || !created) throw new Error(error?.message ?? 'no se creó la fila del documento');
    documentId = (created as { id: string }).id;

    const embedded = await embedDocuments(chunks.map((c) => c.content));
    if (!embedded.ok && embedded.retryable) throw new Error(embedded.reason);

    const { error: chunkErr } = await db.from('kb_chunks').insert(
      chunks.map((c, i) => ({
        document_id: documentId,
        chunk_index: c.chunkIndex,
        content: c.content,
        tokens: c.tokens,
        // Mismo trato que en todas partes: sin llave de embeddings el documento
        // se conserva igual y se busca por palabra.
        embedding: embedded.ok ? embedded.data[i] : null,
        embedding_model: embedded.ok ? embedded.usage.modelId : null,
        metadata: pages ? { pages } : {},
      })),
    );
    if (chunkErr) throw new Error(chunkErr.message);

    if (embedded.ok) {
      await recordEmbeddingUsage(db, {
        organizationId: ctx.organizationId,
        documentId,
        source: input.provider,
        usage: embedded.usage,
      });
    }

    await db
      .from('kb_documents')
      .update(
        embedded.ok
          ? { status: 'ready', error_message: null }
          : { status: 'pending', error_message: embedded.reason },
      )
      .eq('id', documentId);

    await record(ctx, input, ref, {
      sha256,
      status: 'ready',
      reason: null,
      documentId,
      ledgerId: ledger?.id ?? null,
    });

    return { documentId, filename: ref.filename };
  } catch (err) {
    // El archivo subido sin fila que lo nombre es basura invisible que nadie va
    // a encontrar para borrarla. Se limpia aquí, y si la limpieza falla no se
    // convierte en el error que se cuenta.
    await removeFiles(db, KB_BUCKET, [storagePath]).catch(() => {});
    if (documentId) await db.from('kb_documents').delete().eq('id', documentId).then(undefined);
    throw err;
  }
}

/**
 * El título. Lleva el nombre del archivo delante porque es lo que la persona
 * recuerda, y el asunto detrás porque es lo que le da contexto cuando el nombre
 * es `documento final v3.pdf` — que es la mitad de las veces.
 */
function titleOf(filename: string, subject: string): string {
  const clean = subject.trim();
  return clean ? `${filename} — adjunto de «${clean}»` : filename;
}

async function record(
  ctx: AttachmentIngestContext,
  input: AttachmentIngestInput,
  ref: MailAttachmentRef,
  fields: {
    sha256: string;
    status: 'ready' | 'skipped' | 'failed';
    reason: string | null;
    documentId: string | null;
    ledgerId?: string | null;
  },
): Promise<void> {
  const row = {
    user_id: ctx.userId,
    provider: input.provider,
    thread_id: input.threadId,
    message_id: ref.messageId,
    attachment_key: ref.key ?? `sha:${ref.filename}:${ref.sizeBytes}`,
    filename: ref.filename,
    mime: ref.mime,
    size_bytes: ref.sizeBytes,
    sha256: fields.sha256,
    space_id: input.spaceId,
    document_id: fields.documentId,
    status: fields.status,
    reason: fields.reason,
    ingested_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  // Anotar no puede costar un archivo. Si el libro falla, el documento ya está
  // guardado y lo único que se pierde es no volver a intentarlo mañana — que es
  // exactamente el fallo barato de los dos posibles.
  try {
    if (fields.ledgerId) {
      await ctx.db.from('mail_attachment_ingests').update(row).eq('id', fields.ledgerId);
    } else {
      await ctx.db.from('mail_attachment_ingests').insert(row);
    }
  } catch (err) {
    ctx.logger.warn({ err, filename: ref.filename }, 'no se pudo anotar el adjunto en el libro');
  }
}
