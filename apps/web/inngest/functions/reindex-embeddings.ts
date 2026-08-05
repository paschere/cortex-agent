import { inngest } from '@/lib/inngest';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { embedInBatches, embeddingModelId } from '@cortex/agent-tools/src/kb/embedder';
import { recordEmbeddingUsage } from '@cortex/agent-tools/src/kb/embedding-usage';
import { logger } from '@cortex/core';

/**
 * Re-vectorises Brain Knowledge chunks that have no usable embedding.
 *
 * WHAT PUTS A CHUNK HERE. Two things now, and the second is new. The first is
 * `embedding is null`: migration 0057 cleared every Gemini vector when the column
 * moved to 1024 dimensions, 0074 cleared every voyage-3-large vector when the
 * default model changed, and every ingestion path deliberately stores chunks
 * unvectorised rather than losing the text when there is no key or no quota. The
 * second is `embedding_model <> the configured model`: since 0074 every vector
 * says what wrote it, and a vector from a model this deployment is no longer
 * pointed at is not a vector at all as far as search is concerned — it is
 * unreachable, because `kb_search_scoped` filters on the same column.
 *
 * That second condition is what makes changing embedding provider an operation
 * rather than an accident. Flip `EMBEDDING_PROVIDER` or `EMBEDDING_MODEL`, and
 * within fifteen minutes this job has started re-embedding the corpus into the
 * new space while search quietly runs keyword-only on anything not yet
 * converted. Nothing ever ranks one model's vectors against another's.
 *
 * There is still no queue table and no cursor to keep in step with reality — the
 * work item IS the row, so a run that dies halfway leaves exactly the unfinished
 * rows behind and the next run picks them up.
 *
 * WHY IT RE-EMBEDS TEXT INSTEAD OF RE-INGESTING. `kb/document.ingest` re-does
 * the whole pipeline: download from storage or export from Drive, parse, chunk,
 * embed. All of that is unchanged by an embedding-model switch, and for a note
 * saved through kb.create_document there is no source file to re-fetch at all —
 * `kb_chunks.content` is the only copy. So the ingestion function stays the
 * owner of "turn a source into chunks" and this one owns "turn chunks into
 * vectors", with no overlap to keep in sync.
 *
 * WHY IT RUNS UNSCOPED, AND WHY THAT IS SAFE. This is the one job that
 * deliberately works across every workspace at once, on the raw service-role
 * client. "Which chunks have no usable vector" is a property of the install, not
 * of a tenant, and there is no session behind a cron to scope it to. It is also
 * the only job that reads `kb_chunks` without naming a document — which the
 * scoped client would refuse, correctly, since kb_chunks inherits its workspace
 * from kb_documents (migration 0064 § 12).
 *
 * Nothing here can cross a boundary: every row is read by id, written back by
 * the same id, and the only columns that change are `embedding` and
 * `embedding_model`. No content moves, nothing is returned to a caller, and no
 * row changes owner. The workspace is read alongside each row for one purpose
 * only — attributing the spend to the workspace that incurred it.
 *
 * WHY A CRON AS WELL AS AN EVENT. After a dimension or model migration the KB is
 * dark until something drains the backlog, and "someone remembers to trigger the
 * job" is not a recovery plan — nor is it one for the day an embedding key is
 * finally added to a deployment that has been storing chunks unvectorised. With
 * nothing to do the run is a single counting query.
 *
 * WHY THIS FUNCTION IS THE ONE TO BE CAREFUL WITH. It is install-wide and it is
 * on a timer, so it is the job with the largest possible bill if anything makes
 * it run hot. Three things bound it, all of them deliberate: `concurrency: 1` so
 * two runs can never buy the same rows twice, MAX_BATCHES_PER_RUN so one
 * invocation is bounded, and — the one that actually matters — every paid
 * request is written to the database the moment it returns, so nothing is ever
 * bought twice by a retry.
 */

/** Frequent enough that a fresh backlog clears within the hour, idle enough to cost nothing. */
const REINDEX_CRON = '*/15 * * * *';

/**
 * Chunks claimed per step. The embedder re-plans this into real provider
 * requests and persists each one as it lands, so this number trades Inngest
 * steps against round trips and never against money.
 */
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
  kb_documents: { organization_id: string | null } | null;
}

