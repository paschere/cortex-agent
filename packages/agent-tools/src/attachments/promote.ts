import { randomUUID } from 'node:crypto';
import { type Logger, NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { getFile, putFile, removeFiles } from '../files';
import { registerTool } from '../index';
import { ingestMarkdown } from '../kb/ingest';
import {
  assertCanWriteToSpace,
  ensurePersonalSpace,
  listVisibleSpaces,
  resolveSpaceByName,
} from '../kb/spaces';
import type { ToolContext } from '../types';

/**
 * ARREPENTIRSE, EN CONVERSACIÓN.
 *
 * ===========================================================================
 * QUÉ ARREGLA
 * ===========================================================================
 * Al soltar un archivo en el chat hay que contestar una pregunta que no tiene
 * defecto: ¿esto entra a la memoria de la empresa, o es sólo para esta
 * conversación? La 0088 explica por qué no se puede adivinar y por qué la
 * respuesta no se recuerda como preferencia. Lo que faltaba es que la respuesta
 * «sólo este chat» fuera reversible.
 *
 * Y hace falta que lo sea porque el orden real de los hechos es este: alguien
 * sube un contrato para preguntar por una cláusula, Cortex contesta, y ENTONCES
 * la persona se da cuenta de que ese contrato tenía que estar en el cerebro.
 * En ese momento la única salida era volver a arrastrar el archivo —o sea,
 * tenerlo todavía a mano y acordarse— y contestar distinto. La mayoría de las
 * veces eso no pasa, y el archivo se borra solo a la semana sin que nadie lo
 * decida.
 *
 * La dirección contraria NO existe y no se va a construir: un documento
 * indexado ya contestó preguntas de otra gente, y despublicarlo no alcanza a
 * las respuestas que ya se dieron. Este producto sólo abre la puerta barata.
 *
 * ===========================================================================
 * EL ARCHIVO, NO LA TRANSCRIPCIÓN — Y QUÉ PASA CUANDO SÓLO QUEDA ESTA
 * ===========================================================================
 * Hay dos caminos y la diferencia importa lo suficiente como para decirla en
 * voz alta en el resultado:
 *
 *   CON BYTES (`file`). Es lo normal desde la 0112. El archivo tal como se subió
 *   está en `app_files` (bucket 'chat-uploads'), así que se copia a
 *   'kb-uploads', se inserta la fila de `kb_documents` apuntando ahí y se encola
 *   'kb/document.ingest'. Eso es LITERALMENTE la misma tubería que usa el camino
 *   'memory' de /api/chat/attachments — misma extracción, mismo troceado, mismos
 *   lotes de embeddings reanudables — y deja un documento ordinario: se puede
 *   volver a abrir, descargar y reextraer el día que haya un parser mejor.
 *
 *   SÓLO TEXTO (`text`). La fila es anterior a la 0112, o guardar los bytes
 *   falló en su día. Lo único que queda es lo que Cortex leyó, y eso es lo que
 *   se guarda, por `ingestMarkdown` — la otra puerta de ingesta del mismo
 *   cerebro, la que usan `kb.create_document` y las notas. El documento queda
 *   buscable y citable, pero SIN original detrás, y el resultado lo dice para
 *   que la respuesta también pueda decirlo. Un documento del que no se conserva
 *   el original es un documento de segunda y la gente no lo descubre hasta que
 *   lo necesita: no puede ser una diferencia silenciosa.
 *
 * ===========================================================================
 * LO QUE NO SE HACE DOS VECES
 * ===========================================================================
 * Dos guardas, contra dos casos distintos:
 *
 *   EL MISMO ADJUNTO, PROMOVIDO DOS VECES. `promoted_document_id` en la fila
 *   (0112). El modelo repite llamadas cuando la conversación se enreda, y la
 *   segunda no puede costar un documento más contra el plan.
 *
 *   EL MISMO ARCHIVO, YA EN ESE ESPACIO. El sha256 contra `kb_documents`, igual
 *   que hace la ruta de subida. Cubre el caso que la guarda anterior no ve: el
 *   archivo entró por otro camino, o se adjuntó dos veces en dos turnos.
 *
 * En los dos casos se devuelve el documento que ya existe y se dice que ya
 * estaba, que es más útil que un éxito silencioso y mucho más útil que un
 * duplicado compitiendo consigo mismo en la recuperación.
 */

/**
 * ¿Aquel documento se guardó con archivo detrás o sólo con el texto?
 *
 * Se deduce de `source_ref`, que es donde está la respuesta de verdad: la
 * tubería con bytes deja ahí la ruta del archivo y `ingestMarkdown` no deja
 * nada. Deducirlo en vez de anotarlo evita una columna más que podría
 * contradecir al documento, y contesta también por los documentos que no
 * salieron de un adjunto.
 */
function promotedKindOf(sourceRef: string | null): 'file' | 'text' {
  return sourceRef ? 'file' : 'text';
}

/** Mismo saneado que la ruta de subida: la ruta es una clave, no un nombre. */
function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** El bucket donde la ruta de subida deja los bytes de un adjunto 'turn'. */
const CHAT_BUCKET = 'chat-uploads';
/** El bucket del que vive Brain Knowledge. */
const KB_BUCKET = 'kb-uploads';

interface AttachmentRow {
  id: string;
  disposition: string;
  filename: string;
  mime: string;
  sha256: string;
  extracted_text: string | null;
  file_path: string | null;
  promoted_document_id: string | null;
  promoted_space_id: string | null;
}

const ATTACHMENT_COLUMNS =
  'id, disposition, filename, mime, sha256, extracted_text, file_path, promoted_document_id, promoted_space_id';

async function loadAttachment(db: SupabaseClient, id: string): Promise<AttachmentRow> {
  const { data } = await db
    .from('chat_attachments')
    .select(ATTACHMENT_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  // El handle está acotado al espacio de trabajo, así que «no existe» y «es de
  // otra empresa» llegan aquí como lo mismo, que es como tienen que llegar.
  if (!data) {
    throw new NotFoundError(
      'No encuentro ese archivo adjunto. Puede que ya se haya borrado: los adjuntos de una conversación duran una semana.',
    );
  }
  return data as unknown as AttachmentRow;
}

export const attachmentsPromote = registerTool({
  id: 'attachments.promote',
  description:
    "Move a file the person attached to THIS conversation only (disposition 'turn') into the company's Brain Knowledge, so it stays searchable and citable after the conversation is gone. Pass `attachmentId` exactly as it appears in the `id` attribute of the `<archivo>` tag in the attachments block above the question. " +
    "Pass `space` with the name of the space it belongs in; leave it out and it goes into the person's own notes, which only they can see — saving into a company-wide space needs org admin rights. " +
    'ONLY call this when the person asks for it ("guárdalo", "que quede en el cerebro"). They already said no once when they uploaded it, and there is no undo: a document in the brain has answered other people\'s questions by the time anyone regrets it. ' +
    'Tell the person which space it landed in, and — when the result says so — that only the text could be saved because the original file is no longer around.',
  inputSchema: z.object({
    attachmentId: z
      .string()
      .uuid()
      .describe('The `id` of the `<archivo>` tag in the attachments block of this turn'),
    space: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Name of the space to save into — omit for the person's own notes"),
  }),
  outputSchema: z.object({
    documentId: z.string(),
    /** Cómo se llama el archivo, para que la respuesta lo nombre igual. */
    filename: z.string(),
    /** El espacio donde aterrizó, por nombre. */
    space: z.string(),
    /**
     * 'file' = entró el archivo por la tubería normal y hay original detrás.
     * 'text' = sólo quedaba el texto extraído y eso fue lo que se guardó.
     */
    promoted: z.enum(['file', 'text']),
    /** Ya estaba en el cerebro; no se indexó nada nuevo ni se cobró documento. */
    alreadyThere: z.boolean(),
    /** 'ready' se puede citar ya; 'pending' se está indexando. */
    status: z.enum(['ready', 'pending']),
    /** La frase que la respuesta puede repetir tal cual. */
    note: z.string(),
  }),
  rateLimit: { perMinute: 6 },
  handler: async (input, ctx) => {
    const row = await loadAttachment(ctx.db, input.attachmentId);

    if (row.disposition !== 'turn') {
      // Ya está en el cerebro desde que se subió. No es un error del que haya
      // que quejarse: es la respuesta.
      throw new ValidationError(
        `"${row.filename}" ya había entrado a Brain Knowledge cuando se subió, así que no hay nada que guardar.`,
      );
    }

    // ---------------------------------------------------------------------
    // ¿Ya lo promovimos?
    // ---------------------------------------------------------------------
    if (row.promoted_document_id) {
      const { data: prior } = await ctx.db
        .from('kb_documents')
        .select('id, status, source_ref, kb_collections(name)')
        .eq('id', row.promoted_document_id)
        .maybeSingle();
      if (prior) {
        const space =
          ((prior.kb_collections as { name?: string } | null)?.name as string | undefined) ??
          'el espacio donde quedó';
        return {
          documentId: prior.id as string,
          filename: row.filename,
          space,
          promoted: promotedKindOf(prior.source_ref as string | null),
          alreadyThere: true,
          status: (prior.status as string) === 'ready' ? ('ready' as const) : ('pending' as const),
          note: `"${row.filename}" ya estaba guardado en ${space}. No se guardó una segunda copia.`,
        };
      }
      // El documento se borró después de promoverlo. La anotación miente, así
      // que se sigue de largo y se vuelve a guardar: la persona está pidiendo
      // que esté ahí, y esa es la petición que hay que cumplir.
    }

    // ---------------------------------------------------------------------
    // ¿Dónde?
    // ---------------------------------------------------------------------
    let spaceId: string;
    let spaceName: string;
    if (input.space) {
      const target = await resolveSpaceByName(ctx.db, ctx.userId, input.space);
      if (!target) {
        const names = (await listVisibleSpaces(ctx.db, ctx.userId)).map((s) => s.name);
        throw new ValidationError(
          `There is no space called "${input.space}". You can save to: ${names.join(', ')}.`,
        );
      }
      // Ver un espacio no es poder escribir en él: el de toda la empresa lo lee
      // todo el mundo y sólo lo escribe un administrador. Misma puerta que
      // kb.create_document y que la ruta de subida.
      await assertCanWriteToSpace(ctx.db, ctx.userId, target.id);
      spaceId = target.id;
      spaceName = target.name;
    } else {
      // El defecto sin nombrar es el privado, por la misma asimetría de
      // siempre: lo que debía ser compartido está a un paso de serlo, lo que se
      // publicó por error ya lo leyó alguien.
      const own = await ensurePersonalSpace(ctx.db, ctx.userId);
      spaceId = own.id;
      spaceName = own.name;
    }

    // ---------------------------------------------------------------------
    // ¿Este archivo ya está en ese espacio, por otro camino?
    // ---------------------------------------------------------------------
    const { data: existing } = await ctx.db
      .from('kb_documents')
      .select('id, status, source_ref')
      .eq('collection_id', spaceId)
      .eq('sha256', row.sha256)
      .limit(1)
      .maybeSingle();

    if (existing) {
      await recordPromotion(ctx.db, row.id, existing.id as string, spaceId, ctx.logger);
      return {
        documentId: existing.id as string,
        filename: row.filename,
        space: spaceName,
        promoted: promotedKindOf(existing.source_ref as string | null),
        alreadyThere: true,
        status: (existing.status as string) === 'ready' ? ('ready' as const) : ('pending' as const),
        note: `"${row.filename}" ya estaba en ${spaceName}, así que no se guardó una segunda copia.`,
      };
    }

    // ---------------------------------------------------------------------
    // Con bytes: la tubería normal, entera
    // ---------------------------------------------------------------------
    // La condición incluye la cola a propósito. Insertar el documento y no poder
    // encolar la ingesta deja una fila 'pending' que no se va a indexar sola y
    // que nadie va a volver a mirar; sin cola, el camino honesto es el texto,
    // que se guarda entero dentro de esta misma llamada.
    const canQueue = typeof ctx.enqueueJob === 'function';
    if (row.file_path && canQueue) {
      const stored = await getFile(ctx.db, CHAT_BUCKET, row.file_path).catch(() => null);
      if (stored) {
        const promoted = await promoteBytes(ctx, {
          row,
          spaceId,
          spaceName,
          bytes: stored.content,
        });
        if (promoted) return promoted;
        // Encolar falló. `promoteBytes` ya deshizo lo que había escrito, así que
        // se cae al texto en vez de dejar un documento que nunca se indexa.
      }
    }

    // ---------------------------------------------------------------------
    // Sólo texto
    // ---------------------------------------------------------------------
    const text = (row.extracted_text ?? '').trim();
    if (text.length === 0) {
      throw new ValidationError(
        `De "${row.filename}" no queda ni el archivo ni el texto que Cortex leyó, así que no hay nada que guardar. Habría que volver a subirlo.`,
      );
    }

    const { documentId } = await ingestMarkdown(ctx.db, {
      collectionId: spaceId,
      title: row.filename,
      content: text,
      uploadedBy: ctx.userId,
    });
    await recordPromotion(ctx.db, row.id, documentId, spaceId, ctx.logger);

    return {
      documentId,
      filename: row.filename,
      space: spaceName,
      promoted: 'text' as const,
      alreadyThere: false,
      status: 'ready' as const,
      note: `Guardé "${row.filename}" en ${spaceName}. Del archivo original ya no quedaba copia, así que lo que quedó guardado es el texto que alcancé a leer, no el archivo: se puede buscar y citar, pero no se puede volver a descargar.`,
    };
  },
});

/**
 * El camino con archivo: copiar los bytes al bucket del cerebro, crear la fila y
 * encolar la ingesta de siempre.
 *
 * Devuelve `null` —después de deshacer— cuando la cola no aceptó el trabajo. Es
 * la única forma de fallo que merece caer al texto en vez de propagarse: todo lo
 * demás (el espacio, los permisos, el almacén) ya falló antes o falla igual por
 * el otro camino.
 */
async function promoteBytes(
  ctx: ToolContext,
  args: {
    row: AttachmentRow;
    spaceId: string;
    spaceName: string;
    bytes: Uint8Array;
  },
): Promise<{
  documentId: string;
  filename: string;
  space: string;
  promoted: 'file';
  alreadyThere: false;
  status: 'pending';
  note: string;
} | null> {
  const { row, spaceId, spaceName, bytes } = args;
  // El id se decide aquí porque va dentro de la ruta: el documento y su archivo
  // no se pueden desparejar ni pisar a otro.
  const documentId = randomUUID();
  const storagePath = `${ctx.userId}/${documentId}/${safeName(row.filename)}`;

  await putFile(ctx.db, {
    bucket: KB_BUCKET,
    path: storagePath,
    content: bytes,
    contentType: row.mime,
  });

  const { error } = await ctx.db.from('kb_documents').insert({
    id: documentId,
    collection_id: spaceId,
    source: 'upload',
    source_ref: storagePath,
    title: row.filename,
    mime: row.mime,
    sha256: row.sha256,
    uploaded_by: ctx.userId,
    status: 'pending',
  });
  if (error) {
    // Un archivo en el almacén al que no apunta ninguna fila no lo encuentra
    // nadie y no lo borra nada.
    await removeFiles(ctx.db, KB_BUCKET, [storagePath]).catch(() => {});
    throw new Error(`No se pudo registrar el documento: ${error.message}`);
  }

  // La única tubería de ingesta que tiene este producto. El evento lleva el id
  // del documento y nada más: el trabajador lee el espacio de trabajo de la
  // fila en vez de fiarse de quien lo mandó.
  const queued = await ctx.enqueueJob?.('kb/document.ingest', { documentId });
  if (!queued) {
    await ctx.db.from('kb_documents').delete().eq('id', documentId);
    await removeFiles(ctx.db, KB_BUCKET, [storagePath]).catch(() => {});
    ctx.logger.warn(
      { documentId, attachmentId: row.id },
      'no se pudo encolar la ingesta del adjunto promovido; se guarda el texto',
    );
    return null;
  }

  await recordPromotion(ctx.db, row.id, documentId, spaceId, ctx.logger);

  return {
    documentId,
    filename: row.filename,
    space: spaceName,
    promoted: 'file',
    alreadyThere: false,
    status: 'pending',
    note: `Guardé "${row.filename}" en ${spaceName}. Se está indexando; en cuanto termine se puede citar como cualquier otro documento.`,
  };
}

/**
 * Anota en el adjunto qué documento salió de él.
 *
 * CONDICIONAL (`.is('promoted_document_id', null)`) para que dos llamadas
 * simultáneas no se sobrescriban el rastro: la primera gana y la segunda no
 * toca nada. Y NO LANZA: el documento ya existe y ya se está indexando, que es
 * lo que la persona pidió; perder el recibo sólo cuesta que una promoción
 * repetida vuelva a mirar el sha256, que es exactamente para lo que está.
 */
async function recordPromotion(
  db: SupabaseClient,
  attachmentId: string,
  documentId: string,
  spaceId: string,
  logger: Logger,
): Promise<void> {
  const { error } = await db
    .from('chat_attachments')
    .update({
      promoted_document_id: documentId,
      promoted_space_id: spaceId,
      promoted_at: new Date().toISOString(),
    })
    .eq('id', attachmentId)
    .is('promoted_document_id', null);
  if (error) {
    logger.warn({ attachmentId, documentId, err: error.message }, 'no se pudo anotar la promoción');
  }
}
