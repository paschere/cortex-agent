import { createHash, randomUUID } from 'node:crypto';
import { enqueueJob } from '@/lib/jobs';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  assertCanWriteToSpace,
  ensurePersonalSpace,
  parseDocument,
  putFile,
  removeFiles,
} from '@cortex/agent-tools';
import { ForbiddenError, NotFoundError, logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * A FILE DROPPED INTO A CHAT, AND THE TWO THINGS IT CAN BECOME.
 *
 * ===========================================================================
 * WHY THERE IS A QUESTION AT ALL
 * ===========================================================================
 * Until now a file dropped into the chat went straight into the uploader's own
 * notes. That was a safe default and it was also a silent one: the person got
 * no say, and the file joined a searchable corpus whether or not that was what
 * they wanted. The two failures that produces are opposite and both real —
 * somebody drags in a client contract to ask about one clause and it quietly
 * becomes company memory; or somebody uploads the price list they want everyone
 * to have and it lands somewhere only they can see.
 *
 * Neither is fixable by choosing a better default, because the right answer
 * depends on the file and the person knows it at the moment they drop it and
 * never again. So they are asked, then, once, and the answer is not remembered
 * as a preference — a preference is exactly how the wrong answer gets applied
 * to the one file it must not be applied to.
 *
 * ===========================================================================
 * WHERE 'memory' PUTS IT
 * ===========================================================================
 * In a space the person picks, and the picker defaults to their own notes.
 * This is the third time this product has answered that question and the answer
 * has to match the other two or it stops being a rule:
 * `meetings/import-transcript.ts` files a call into the importer's own space by
 * default, and migration 0068 § 3 requires a WhatsApp group to name its space
 * before archiving is switched on. The shared argument is the asymmetry:
 * something that should have been shared is one drag away, and something that
 * should have stayed private and was published cannot be un-read.
 *
 * A company-wide space is offered but rarely permitted:
 * `assertCanWriteToSpace` refuses it to anyone who is not an org admin, so
 * "publish this to everyone" takes both an explicit choice and the authority.
 *
 * ===========================================================================
 * WHERE 'turn' PUTS IT — WHICH IS NOWHERE THAT COUNTS
 * ===========================================================================
 * No `kb_documents` row, no embeddings, no index. The bytes are parsed to text
 * in this request, the text is written to `chat_attachments.extracted_text`,
 * and the row expires in a week. The chat route hands that text to the model
 * labelled as an attachment rather than as knowledge, so an answer can use it
 * and cannot cite it as though it lived in the brain.
 *
 * A consequence worth stating because it is a feature: a 'turn' file never
 * reaches the plan's document meter, because that meter is a trigger on
 * `kb_documents` and no row is ever inserted. Asking a question about a PDF
 * costs nothing; remembering it costs one document.
 *
 * DESDE LA 0112 LOS BYTES SÍ SE GUARDAN, y eso no contradice el párrafo de
 * arriba: van a `app_files` (bucket 'chat-uploads'), viven exactamente lo que
 * vive la fila y se borran con ella. Nada de eso toca el índice ni el medidor.
 * Existen para una sola cosa: que `attachments.promote` pueda cumplir lo que
 * promete. Guardar en el cerebro el texto plano que se extrajo aquí NO es
 * guardar el contrato — el documento resultante no se podría volver a abrir, ni
 * descargar, ni reextraer con un parser mejor — y esa diferencia no se nota
 * hasta el día en que hace falta el original. Si guardar los bytes falla, el
 * adjunto sigue sirviendo para la conversación y la promoción cae al texto,
 * diciéndolo.
 *
 * ===========================================================================
 * THE SAME FILE TWICE
 * ===========================================================================
 * `/api/kb/documents` computes a sha256 and stores it and has never looked at
 * it, so dropping the same file twice has always produced two documents, two
 * storage objects and two metered units. On this path it is checked: if the
 * space already holds a document with these bytes, that document is reused and
 * nothing is indexed. The person is told it was already there, which is more
 * useful than a silent success and much more useful than a duplicate.
 */

/** Mirrors `/api/kb/documents`. Kept in step by hand; both refuse the rest. */
const TEXT_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
]);

const MAX_FILE_SIZE = 10 * 1024 * 1024;

/**
 * How much of a document the model gets on the 'turn' path.
 *
 * A whole PDF pasted above the question would crowd out the conversation and,
 * past a point, the retrieval that makes the rest of the answer good. The
 * ceiling is generous for a contract clause or an invoice and honest about what
 * it does: the interface says the file was read up to here, rather than
 * implying the model saw all of it.
 */
const TURN_TEXT_CHARS = 24_000;

