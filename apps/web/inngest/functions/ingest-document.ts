import { createHash } from 'node:crypto';
import { inngest } from '@/lib/inngest';
import type { JobContext, JobHandler } from '@/lib/jobs';
import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import {
  type ToolContext,
  OVER_DOCUMENT_LIMIT_MESSAGE,
  checkMeter,
  createIntegrationsClient,
  driveGet,
  driveGetBytes,
  driveGetText,
  isDegraded,
} from '@cortex/agent-tools';
import { extractDocumentData } from '@cortex/agent-tools/src/documents/ingest';
import { chunkText } from '@cortex/agent-tools/src/kb/chunker';
import { embedInBatches, embeddingModelId } from '@cortex/agent-tools/src/kb/embedder';
import { recordEmbeddingUsage } from '@cortex/agent-tools/src/kb/embedding-usage';
import { parseDocument } from '@cortex/agent-tools/src/kb/parsers';
import { transcribeAudio } from '@cortex/agent-tools/src/kb/transcribe';
import { chunkTranscript } from '@cortex/agent-tools/src/kb/transcript-chunker';
import { logger } from '@cortex/core';

/** Long enough for Deepgram to pull a 200MB recording, short enough to expire. */
const AUDIO_SIGNED_URL_TTL_SECONDS = 60 * 60;

/**
 * How many chunks one embedding step takes on. Comfortably above any provider's
 * per-request ceiling on purpose: the step re-plans the work into real provider
 * requests internally and PERSISTS EACH ONE as it lands, so a bigger slice means
 * fewer Inngest steps without making any single failure more expensive.
 */
const CHUNKS_PER_EMBED_STEP = 128;

/**
 * A ceiling on steps per invocation, not on work. Whatever is left is picked up
 * by kb-reindex-embeddings on its next pass — the same drain that already exists
 * for chunks stored without a key.
 */
const MAX_EMBED_STEPS = 40;

/** What goes into kb_chunks, whichever branch produced it. */
interface PendingChunk {
  content: string;
  chunkIndex: number;
  tokens: number;
  metadata: Record<string, unknown>;
}

/**
 * What a source-resolution step hands back. Small on purpose: the TEXT goes to
 * the database inside the step, not through Inngest's memoised step output.
 */
type PrepareOutcome =
  | { ok: true; chunks: number }
  /** Unrecoverable for this document — the row is already marked failed. */
  | { ok: false; terminal: true; reason: string };

/**
 * El cuerpo, extraído a la firma de la cola nueva. Los reintentos (3) los da
 * el manifiesto del worker; el diseño resumable por pasos persiste cada lote
 * en la base, así que un reintento de pg-boss reejecuta la función entera pero
 * sólo compra lo que aún no está escrito.
 */
