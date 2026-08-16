import { createHash, randomUUID } from 'node:crypto';
import { enqueueJob } from '@/lib/jobs';
import { getOrgScopedClient } from '@/lib/supabase/service';
import type { DocumentSink } from '@cortex/agent-tools';
import { ensurePersonalSpace, putFile, removeFiles } from '@cortex/agent-tools';
import { logger } from '@cortex/core';

/**
 * What happens to the certificate after the trámite fetches it.
 *
 * ---------------------------------------------------------------------------
 * THIS COMPOSES; IT DOES NOT BUILD
 * ---------------------------------------------------------------------------
 * Everything a downloaded file needs already exists and is already good: a
 * private bucket with a 10MB ceiling (migration 0013), a `kb_documents` row that
 * describes a document whatever it came from, and one Inngest function that
 * parses, chunks, embeds AND runs the structured extraction of migration 0076.
 * An upload from the browser goes through exactly this, and so does a file
 * imported from Drive.
 *
 * So a certificate pulled out of a portal is filed the same way, and everything
 * downstream works without having heard of trámites: it is searchable in Brain
 * Knowledge, quotable with a citation, and its fields (a NIT, a date, a total)
 * are extracted by the same pass that reads an invoice. The only thing this file
 * adds is PROVENANCE -- which portal, which trámite, which run, and when --
 * because "where did this certificate come from" is the first question anybody
 * asks of a document that no human downloaded.
 *
 * ---------------------------------------------------------------------------
 * WHERE IT LANDS, AND WHY THAT IS NOT A SHARED SPACE
 * ---------------------------------------------------------------------------
 * The personal space of whoever ran the trámite. This product has decided twice
 * already that there is no default shared destination, for the reason that does
 * not go away: what is over-shared cannot be un-read. A certificate of somebody's
 * criminal record, a tax statement, a bank extract -- these are exactly the
 * documents where a helpful default would be a disclosure, and the person who
 * ran the errand is the one who knows who should see it. Moving it to a team
 * space afterwards is one click and it is theirs to make.
 */

/** The ceiling the old bucket had (0013), kept now that files live in app_files. */
const MAX_BYTES = 10 * 1024 * 1024;

export function browserDocumentSink(): DocumentSink {
  return async (file, context) => {
    if (file.sizeBytes > MAX_BYTES || file.base64.length === 0) return null;

    const db = getOrgScopedClient(context.organizationId);
    const bytes = Buffer.from(file.base64, 'base64');
    const space = await ensurePersonalSpace(db, context.userId);

    const documentId = randomUUID();
    const safeName = file.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `${context.userId}/${documentId}/${safeName}`;

    try {
      // Camino chico (techo de 10MB): la capa PostgREST normal con el cliente
      // scopeado. Ver files/store.ts; los grandes van por lib/files-db.ts.
      await putFile(db, {
        bucket: 'kb-uploads',
        path: storagePath,
        content: bytes,
        contentType: file.mimeType,
      });
    } catch (err) {
      logger.error(
        { err: (err as Error).message, flowId: context.flowId },
        'could not store a document a trámite downloaded',
      );
      return null;
    }

    const title = `${file.filename} — ${context.flowName}`;
    const { error: insertError } = await db
      .from('kb_documents')
      .insert({
        id: documentId,
        collection_id: space.id,
        // A fourth provenance alongside upload, gdrive and outlook. See
        // migration 0091: an answer that cites this should be able to say the
        // document came out of a portal by itself.
        source: 'tramite',
        source_ref: storagePath,
        title,
        mime: file.mimeType,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        uploaded_by: context.userId,
        status: 'pending',
        metadata: {
          tramite: {
            flowId: context.flowId,
            flowName: context.flowName,
            host: context.host,
            runId: context.runId,
            fetchedAt: new Date().toISOString(),
          },
        },
      })
      .select('id')
      .single();

    if (insertError) {
      await removeFiles(db, 'kb-uploads', [storagePath]).catch(() => {});
      logger.error(
        { err: insertError.message, flowId: context.flowId },
        'could not register a document a trámite downloaded',
      );
      return null;
    }

    // From here it is an ordinary document and nothing downstream knows or
    // needs to know that a robot fetched it.
    await enqueueJob('kb/document.ingest', { documentId });
    return { documentId, title };
  };
}
