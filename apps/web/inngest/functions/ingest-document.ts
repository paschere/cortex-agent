import { inngest } from '@/lib/inngest';
import { parseDocument } from '@zipdev/agent-tools/src/kb/parsers';
import { chunkText } from '@zipdev/agent-tools/src/kb/chunker';
import { embed } from '@zipdev/agent-tools/src/kb/embedder';
import { getSupabaseServiceClient } from '@/lib/supabase/service';

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
      await sb
        .from('kb_documents')
        .update({ status: 'ingesting' })
        .eq('id', documentId);
    });

    try {
      // Download from storage (source='upload') or fail for other sources
      let text = '';
      let pages: number | undefined;
      if (doc.source === 'upload') {
        const storagePath = doc.source_ref as string | null;
        if (!storagePath) throw new Error(`Document ${documentId} has no source_ref`);
        const { data: file } = await sb.storage
          .from('kb-uploads')
          .download(storagePath);
        if (!file) throw new Error('File not found in storage');
        const buffer = Buffer.from(await file.arrayBuffer());
        const parsed = await parseDocument(buffer, doc.mime as string);
        text = parsed.text;
        pages = parsed.pages;
      } else {
        throw new Error(`Source ${doc.source} not yet supported`);
      }

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
      await sb
        .from('kb_documents')
        .update({ status: 'ready' })
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
