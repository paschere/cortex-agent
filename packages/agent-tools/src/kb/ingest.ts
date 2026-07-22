import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { chunkText } from './chunker';
import { embed } from './embedder';

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

    const embeddings = await embed(chunks.map((c) => c.content));

    await db.from('kb_chunks').insert(
      chunks.map((c, i) => ({
        document_id: documentId,
        chunk_index: c.chunkIndex,
        content: c.content,
        tokens: c.tokens,
        embedding: embeddings[i],
        metadata: {},
      })),
    );

    await db.from('kb_documents').update({ status: 'ready' }).eq('id', documentId);

    return { documentId, chunks: chunks.length };
  } catch (err) {
    await db
      .from('kb_documents')
      .update({ status: 'failed', error_message: (err as Error).message })
      .eq('id', documentId);
    throw err;
  }
}
