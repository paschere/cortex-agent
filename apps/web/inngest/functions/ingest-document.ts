import { createHash } from 'node:crypto';
import { inngest } from '@/lib/inngest';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import {
  type ToolContext,
  createIntegrationsClient,
  driveGet,
  driveGetBytes,
  driveGetText,
} from '@cortex/agent-tools';
import { chunkText } from '@cortex/agent-tools/src/kb/chunker';
import { embedDocuments } from '@cortex/agent-tools/src/kb/embedder';
import { parseDocument } from '@cortex/agent-tools/src/kb/parsers';
import { transcribeAudio } from '@cortex/agent-tools/src/kb/transcribe';
import { chunkTranscript } from '@cortex/agent-tools/src/kb/transcript-chunker';
import { logger } from '@cortex/core';

/** Long enough for Deepgram to pull a 200MB recording, short enough to expire. */
const AUDIO_SIGNED_URL_TTL_SECONDS = 60 * 60;

/** What goes into kb_chunks, whichever branch produced it. */
interface PendingChunk {
  content: string;
  chunkIndex: number;
  tokens: number;
  metadata: Record<string, unknown>;
}

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
      // Filled by the audio branch only. A conversation is not chunked from a
      // wall of text — its chunks are groups of speech turns, each carrying the
      // speaker and the offsets that make a citation checkable — so that branch
      // produces finished chunks rather than a string for `chunkText`.
      let transcriptChunks: PendingChunk[] | null = null;

      if (doc.media_kind === 'audio') {
        const audioPath = (doc.media_path ?? doc.source_ref) as string | null;
        if (!audioPath) {
          return await failAndStop(`Recording ${documentId} has no stored audio path`);
        }

        await sb
          .from('kb_documents')
          .update({ transcript_status: 'transcribing', transcript_error: null })
          .eq('id', documentId);

        // Signing and transcribing live in one step so the URL cannot expire
        // between them, and so an Inngest retry of a LATER step never re-pays
        // for a transcription that already succeeded — minutes of work and the
        // most expensive call in this function.
        const outcome = await step.run('transcribe-audio', async () => {
          const { data: signed, error: signError } = await sb.storage
            .from('kb-uploads')
            .createSignedUrl(audioPath, AUDIO_SIGNED_URL_TTL_SECONDS);
          if (signError || !signed?.signedUrl) {
            throw new Error(
              `Could not sign the recording for transcription: ${signError?.message}`,
            );
          }
          // Deepgram fetches the audio itself. Downloading it here only to
          // upload the same bytes back would double the transfer and hold the
          // whole file in this function's heap for the length of the call.
          return await transcribeAudio({ url: signed.signedUrl }, { logger });
        });

        if (!outcome.ok) {
          await sb
            .from('kb_documents')
            .update({ transcript_status: 'failed', transcript_error: outcome.reason })
            .eq('id', documentId);
          // A missing key or an undecodable file will fail identically on every
          // retry; a rate limit or an outage will not. Only the first kind stops.
          if (!outcome.retryable) return await failAndStop(outcome.reason);
          throw new Error(outcome.reason);
        }

        const transcript = outcome.data;
        transcriptChunks = chunkTranscript(transcript.turns).map((c) => ({
          content: c.content,
          chunkIndex: c.chunkIndex,
          tokens: c.tokens,
          metadata: {
            ...c.metadata,
            ...(transcript.language ? { language: transcript.language } : {}),
          },
        }));

        await sb
          .from('kb_documents')
          .update({
            transcript_status: 'ready',
            transcript_error: null,
            duration_seconds: transcript.durationSeconds,
            speakers: transcript.speakers,
            // Only filled in if the uploader could not say when the call
            // happened — their answer is better than our guess.
            ...(doc.recorded_at ? {} : { recorded_at: doc.created_at }),
          })
          .eq('id', documentId);
      } else if (doc.source === 'upload') {
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

      const chunks: PendingChunk[] =
        transcriptChunks ??
        chunkText(text).map((c) => ({
          content: c.content,
          chunkIndex: c.chunkIndex,
          tokens: c.tokens,
          metadata: pages != null ? { pages } : {},
        }));
      if (chunks.length === 0) throw new Error('No chunks produced');

      // Embed all chunks (batched internally, as documents — never as queries)
      const embedded = await embedDocuments(chunks.map((c) => c.content));

      // A missing Voyage key is not a reason to lose the document. The text is
      // the expensive part (download, export, parse); the vectors are cheap to
      // add later. Storing the chunks with a null embedding keeps the document
      // findable by keyword and hands it to kb-reindex-embeddings, which fills
      // the vectors in and flips the row to `ready` once the key exists. Any
      // other failure is transient and worth an Inngest retry.
      if (!embedded.ok && embedded.configured) throw new Error(embedded.reason);

      await sb.from('kb_chunks').insert(
        chunks.map((c, i) => ({
          document_id: documentId,
          chunk_index: c.chunkIndex,
          content: c.content,
          tokens: c.tokens,
          embedding: embedded.ok ? embedded.data[i] : null,
          metadata: c.metadata,
        })),
      );

      if (!embedded.ok) {
        await sb
          .from('kb_documents')
          .update({ status: 'pending', error_message: embedded.reason })
          .eq('id', documentId);
        return { ok: true, chunks: chunks.length, awaitingEmbeddings: true };
      }

      await sb
        .from('kb_documents')
        .update({ status: 'ready', error_message: null })
        .eq('id', documentId);

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