export const ingestDocumentJob: JobHandler = async ({ event, step }) => {
  const { documentId } = event.data as { documentId: string };

  // THE WORKSPACE COMES FROM THE DOCUMENT, NOT FROM THE EVENT. Ingestion is
  // triggered from four places (upload, Drive import, Drive sync, the
  // create-document tool) and will be triggered from a fifth eventually. If
  // the sender had to put the workspace on the event, one of them would
  // eventually not, and the job would have to either guess or fail. Reading it
  // off the row is unforgeable and cannot be forgotten: one unscoped lookup of
  // a single row by primary key, and every handle after it is pinned.
  const organizationId = await step.run('resolve-workspace', async () => {
    const raw = getSupabaseServiceClient();
    const { data } = await raw
      .from('kb_documents')
      .select('organization_id')
      .eq('id', documentId)
      .maybeSingle();
    return (data?.organization_id as string | undefined) ?? null;
  });
  if (!organizationId) return { ok: false as const, error: `Document ${documentId} not found` };

  const sb = getOrgScopedClient(organizationId);

  // Fetch the document row
  const doc = await step.run('load-doc', async () => {
    const { data, error } = await sb.from('kb_documents').select('*').eq('id', documentId).single();
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

  // Same contract as before the rewrite: whatever else happens, the row stops
  // claiming to be mid-ingestion and carries a sentence someone can read. The
  // throw is preserved so Inngest still counts the attempt.
  try {
    // -----------------------------------------------------------------------
    // 1. Source -> chunk ROWS, inside a step, with only a count coming back out
    // -----------------------------------------------------------------------
    // WHY THE EXTRACTION AND THE INSERT ARE ONE STEP. Inngest memoises what
    // happens INSIDE a step and re-executes everything outside it on every
    // retry. Extraction — a Drive export, a storage download, a PDF parse — used
    // to sit outside any step, so a failure anywhere later in this function
    // downloaded and parsed the whole document again. Pairing it with the insert
    // makes "the text exists in kb_chunks" the memoised fact, and the step's
    // output stays a single number instead of megabytes of prose.
    //
    // WHY THE TRANSCRIPTION KEEPS ITS OWN STEP. It is the single most expensive
    // call in the function and it already had one. Folding it into the chunking
    // step would mean a failed insert re-transcribing an hour of audio.
    let prepared: PrepareOutcome;

    if (doc.media_kind === 'audio') {
      const audioPath = (doc.media_path ?? doc.source_ref) as string | null;
      if (!audioPath) {
        return await failAndStop(`Recording ${documentId} has no stored audio path`);
      }

      // Signing and transcribing live in one step so the URL cannot expire
      // between them, and so an Inngest retry of a LATER step never re-pays for
      // a transcription that already succeeded.
      const outcome = await step.run('transcribe-audio', async () => {
        await sb
          .from('kb_documents')
          .update({ transcript_status: 'transcribing', transcript_error: null })
          .eq('id', documentId);

        const { data: signed, error: signError } = await sb.storage
          .from('kb-uploads')
          .createSignedUrl(audioPath, AUDIO_SIGNED_URL_TTL_SECONDS);
        if (signError || !signed?.signedUrl) {
          throw new Error(`Could not sign the recording for transcription: ${signError?.message}`);
        }
        // Deepgram fetches the audio itself. Downloading it here only to upload
        // the same bytes back would double the transfer and hold the whole file
        // in this function's heap for the length of the call.
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
      prepared = await step.run('store-transcript-chunks', async (): Promise<PrepareOutcome> => {
        // A conversation is not chunked from a wall of text — its chunks are
        // groups of speech turns, each carrying the speaker and the offsets that
        // make a citation checkable.
        const chunks: PendingChunk[] = chunkTranscript(transcript.turns).map((c) => ({
          content: c.content,
          chunkIndex: c.chunkIndex,
          tokens: c.tokens,
          metadata: {
            ...c.metadata,
            ...(transcript.language ? { language: transcript.language } : {}),
          },
        }));
        if (chunks.length === 0) throw new Error('No chunks produced');

        await storeChunks(sb, documentId, chunks);

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

        return { ok: true, chunks: chunks.length };
      });
    } else {
      prepared = await step.run('extract-and-store-chunks', async (): Promise<PrepareOutcome> => {
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
          if (!fileId) return terminal(`Document ${documentId} has no source_ref`);

          // The owner of the tracked folder set provides the Google credentials.
          const { data: syncState } = await sb
            .from('gdrive_sync_state')
            .select('owner_user_id')
            .eq('collection_id', doc.collection_id as string)
            .maybeSingle();
          const ownerUserId = syncState?.owner_user_id as string | null | undefined;
          if (!ownerUserId) {
            return terminal(`No Google Drive owner configured for collection ${doc.collection_id}`);
          }

          const ctx: Pick<ToolContext, 'integrations' | 'signal'> = {
            integrations: createIntegrationsClient(sb, ownerUserId, logger),
            signal: undefined,
          };
          const encId = encodeURIComponent(fileId);

          // Inspect the live mime to decide export vs. raw download.
          const meta = await driveGet<{ mimeType?: string }>(
            ctx as ToolContext,
            `/files/${encId}`,
            { fields: 'mimeType' },
          );
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
              // Google caps exports at 10MB (403 exportSizeLimitExceeded). The
              // Drive helpers only target the API base URL and cannot follow the
              // absolute exportLinks URLs, so this is terminal for the worker.
              const msg = (exportErr as Error).message ?? '';
              if (msg.includes('exportSizeLimitExceeded')) {
                return terminal(
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
            return terminal(
              `Failed to parse Google Drive file ${fileId}: ${(parseErr as Error).message}`,
            );
          }
        } else {
          throw new Error(`Source ${doc.source} not yet supported`);
        }

        const chunks: PendingChunk[] = chunkText(text).map((c) => ({
          content: c.content,
          chunkIndex: c.chunkIndex,
          tokens: c.tokens,
          metadata: pages != null ? { pages } : {},
        }));
        if (chunks.length === 0) throw new Error('No chunks produced');

        await storeChunks(sb, documentId, chunks);
        return { ok: true, chunks: chunks.length };
      });
    }

    if (!prepared.ok) return await failAndStop(prepared.reason);
    const chunkCount = prepared.chunks;

    // -----------------------------------------------------------------------
    // 2. Embed — one memoised step per slice, persisted as it goes
    // -----------------------------------------------------------------------
    // THE BUG THIS REPLACES. `embedDocuments(...)` used to be called here,
    // OUTSIDE any step, in a function declared `retries: 3`. Inngest re-executes
    // everything outside a step on every attempt, so one failure re-embedded the
    // entire document from scratch, up to four times — and because the embedder
    // batches internally, a failure in batch 15 of 20 also threw away the
    // fourteen batches already paid for and bought them again on the next
    // attempt. A long transcript is thousands of chunks. That is how one
    // document exhausted an account.
    //
    // WHAT MAKES IT RESUMABLE RATHER THAN REPEATABLE. Each step below re-reads
    // "chunks of this document that still have no vector from the CURRENT
    // model", embeds them one provider request at a time, and writes each
    // request's vectors before the next is sent. Two independent things now
    // protect the spend: Inngest never re-runs a completed step, and even a step
    // that dies mid-way finds only its unfinished remainder when it is retried.
    // A retry can cost at most one provider request that was already in flight.
    const modelId = embeddingModelId();
    let embedded = 0;
    let halted: string | null = null;

    // THE PLAN, ASKED ONCE, AFTER THE TEXT IS ALREADY SAFE.
    //
    // Note what is NOT gated: section 1 above already downloaded, parsed and — if
    // this was a recording — transcribed and stored the chunks. A workspace past
    // its document allowance loses none of that. What it does not get is the
    // embedding, which is the one part that can be added later for nothing.
    //
    // Skipping straight to `finalize` leaves the row exactly where a missing
    // embedding key leaves it: status `pending`, a sentence in `error_message`,
    // and every chunk stored and findable by keyword. `kb-reindex-embeddings`
    // already drains that state, so the document indexes itself once the plan
    // changes or the month rolls over — with nothing to re-upload and no second
    // transcription to pay for.
    const overDocumentLimit = await step.run('document-allowance', async () =>
      isDegraded(await checkMeter(sb, 'documents')),
    );
    if (overDocumentLimit) halted = OVER_DOCUMENT_LIMIT_MESSAGE;

    const steps = overDocumentLimit
      ? 0
      : Math.min(MAX_EMBED_STEPS, Math.ceil(chunkCount / CHUNKS_PER_EMBED_STEP));
    for (let i = 0; i < steps; i++) {
      const result = await step.run(`embed-batch-${i}`, async () => {
        const { data, error } = await sb
          .from('kb_chunks')
          .select('id, content')
          .eq('document_id', documentId)
          .is('embedding', null)
          .order('chunk_index', { ascending: true })
          .limit(CHUNKS_PER_EMBED_STEP);
        if (error) throw new Error(`Could not read chunks to embed: ${error.message}`);

        const rows = (data ?? []) as Array<{ id: string; content: string }>;
        if (rows.length === 0) return { done: 0, halted: null as string | null };

        let written = 0;
        const run = await embedInBatches(
          rows.map((r) => r.content),
          async ({ start, vectors, usage }) => {
            // Written BEFORE the next request goes out. This await is the whole
            // guarantee: money already spent is in the database before any more
            // is spent.
            for (let k = 0; k < vectors.length; k++) {
              const row = rows[start + k];
              if (!row) continue;
              const { error: writeError } = await sb
                .from('kb_chunks')
                .update({ embedding: vectors[k], embedding_model: modelId })
                .eq('document_id', documentId)
                .eq('id', row.id);
              if (writeError) throw new Error(`Could not store embeddings: ${writeError.message}`);
            }
            written += vectors.length;
            await recordEmbeddingUsage(sb, {
              organizationId,
              documentId,
              source: 'ingest',
              usage,
            });
          },
        );

        if (run.failure) {
          // The distinction that stops this from being expensive twice. A
          // missing key, a rejected key or an exhausted quota fails identically
          // on every attempt; throwing would spend the function's retry budget
          // reconfirming it, and against a spent quota it would spend money
          // doing so. Those halt, the chunks stay stored and unvectorised, and
          // kb-reindex-embeddings finishes the job once ops acts. Only genuinely
          // transient failures are worth an Inngest retry.
          if (!run.failure.retryable) return { done: written, halted: run.failure.reason };
          if (written > 0) {
            logger.warn('ingest: embedding interrupted, partial batch persisted', {
              documentId,
              written,
              reason: run.failure.reason,
            });
          }
          throw new Error(run.failure.reason);
        }
        return { done: written, halted: null as string | null };
      });

      embedded += result.done;
      if (result.halted) {
        halted = result.halted;
        break;
      }
      if (result.done === 0) break;
    }

    // -----------------------------------------------------------------------
    // 3. Settle the document
    // -----------------------------------------------------------------------
    const settled = await step.run('finalize', async () => {
      const { count } = await sb
        .from('kb_chunks')
        .select('id', { count: 'exact', head: true })
        .eq('document_id', documentId)
        .is('embedding', null);
      const outstanding = count ?? 0;

      if (outstanding > 0) {
        // A missing key is not a reason to lose the document. The text is the
        // expensive part (download, export, parse); the vectors are cheap to add
        // later. Chunks with a null embedding keep the document findable by
        // keyword and hand it to kb-reindex-embeddings, which fills the vectors
        // in and flips the row to `ready` once the key or the quota exists.
        const reason =
          halted ??
          `Quedan ${outstanding} fragmentos sin vector; kb-reindex-embeddings los completa.`;
        await sb
          .from('kb_documents')
          .update({ status: 'pending', error_message: reason })
          .eq('id', documentId);
        return { ok: true, chunks: chunkCount, embedded, awaitingEmbeddings: true, halted };
      }

      await sb
        .from('kb_documents')
        .update({ status: 'ready', error_message: null })
        .eq('id', documentId);
      return { ok: true, chunks: chunkCount, embedded };
    });

    // -----------------------------------------------------------------------
    // 4. Read it as a BUSINESS document — its own step, for the same reason
    // -----------------------------------------------------------------------
    // Two model calls over the whole text (classify, then extract), which makes
    // this the second most expensive thing in the function after transcription.
    // It gets its own `step.run` so an Inngest retry of anything around it never
    // buys those calls again, exactly as section 2 does for the embeddings —
    // `embedding-cost-guard.test.ts` lists `extractDocumentData` among the paid
    // calls and fails CI if it ever appears outside a step.
    //
    // It runs after `finalize` and never before it: the document must already be
    // stored, chunked and marked, because a failure here is not a failure of
    // ingestion. `extractDocumentData` does not throw — it returns its reason —
    // so a model outage leaves a perfectly good searchable document with no
    // structured reading, which is precisely what this codebase looked like
    // before migration 0076. Everything it does write lands `pending`, counts
    // towards nothing, and waits for a person on /documents.
    const extraction = await step.run('extract-document-data', async () => {
      return await extractDocumentData(sb, documentId, { createdBy: null });
    });

    return { ...settled, extraction };
  } catch (err) {
    await sb
      .from('kb_documents')
      .update({ status: 'failed', error_message: (err as Error).message })
      .eq('id', documentId);
    throw err;
  }
};

export const ingestDocument = inngest.createFunction(
  { id: 'ingest-document', retries: 3 },
  { event: 'kb/document.ingest' },
  async (ctx) => ingestDocumentJob(ctx as unknown as JobContext),
);

/** Narrowing helper so the branches above read as prose. */
function terminal(reason: string): PrepareOutcome {
  return { ok: false, terminal: true, reason };
}

/**
 * Replace this document's chunks with `chunks`, unvectorised.
 *
 * Delete-then-insert rather than diff: chunk boundaries move when a source is
 * re-read, so index N is not the same passage it was last time. Both statements
 * live inside the caller's step, so a retry re-does both and lands on the same
 * rows.
 */
async function storeChunks(
  sb: ReturnType<typeof getOrgScopedClient>,
  documentId: string,
  chunks: PendingChunk[],
): Promise<void> {
  await sb.from('kb_chunks').delete().eq('document_id', documentId);
  const { error } = await sb.from('kb_chunks').insert(
    chunks.map((c) => ({
      document_id: documentId,
      chunk_index: c.chunkIndex,
      content: c.content,
      tokens: c.tokens,
      // Vectors arrive in their own steps. Null here is the durable marker of
      // "stored, not yet embedded" that both the reindexer and search already
      // understand (migrations 0057, 0074).
      embedding: null,
      embedding_model: null,
      metadata: c.metadata,
    })),
  );
  if (error) throw new Error(`Could not store chunks: ${error.message}`);
}
