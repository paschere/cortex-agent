import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { chunkText } from './chunker';
import { embedDocuments } from './embedder';

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

    // Indexed as documents, never as queries — see the note on asymmetry in
    // embedder.ts. Failures come back rather than thrown, so the reason ends up
    // in error_message, which is the sentence the person actually reads.
    const embedded = await embedDocuments(chunks.map((c) => c.content));
    if (!embedded.ok && embedded.configured) throw new Error(embedded.reason);

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

    return { documentId, chunks: chunks.length };
  } catch (err) {
    await db
      .from('kb_documents')
      .update({ status: 'failed', error_message: (err as Error).message })
      .eq('id', documentId);
    throw err;
  }
}
