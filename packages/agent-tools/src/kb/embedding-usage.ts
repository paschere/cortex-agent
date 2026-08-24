/**
 * What we spent on embeddings, when, and on whose document.
 *
 * WHY THIS EXISTS AND WHAT IT DELIBERATELY IS NOT. The expensive part of this
 * incident was not the price per token. It was that a single upload burned an
 * entire account's credit and NOBODY FOUND OUT until Brain Knowledge stopped
 * indexing. There was no number anywhere that anyone could have looked at on the
 * first day and said "why did one document embed forty thousand tokens four
 * times over?".
 *
 * So this is one row per embedding batch actually paid for, and nothing more. It
 * is not a billing system, it is not reconciled against an invoice, and nothing
 * in the product reads it to make a decision — which is the point. A ledger that
 * gates behaviour has to be correct; a ledger that only has to be LOOKED AT can
 * be append-only, best-effort and impossible to break, and it would still have
 * caught this on day one.
 *
 * NEVER THROWS, NEVER BLOCKS THE WORK. Failing to record what we spent must not
 * fail the ingestion that spent it. The chunks are the product; this is the
 * receipt.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { EmbedUsage } from './embedder';

export const EMBEDDING_USAGE_TABLE = 'kb_embedding_usage';

/** Which pipeline paid. Matches the `source` column's prose in migration 0074. */
export type EmbeddingUsageSource =
  | 'ingest'
  | 'reindex'
  | 'meeting'
  | 'whatsapp'
  | 'note'
  // Outlook mail threads archived into Brain Knowledge (migration 0078).
  | 'outlook'
  // Hilos de Gmail doblados dentro de Brain Knowledge (migración 0121): la
  // carga histórica de un buzón al conectarlo, y el barrido de cada mañana.
  | 'gmail';

export interface RecordEmbeddingUsage {
  /**
   * Omit when `db` is a workspace-scoped handle — it fills the column in itself,
   * and passing an id the handle would override is a way to be quietly wrong.
   * REQUIRED when `db` is the raw service client, as in kb-reindex-embeddings,
   * which is install-wide and has to say which workspace each batch was for.
   */
  organizationId?: string;
  /** Null for work that is not about one document. */
  documentId?: string | null;
  source: EmbeddingUsageSource;
  usage: EmbedUsage;
}

/**
 * Append one receipt. Awaited by callers only so that a slow write cannot
 * interleave with the next paid request; its failure is swallowed.
 */
export async function recordEmbeddingUsage(
  db: SupabaseClient,
  entry: RecordEmbeddingUsage,
): Promise<void> {
  const { usage } = entry;
  if (usage.texts === 0 && usage.requests === 0) return;
  try {
    await db.from(EMBEDDING_USAGE_TABLE).insert({
      ...(entry.organizationId ? { organization_id: entry.organizationId } : {}),
      document_id: entry.documentId ?? null,
      source: entry.source,
      provider: usage.provider,
      model: usage.modelId,
      texts: usage.texts,
      requests: usage.requests,
      tokens: usage.tokens,
      tokens_estimated: usage.estimated,
    });
  } catch {
    // Deliberately silent. See the header: the receipt must never cost the work.
  }
}

export interface EmbeddingSpendDocument {
  documentId: string | null;
  title: string | null;
  tokens: number;
  texts: number;
  requests: number;
  lastAt: string;
}

export interface EmbeddingSpend {
  /** Days the window covers. */
  days: number;
  tokens: number;
  texts: number;
  requests: number;
  /** True when any row in the window was our estimate rather than a reported figure. */
  anyEstimated: boolean;
  /** The heaviest documents in the window, worst first. */
  topDocuments: EmbeddingSpendDocument[];
  /** Models that appear in the window. More than one means a switch happened. */
  models: string[];
}

interface UsageRow {
  document_id: string | null;
  model: string;
  texts: number | null;
  requests: number | null;
  tokens: number | null;
  tokens_estimated: boolean | null;
  created_at: string;
  kb_documents?: { title?: string | null } | null;
}

/**
 * Fold the window into the handful of numbers a person can act on: how much was
 * embedded, by which models, and which documents accounted for it.
 *
 * The aggregation is done here rather than in SQL on purpose. This is a
 * low-traffic advisory screen over a table with one row per batch — a workspace
 * that has embedded a thousand batches in a month is already an anomaly worth
 * seeing — and keeping it in TypeScript means no fourth database function to
 * classify, grant and keep in step with the tenancy registry.
 */
export async function readEmbeddingSpend(
  db: SupabaseClient,
  { days = 30, topN = 5 }: { days?: number; topN?: number } = {},
): Promise<EmbeddingSpend> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const empty: EmbeddingSpend = {
    days,
    tokens: 0,
    texts: 0,
    requests: 0,
    anyEstimated: false,
    topDocuments: [],
    models: [],
  };

  const { data, error } = await db
    .from(EMBEDDING_USAGE_TABLE)
    .select(
      'document_id, model, texts, requests, tokens, tokens_estimated, created_at, kb_documents(title)',
    )
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(2000);
  if (error) return empty;

  const rows = (data ?? []) as unknown as UsageRow[];
  const byDocument = new Map<string, EmbeddingSpendDocument>();
  const models = new Set<string>();
  const total = { ...empty };

  for (const row of rows) {
    const tokens = row.tokens ?? 0;
    const texts = row.texts ?? 0;
    const requests = row.requests ?? 0;
    total.tokens += tokens;
    total.texts += texts;
    total.requests += requests;
    total.anyEstimated ||= row.tokens_estimated === true;
    models.add(row.model);

    const key = row.document_id ?? '';
    const entry = byDocument.get(key);
    if (entry) {
      entry.tokens += tokens;
      entry.texts += texts;
      entry.requests += requests;
    } else {
      byDocument.set(key, {
        documentId: row.document_id,
        title: row.kb_documents?.title ?? null,
        tokens,
        texts,
        requests,
        // Rows arrive newest first, so the first one seen is the latest.
        lastAt: row.created_at,
      });
    }
  }

  total.models = [...models].sort();
  total.topDocuments = [...byDocument.values()].sort((a, b) => b.tokens - a.tokens).slice(0, topN);
  return total;
}
