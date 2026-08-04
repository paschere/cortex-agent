import { inngest } from '@/lib/inngest';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { embedDocuments } from '@cortex/agent-tools/src/kb/embedder';
import { logger } from '@cortex/core';

/**
 * Re-vectorises Brain Knowledge chunks that have no embedding.
 *
 * WHAT PUTS A CHUNK HERE. Migration 0057 cleared every Gemini vector when the
 * column moved to 1024 dimensions, and the ingestion paths deliberately store
 * chunks unvectorised when no Voyage key is configured rather than losing the
 * text. Both leave the same, self-describing marker: `kb_chunks.embedding is
 * null`. There is no queue table and no cursor to keep in step with reality —
 * the work item IS the row, so a run that dies halfway leaves exactly the
 * unfinished rows behind and the next run picks them up.
 *
 * WHY IT RE-EMBEDS TEXT INSTEAD OF RE-INGESTING. `kb/document.ingest` re-does
 * the whole pipeline: download from storage or export from Drive, parse, chunk,
 * embed. All of that is unchanged by an embedding-model switch, and for a note
 * saved through kb.create_document there is no source file to re-fetch at all —
 * `kb_chunks.content` is the only copy. So the ingestion function stays the
 * owner of "turn a source into chunks" and this one owns "turn chunks into
 * vectors", with no overlap to keep in sync.
 *
 * WHY A CRON AS WELL AS AN EVENT. After a dimension migration the KB is dark
 * until something drains the backlog, and "someone remembers to trigger the
 * job" is not a recovery plan — nor is it one for the day a Voyage key is
 * finally added to a deployment that has been storing chunks unvectorised. With
 * nothing to do the run is a single counting query.
 */

/** Frequent enough that a fresh backlog clears within the hour, idle enough to cost nothing. */
const REINDEX_CRON = '*/15 * * * *';

/** Matches the embedder's per-request ceiling, so one batch is one Voyage call. */
const BATCH_SIZE = 128;

/**
 * A cap on the run, not on the work: whatever is left is handed to a fresh run
 * through the same event, so a large backlog drains across several bounded
 * invocations instead of one that risks the platform's execution limits.
 */
const MAX_BATCHES_PER_RUN = 20;

interface PendingChunk {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  tokens: number;
  metadata: Record<string, unknown> | null;
}

export const reindexEmbeddings = inngest.createFunction(
  {
    id: 'kb-reindex-embeddings',
    // One drainer at a time. The cron and a manual event can easily overlap,
    // and two runs selecting the same "next 128 null rows" would embed every
    // one of them twice and pay for it twice.
    concurrency: { limit: 1 },
    retries: 3,
  },
  [{ event: 'kb/embeddings.reindex' }, { cron: REINDEX_CRON }],
  async ({ step }) => {
    const sb = getSupabaseServiceClient();

    const pending = await step.run('count-pending', async () => {
      const { count, error } = await sb
        .from('kb_chunks')
        .select('id', { count: 'exact', head: true })
        .is('embedding', null);
      if (error) throw new Error(`Could not count unvectorised chunks: ${error.message}`);
      return count ?? 0;
    });

    if (pending === 0) return { pending: 0, embedded: 0 };

    logger.info({ pending }, 'kb-reindex: starting');

    let embedded = 0;
    let halted: string | null = null;

    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
      const result = await step.run(`embed-batch-${batch}`, async () => {
        // Re-queried every batch rather than paginated: rows leave the result
        // set precisely because they were just embedded, so "the first 128 with
        // no vector" is always the right next page, and a batch that failed
        // half-way is simply still there.
        const { data, error } = await sb
          .from('kb_chunks')
          .select('id, document_id, chunk_index, content, tokens, metadata')
          .is('embedding', null)
          .order('id', { ascending: true })
          .limit(BATCH_SIZE);
        if (error) throw new Error(`Could not read unvectorised chunks: ${error.message}`);

        const rows = (data ?? []) as PendingChunk[];
        if (rows.length === 0) return { done: 0, halted: null as string | null };

        const vectors = await embedDocuments(rows.map((r) => r.content));
        if (!vectors.ok) {
          // A missing key is not a transient fault: retrying it burns the
          // function's retry budget and floods the log with the same sentence.
          // Report it and stop; the cron will find the work again once ops acts.
          if (!vectors.configured) return { done: 0, halted: vectors.reason };
          throw new Error(vectors.reason);
        }

        // One upsert instead of 128 updates. Every not-null column is carried
        // through so the conflicting rows keep their content, position and
        // metadata exactly as they were — only `embedding` is new.
        const { error: writeError } = await sb.from('kb_chunks').upsert(
          rows.map((row, i) => ({
            id: row.id,
            document_id: row.document_id,
            chunk_index: row.chunk_index,
            content: row.content,
            tokens: row.tokens,
            metadata: row.metadata ?? {},
            embedding: vectors.data[i],
          })),
          { onConflict: 'id' },
        );
        if (writeError) throw new Error(`Could not store embeddings: ${writeError.message}`);

        return { done: rows.length, halted: null as string | null };
      });

      if (result.halted) {
        halted = result.halted;
        break;
      }
      if (result.done === 0) break;
      embedded += result.done;
      logger.info({ embedded, of: pending }, 'kb-reindex: batch complete');
    }

    // A document is only searchable again once every one of its chunks has a
    // vector, so this runs after the batches rather than per batch.
    const readied = await step.run('mark-documents-ready', async () => {
      const { data, error } = await sb.rpc('kb_mark_reindexed_documents');
      if (error) throw new Error(`Could not settle document status: ${error.message}`);
      return (data as number | null) ?? 0;
    });

    const remaining = await step.run('count-remaining', async () => {
      const { count } = await sb
        .from('kb_chunks')
        .select('id', { count: 'exact', head: true })
        .is('embedding', null);
      return count ?? 0;
    });

    // Hand the tail to a fresh run. Cheaper than a long-running loop and it
    // keeps every invocation inside the same bounded shape.
    if (remaining > 0 && !halted) {
      await step.sendEvent('continue-reindex', {
        name: 'kb/embeddings.reindex',
        data: { continued: true },
      });
    }

    logger.info({ embedded, readied, remaining, halted }, 'kb-reindex: finished');
    return { pending, embedded, documentsReady: readied, remaining, halted };
  },
);