export const reindexEmbeddings = inngest.createFunction(
  {
    id: 'kb-reindex-embeddings',
    // One drainer at a time. The cron and a manual event can easily overlap,
    // and two runs selecting the same "next 128 stale rows" would embed every
    // one of them twice and pay for it twice.
    concurrency: { limit: 1 },
    retries: 3,
  },
  [{ event: 'kb/embeddings.reindex' }, { cron: REINDEX_CRON }],
  async ({ step }) => {
    const sb = getSupabaseServiceClient();
    const modelId = embeddingModelId();

    // "No vector, or a vector from a model we no longer use." Both are work, and
    // both are invisible to search until this job clears them.
    const staleFilter = `embedding.is.null,embedding_model.is.null,embedding_model.neq.${modelId}`;

    const pending = await step.run('count-pending', async () => {
      const { count, error } = await sb
        .from('kb_chunks')
        .select('id', { count: 'exact', head: true })
        .or(staleFilter);
      if (error) throw new Error(`Could not count unvectorised chunks: ${error.message}`);
      return count ?? 0;
    });

    if (pending === 0) return { pending: 0, embedded: 0, model: modelId };

    logger.info({ pending, model: modelId }, 'kb-reindex: starting');

    let embedded = 0;
    let halted: string | null = null;

    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
      const result = await step.run(`embed-batch-${batch}`, async () => {
        // Re-queried every batch rather than paginated: rows leave the result
        // set precisely because they were just embedded, so "the first 128 that
        // are still stale" is always the right next page, and a batch that
        // failed half-way is simply still there, minus what it finished.
        const { data, error } = await sb
          .from('kb_chunks')
          .select(
            'id, document_id, chunk_index, content, tokens, metadata, kb_documents!inner(organization_id)',
          )
          .or(staleFilter)
          .order('id', { ascending: true })
          .limit(BATCH_SIZE);
        if (error) throw new Error(`Could not read unvectorised chunks: ${error.message}`);

        const rows = (data ?? []) as unknown as PendingChunk[];
        if (rows.length === 0) return { done: 0, halted: null as string | null };

        let written = 0;
        const run = await embedInBatches(
          rows.map((r) => r.content),
          async ({ start, vectors, usage }) => {
            const slice = rows.slice(start, start + vectors.length);
            // One upsert per PAID REQUEST, awaited before the next request goes
            // out. Every not-null column is carried through so the conflicting
            // rows keep their content, position and metadata exactly as they
            // were — only the two embedding columns are new.
            const { error: writeError } = await sb.from('kb_chunks').upsert(
              slice.map((row, i) => ({
                id: row.id,
                document_id: row.document_id,
                chunk_index: row.chunk_index,
                content: row.content,
                tokens: row.tokens,
                metadata: row.metadata ?? {},
                embedding: vectors[i],
                embedding_model: usage.modelId,
              })),
              { onConflict: 'id' },
            );
            if (writeError) throw new Error(`Could not store embeddings: ${writeError.message}`);
            written += slice.length;

            // Attribute the spend to whoever's documents were embedded. A batch
            // can span workspaces, so it is split rather than charged to
            // whichever one happened to sort first.
            const perOrg = new Map<string, number>();
            for (const row of slice) {
              const org = row.kb_documents?.organization_id;
              if (org) perOrg.set(org, (perOrg.get(org) ?? 0) + 1);
            }
            for (const [organizationId, texts] of perOrg) {
              await recordEmbeddingUsage(sb, {
                organizationId,
                source: 'reindex',
                usage: {
                  ...usage,
                  texts,
                  // The provider bills the request once; splitting the token
                  // count by share of the batch keeps the workspace totals
                  // honest without inventing a second request.
                  tokens: Math.round((usage.tokens * texts) / Math.max(1, slice.length)),
                  requests: 1,
                },
              });
            }
          },
        );

        if (run.failure) {
          // A missing key, a rejected key or an exhausted quota is not a
          // transient fault: retrying burns the function's retry budget to be
          // told the same thing, floods the log with the same sentence, and —
          // against a spent quota — spends money to learn nothing. Report it and
          // stop; the cron finds the work again once ops acts. Rate limits and
          // outages still throw, because those a retry can genuinely fix.
          if (!run.failure.retryable) return { done: written, halted: run.failure.reason };
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
      logger.info({ embedded, of: pending }, 'kb-reindex: batch complete');
    }

    // A document is only searchable again once EVERY one of its chunks carries a
    // vector from the model search is asking questions with, so this runs after
    // the batches rather than per batch — and takes the model, so a document
    // still holding a previous provider's vectors is not called ready.
    const readied = await step.run('mark-documents-ready', async () => {
      const { data, error } = await sb.rpc('kb_mark_reindexed_documents', {
        p_embedding_model: modelId,
      });
      if (error) throw new Error(`Could not settle document status: ${error.message}`);
      return (data as number | null) ?? 0;
    });

    const remaining = await step.run('count-remaining', async () => {
      const { count } = await sb
        .from('kb_chunks')
        .select('id', { count: 'exact', head: true })
        .or(staleFilter);
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

    logger.info({ embedded, readied, remaining, halted, model: modelId }, 'kb-reindex: finished');
    return { pending, embedded, documentsReady: readied, remaining, halted, model: modelId };
  },
);