function baseMime(mime: string): string {
  return (mime.split(';')[0] ?? '').trim().toLowerCase();
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export async function POST(req: NextRequest) {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: 'Se esperaba un archivo.' }, { status: 400 });

  const file = form.get('file');
  const conversationId = String(form.get('conversationId') ?? '');
  const disposition = String(form.get('disposition') ?? '');
  const requestedSpace = form.get('spaceId');

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Falta el archivo.' }, { status: 422 });
  }
  if (!conversationId) {
    return NextResponse.json({ error: 'Falta la conversación.' }, { status: 422 });
  }
  if (disposition !== 'memory' && disposition !== 'turn') {
    // There is no default here on purpose — see the header, and the note above
    // the table in migration 0088. A request that does not say is a bug in the
    // caller, not a request to guess.
    return NextResponse.json(
      { error: 'Hay que decir si el archivo entra a la memoria o es sólo para esta conversación.' },
      { status: 422 },
    );
  }

  const mime = baseMime(file.type);
  if (!TEXT_MIME_TYPES.has(mime)) {
    return NextResponse.json(
      { error: 'Por ahora Cortex sólo lee PDF, DOCX, TXT y MD desde el chat.' },
      { status: 415 },
    );
  }
  if (file.size > MAX_FILE_SIZE) {
    return NextResponse.json({ error: 'El archivo pasa de 10 MB.' }, { status: 413 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const sha256 = createHash('sha256').update(buffer).digest('hex');

  // -------------------------------------------------------------------------
  // Only for this conversation: read it, keep the text, index nothing.
  // -------------------------------------------------------------------------
  if (disposition === 'turn') {
    let text: string;
    try {
      const parsed = await parseDocument(buffer, mime);
      text = parsed.text.slice(0, TURN_TEXT_CHARS);
    } catch (err) {
      return NextResponse.json(
        {
          error:
            err instanceof Error && err.message
              ? `No se pudo leer el archivo: ${err.message}`
              : 'No se pudo leer el archivo.',
        },
        { status: 422 },
      );
    }

    if (text.trim().length === 0) {
      return NextResponse.json(
        { error: 'El archivo no tiene texto que Cortex pueda leer. Si es un escaneo, todavía no.' },
        { status: 422 },
      );
    }

    // El id se decide aquí, antes de escribir nada, porque la ruta de los bytes
    // lo lleva dentro: así el archivo y la fila que lo nombra no se pueden
    // desparejar, y dos personas subiendo el mismo nombre no se pisan.
    const attachmentId = randomUUID();
    const filePath = `${user.id}/${attachmentId}/${safeName(file.name)}`;

    // Los bytes, para que `attachments.promote` pueda guardar el ARCHIVO y no
    // la transcripción. Best-effort a propósito: la conversación necesita el
    // texto, que ya está leído, y perder este turno porque el almacén parpadeó
    // sería cambiar una promoción de mejor calidad por ninguna respuesta.
    let stored = true;
    try {
      await putFile(db, {
        bucket: 'chat-uploads',
        path: filePath,
        content: buffer,
        contentType: mime,
      });
    } catch (err) {
      stored = false;
      logger.warn('chat attachment bytes not stored', {
        attachmentId,
        message: err instanceof Error ? err.message : String(err),
      });
    }

    const { data, error } = await db
      .from('chat_attachments')
      .insert({
        id: attachmentId,
        conversation_id: conversationId,
        disposition: 'turn',
        filename: file.name,
        mime,
        byte_size: file.size,
        sha256,
        extracted_text: text,
        file_path: stored ? filePath : null,
        created_by: user.id,
      })
      .select('id, filename, disposition, created_at')
      .single();

    if (error || !data) {
      // Sin la fila, la ruta no la conoce nadie y el barrido de retención no la
      // encontraría nunca: el archivo quedaría ocupando sitio para siempre.
      if (stored) await removeFiles(db, 'chat-uploads', [filePath]).catch(() => {});
      return NextResponse.json({ error: 'No se pudo adjuntar el archivo.' }, { status: 500 });
    }

    return NextResponse.json(
      {
        attachment: {
          ...data,
          truncated: text.length >= TURN_TEXT_CHARS,
          status: 'ready',
        },
      },
      { status: 201 },
    );
  }

  // -------------------------------------------------------------------------
  // Into the memory: a space the person chose, and the ordinary ingestion.
  // -------------------------------------------------------------------------
  let spaceId: string;
  let spaceName: string;
  try {
    if (typeof requestedSpace === 'string' && requestedSpace) {
      const space = await assertCanWriteToSpace(db, user.id, requestedSpace);
      spaceId = space.id;
      spaceName = space.name;
    } else {
      const personal = await ensurePersonalSpace(db, user.id);
      spaceId = personal.id;
      spaceName = personal.name;
    }
  } catch (err) {
    if (err instanceof NotFoundError) {
      return NextResponse.json({ error: 'Ese espacio ya no existe.' }, { status: 404 });
    }
    if (err instanceof ForbiddenError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    throw err;
  }

  // Already in this space? Reuse it. Indexing it again would cost the workspace
  // a second document against its plan for one file, and would put two copies
  // of the same text into retrieval, where they compete with each other.
  const { data: existing } = await db
    .from('kb_documents')
    .select('id, title, status')
    .eq('collection_id', spaceId)
    .eq('sha256', sha256)
    .limit(1)
    .maybeSingle();

  let documentId: string;
  let alreadyThere = false;

  if (existing) {
    documentId = existing.id as string;
    alreadyThere = true;
  } else {
    documentId = randomUUID();
    const storagePath = `${user.id}/${documentId}/${safeName(file.name)}`;

    try {
      // Camino chico (techo de 10MB): va por la capa PostgREST normal, con el
      // cliente scopeado que le pone el organization_id a la fila.
      await putFile(db, {
        bucket: 'kb-uploads',
        path: storagePath,
        content: buffer,
        contentType: mime,
      });
    } catch {
      return NextResponse.json({ error: 'No se pudo guardar el archivo.' }, { status: 500 });
    }

    const { error: insertError } = await db.from('kb_documents').insert({
      id: documentId,
      collection_id: spaceId,
      source: 'upload',
      source_ref: storagePath,
      title: file.name,
      mime,
      sha256,
      uploaded_by: user.id,
      status: 'pending',
    });

    if (insertError) {
      // Do not leave the file orphaned in app_files: it would take space and be
      // unreachable, with no row that could ever point at it.
      await removeFiles(db, 'kb-uploads', [storagePath]).catch(() => {});
      return NextResponse.json({ error: 'No se pudo registrar el archivo.' }, { status: 500 });
    }

    // The one ingestion path this product has. Extraction, chunking, resumable
    // batched embeddings and — for audio — transcription all live in
    // apps/web/inngest/functions/ingest-document.ts, and the event carries the
    // document id and nothing else so the worker reads the workspace off the
    // row rather than trusting the sender.
    await enqueueJob('kb/document.ingest', { documentId });
  }

  const { data: attachment, error: attachError } = await db
    .from('chat_attachments')
    .insert({
      id: randomUUID(),
      conversation_id: conversationId,
      disposition: 'memory',
      filename: file.name,
      mime,
      byte_size: file.size,
      sha256,
      kb_document_id: documentId,
      space_id: spaceId,
      created_by: user.id,
    })
    .select('id, filename, disposition, created_at')
    .single();

  if (attachError || !attachment) {
    // The document is real and indexing; only the chat's receipt failed. Say so
    // rather than implying nothing happened.
    logger.error('chat attachment receipt failed', { message: attachError?.message });
    return NextResponse.json(
      {
        error:
          'El archivo entró a la memoria, pero el chat no pudo mostrarlo. Búscalo en Brain Knowledge.',
      },
      { status: 500 },
    );
  }

  return NextResponse.json(
    {
      attachment: {
        ...attachment,
        documentId,
        spaceName,
        alreadyThere,
        status: alreadyThere ? ((existing?.status as string) ?? 'ready') : 'pending',
      },
    },
    { status: 201 },
  );
}

/**
 * What is attached to this conversation, and how far along it is.
 *
 * Polled by the chat while anything is still being read. The status comes from
 * `kb_documents` — the same column the Brain Knowledge screen reads — so the
 * two surfaces cannot disagree about whether a file is ready.
 */
export async function GET(req: NextRequest) {
  const conversationId = req.nextUrl.searchParams.get('conversationId');
  if (!conversationId) return NextResponse.json({ attachments: [] });

  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);

  const { data } = await db
    .from('chat_attachments')
    .select(
      'id, filename, disposition, created_at, kb_document_id, space_id, kb_documents(status, error_message), kb_collections(name)',
    )
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(30);

  const attachments = (data ?? []).map((row) => {
    const doc = row.kb_documents as { status?: string; error_message?: string | null } | null;
    const space = row.kb_collections as { name?: string } | null;
    return {
      id: row.id as string,
      filename: row.filename as string,
      disposition: row.disposition as 'memory' | 'turn',
      documentId: (row.kb_document_id as string | null) ?? null,
      spaceName: space?.name ?? null,
      // A 'turn' attachment was fully read before this route replied, so it has
      // no lifecycle to report; only a document being indexed does.
      status: row.disposition === 'turn' ? 'ready' : (doc?.status ?? 'pending'),
      error: doc?.error_message ?? null,
    };
  });

  return NextResponse.json({ attachments });
}
