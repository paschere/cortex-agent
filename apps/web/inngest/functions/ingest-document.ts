import { createHash } from 'node:crypto';
import { inngest } from '@/lib/inngest';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import {
  type ToolContext,
  createIntegrationsClient,
  driveGet,
  driveGetBytes,
  driveGetText,
} from '@zipdev/agent-tools';
import { chunkText } from '@zipdev/agent-tools/src/kb/chunker';
import { embed } from '@zipdev/agent-tools/src/kb/embedder';
import { parseDocument } from '@zipdev/agent-tools/src/kb/parsers';
import { logger } from '@zipdev/core';

export const ingestDocument = inngest.createFunction(
  { id: 'ingest-document', retries: 3 },
  { event: 'kb/document.ingest' },
  async ({ event, step }) => {
    const { documentId } = event.data as { documentId: string };
    const sb = getSupabaseServiceClient();

    // Fetch the document row
    const doc = await step.run('load-doc', async () => {
      const { data, error } = await sb
        .from('kb_documents')
        .select('*')
        .eq('id', documentId)
        .single();
      if (error || !data) throw new Error(`Document ${documentId} not found`);
      return data;
    });

    // Mark as ingesting
    await step.run('mark-ingesting', async () => {
      await sb.from('kb_documents').update({ status: 'ingesting' }).eq('id', documentId);
    });

    // Terminal failure for a source: mark the row failed and stop WITHOUT
    // throwing (so inngest does not retry an unrecoverable document).
    const failAndStop = async (message: string) => {
      await sb
        .from('kb_documents')
        .update({ status: 'failed', error_message: message })
        .eq('id', documentId);
      return { ok: false as const, error: message };
    };

    try {
      // Resolve the document content into a buffer + parse it.
      let text = '';
      let pages: number | undefined;
      if (doc.source === 'upload') {
        const storagePath = doc.source_ref as string | null;
        if (!storagePath) throw new Error(`Document ${documentId} has no source_ref`);
        const { data: file } = await sb.storage.from('kb-uploads').download(storagePath);
        if (!file) throw new Error('File not found in storage');
        const buffer = Buffer.from(await file.arrayBuffer());
        const parsed = await parseDocument(buffer, doc.mime as string);
        text = parsed.text;
        pages = parsed.pages;
      } else if (doc.source === 'gdrive') {
        const fileId = doc.source_ref as string | null;
        if (!fileId) return await failAndStop(`Document ${documentId} has no source_ref`);

        // The owner of the tracked folder set provides the Google credentials.
        const { data: syncState } = await sb
          .from('gdrive_sync_state')
          .select('owner_user_id')
          .eq('collection_id', doc.collection_id as string)
          .maybeSingle();
        const ownerUserId = syncState?.owner_user_id as string | null | undefined;
        if (!ownerUserId) {
          return await failAndStop(
            `No Google Drive owner configured for collection ${doc.collection_id}`,
          );
        }

        const ctx: Pick<ToolContext, 'integrations' | 'signal'> = {
          integrations: createIntegrationsClient(sb, ownerUserId, logger),
          signal: undefined,
        };
        const encId = encodeURIComponent(fileId);

        // Inspect the live mime to decide export vs. raw download.
        const meta = await driveGet<{ mimeType?: string }>(ctx as ToolContext, `/files/${encId}`, {
          fields: 'mimeType',
        });
        const liveMime = meta.mimeType ?? '';
        const isNative = liveMime.startsWith('application/vnd.google-apps');

        let bytes: Buffer;
        if (isNative) {
          const exportMime =
            liveMime === 'application/vnd.google-apps.spreadsheet' ? 'text/csv' : 'text/plain';
          try {
            const exported = await driveGetText(ctx as ToolContext, `/files/${encId}/export`, {
              mimeType: exportMime,
            });
            bytes = Buffer.from(exported, 'utf8');
          } catch (exportErr) {
            // Google caps exports at 10MB (403 exportSizeLimitExceeded). The Drive
            // helpers only target the API base URL and cannot follow the absolute
            // exportLinks URLs, so this is a terminal failure for the worker.
            const msg = (exportErr as Error).message ?? '';
            if (msg.includes('exportSizeLimitExceeded')) {
              return await failAndStop(
                `Google Drive export exceeds the 10MB size limit for file ${fileId}`,
              );
            }
            throw exportErr;
          }
        } else {
          bytes = await driveGetBytes(ctx as ToolContext, `/files/${encId}`, { alt: 'media' });
        }

        // Persist the content hash before parsing (the stored mime is the
        // post-export mime, not the live Drive mime).
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        await sb.from('kb_documents').update({ sha256 }).eq('id', documentId);

        try {
          const parsed = await parseDocument(bytes, doc.mime as string);
          text = parsed.text;
          pages = parsed.pages;
        } catch (parseErr) {
          return await failAndStop(
            `Failed to parse Google Drive file ${fileId}: ${(parseErr as Error).message}`,
          );
        }
      } else {
        throw new Error(`Source ${doc.source} not yet supported`);
      }

      // Clear any existing chunks before re-inserting (gdrive re-sync + retries).
      await step.run('clear-chunks', async () => {
        await sb.from('kb_chunks').delete().eq('document_id', documentId);
      });

      // Chunk the text
      const chunks = chunkText(text);
      if (chunks.length === 0) throw new Error('No chunks produced');

      // Embed all chunks (in batches handled internally by embed())
      const embeddings = await embed(chunks.map((c) => c.content));

      // Insert chunks
      await sb.from('kb_chunks').insert(
        chunks.map((c, i) => ({
          document_id: documentId,
          chunk_index: c.chunkIndex,
          content: c.content,
          tokens: c.tokens,
          embedding: embeddings[i],
          metadata: pages != null ? { pages } : {},
        })),
      );

      // Mark ready
      await sb.from('kb_documents').update({ status: 'ready' }).eq('id', documentId);

      return { ok: true, chunks: chunks.length };
    } catch (err) {
      await sb
        .from('kb_documents')
        .update({
          status: 'failed',
          error_message: (err as Error).message,
        })
        .eq('id', documentId);
      throw err;
    }
  },
);
