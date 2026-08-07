import type { SupabaseClient } from '@supabase/supabase-js';
import { bogotaToday } from '../commitments/shape';
import { readDocument } from './extract';
import { findByDocument, saveReading } from './store';
import type { DocumentChunk } from './verify';

/**
 * The entry point the ingestion job calls, and the only one it should.
 *
 * IT NEVER THROWS. Extraction is a bonus reading laid on top of a document that
 * is already stored, chunked, embedded and searchable. A model outage, a
 * malformed reply or a document that turns out to be a photograph of a wall must
 * not fail the ingestion that already succeeded — the text is the expensive part
 * and it is already safe. So every failure comes back as `{ok: false, reason}`,
 * gets written onto the row, and the document stays perfectly usable as text.
 *
 * IT IS EXPENSIVE, so its call site matters. Two model calls over a whole
 * document. In `apps/web/inngest/functions/ingest-document.ts` it lives inside
 * its own `step.run`, for exactly the reason the embedding batches do: Inngest
 * re-executes everything OUTSIDE a step on every retry, and a paid call there is
 * paid again on every attempt. `embedding-cost-guard.test.ts` asserts this in CI
 * and lists this function by name.
 *
 * IT IS IDEMPOTENT BY DEFAULT. A document that already has a reading is skipped
 * unless `force` is set, so a retried job does not buy the same two calls twice
 * and does not wipe a reading somebody has already begun reviewing.
 */

export type ExtractionOutcome =
  | { ok: true; skipped: true; reason: string }
  | { ok: true; skipped: false; docType: string | null; fields: number; discarded: number }
  | { ok: false; reason: string };

export async function extractDocumentData(
  db: SupabaseClient,
  documentId: string,
  opts: { today?: string; force?: boolean; createdBy?: string | null } = {},
): Promise<ExtractionOutcome> {
  try {
    if (!opts.force) {
      const existing = await findByDocument(db, documentId);
      if (existing) {
        return { ok: true, skipped: true, reason: 'este documento ya tiene una lectura' };
      }
    }

    const { data, error } = await db
      .from('kb_chunks')
      .select('id, chunk_index, content')
      .eq('document_id', documentId)
      .order('chunk_index', { ascending: true })
      .limit(200);
    if (error) throw error;
    const chunks = (data ?? []) as DocumentChunk[];
    if (chunks.length === 0) {
      return { ok: true, skipped: true, reason: 'el documento no tiene texto indexado' };
    }

    const reading = await readDocument(chunks, opts.today ?? bogotaToday());
    await saveReading(db, { documentId, reading, createdBy: opts.createdBy ?? null });

    return {
      ok: true,
      skipped: false,
      docType: reading.docType,
      fields: reading.fields.length,
      discarded: reading.rejected.length,
    };
  } catch (err) {
    return { ok: false, reason: (err as Error).message ?? 'fallo leyendo el documento' };
  }
}
