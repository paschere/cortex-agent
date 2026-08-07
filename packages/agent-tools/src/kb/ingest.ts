import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { checkMeter, isDegraded } from '../billing';
import { chunkText } from './chunker';
import { embedDocuments } from './embedder';
import { recordEmbeddingUsage } from './embedding-usage';

/**
 * What a workspace past its document allowance is told, and what actually
 * happens to its file.
 *
 * The document IS saved. Its text IS stored, and it stays readable and findable
 * by keyword. What it does not get is an embedding, so it is absent from
 * retrieval by meaning until there is room — and `kb-reindex-embeddings`, the
 * drain that already exists for chunks stored without a key, fills it in on its
 * next pass once the plan changes or the month rolls over. Nothing has to be
 * uploaded again.
 *
 * Refusing the upload outright was the alternative and it is indefensible:
 * somebody has already handed us their contract, and losing it to a billing rule
 * is not a trade any plan is worth. See LIMIT_POLICY in ../billing/plans.ts.
 */
export const OVER_DOCUMENT_LIMIT_MESSAGE =
  'Te pasaste del número de documentos de tu plan, así que este quedó guardado pero sin indexar: se puede leer y buscar por palabra, pero todavía no entra en las respuestas. Amplía el plan y se indexa solo.';

/**
 * Ingest in-memory Markdown into the KB synchronously: create the document row,
 * chunk + embed, insert chunks, mark ready. Runtime-agnostic (fetch + db only,
 * no Inngest, no storage download) so it works in both the Next and MCP runtimes.
 * Mirrors apps/web/inngest/functions/ingest-document.ts.
 */
export async function ingestMarkdown(
  db: SupabaseClient,
  {
    collectionId,
    title,
    content,
    uploadedBy,
  }: { collectionId: string; title: string; content: string; uploadedBy: string },
): Promise<{ documentId: string; chunks: number }> {
  const sha256 = createHash('sha256').update(content).digest('hex');

  const { data: doc, error: insertErr } = await db
    .from('kb_documents')
    .insert({
      collection_id: collectionId,
      source: 'upload',
      title,
      mime: 'text/markdown',
      sha256,
      uploaded_by: uploadedBy,
      status: 'pending',
    })
    .select('id')
    .single();
  if (insertErr || !doc) throw new Error(`Failed to create document: ${insertErr?.message}`);

  const documentId = doc.id as string;

  try {
    const chunks = chunkText(content);
    if (chunks.length === 0) throw new Error('No chunks produced');

    // Asked AFTER the row exists, on purpose: the meter counts documents, the
    // trigger on kb_documents has already counted this one, and the question is
    // whether to pay to embed it — not whether to accept it. There is no branch
    // here that loses the customer's text.
    const allowance = await checkMeter(db, 'documents');
    const overLimit = isDegraded(allowance);

    // Indexed as documents, never as queries — see the note on asymmetry in
    // embedder.ts. Failures come back rather than thrown, so the reason ends up
    // in error_message, which is the sentence the person actually reads.
    const embedded = overLimit
      ? ({ ok: false, retryable: false, reason: OVER_DOCUMENT_LIMIT_MESSAGE } as const)
      : await embedDocuments(chunks.map((c) => c.content));
    // Only a genuinely transient failure is worth raising. A missing key, a
    // rejected key and an exhausted quota all fail identically next time, and
    // this function runs inside a user's turn — throwing would turn "your note
    // is saved but not yet searchable by meaning" into an error they cannot act
    // on, and would have the caller retry against a quota that is gone.
    if (!embedded.ok && embedded.retryable) throw new Error(embedded.reason);

    // Somebody asked Cortex to remember something. Losing their text because
    // this deployment has no embedding key would be the wrong trade: the chunks
    // are stored unvectorised, stay findable by keyword, and kb-reindex-embeddings
    // fills them in and marks the document ready once a key exists.
    await db.from('kb_chunks').insert(
      chunks.map((c, i) => ({
        document_id: documentId,
        chunk_index: c.chunkIndex,
        content: c.content,
        tokens: c.tokens,
        embedding: embedded.ok ? embedded.data[i] : null,
        // The model travels with the vector or neither is written. Search
        // filters on this column, so an unstamped vector is an invisible one
        // (migration 0074).
        embedding_model: embedded.ok ? embedded.usage.modelId : null,
        metadata: {},
      })),
    );

    await db
      .from('kb_documents')
      .update(
        embedded.ok
          ? { status: 'ready', error_message: null }
          : { status: 'pending', error_message: embedded.reason },
      )
      .eq('id', documentId);

    // The receipt. `db` is workspace-scoped, so the column fills itself.
    if (embedded.ok) {
      await recordEmbeddingUsage(db, { documentId, source: 'note', usage: embedded.usage });
    }

    return { documentId, chunks: chunks.length };
  } catch (err) {
    await db
      .from('kb_documents')
      .update({ status: 'failed', error_message: (err as Error).message })
      .eq('id', documentId);
    throw err;
  }
}
