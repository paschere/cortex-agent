import type { SupabaseClient } from '@supabase/supabase-js';

export type SourceDomain = 'financial' | 'administrative' | 'commercial' | 'operations';
export type FinancialRole = 'unclassified' | 'receivable' | 'payable' | 'reference';

export interface FinanceSource {
  extractionId: string;
  documentId: string;
  title: string;
  docType: string | null;
  reviewState: 'unclassified' | 'pending' | 'confirmed' | 'rejected';
  sourceDomains: SourceDomain[];
  financialRole: FinancialRole;
  amount: number | null;
  currency: string | null;
  counterpartyName: string | null;
  issuedOn: string | null;
  classificationQuote: string | null;
  updatedAt: string;
  sourceHref: string;
}

export interface FinanceSourcesSummary {
  unclassified: number;
  receivableConfirmed: number;
  payableConfirmed: number;
  payableByCurrency: Array<{ currency: string; amount: number; documents: number }>;
}

export interface FinanceSourcesResult {
  sources: FinanceSource[];
  summary: FinanceSourcesSummary;
  canClassify: boolean;
  /** True means summary covers only the visible rows returned, not the whole workspace. */
  truncated: boolean;
}

type SourceRow = {
  extraction_id: string;
  document_id: string;
  document_title: string;
  doc_type: string | null;
  review_state: FinanceSource['reviewState'];
  source_domains: SourceDomain[];
  financial_role: FinancialRole;
  total_amount: number | string | null;
  currency: string | null;
  counterparty_name: string | null;
  issued_on: string | null;
  classification_quote: string | null;
  updated_at: string;
};

function amount(value: number | string | null): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function summarizeFinanceSources(sources: FinanceSource[]): FinanceSourcesSummary {
  const purchases = new Map<string, { amount: number; documents: number }>();
  for (const source of sources) {
    if (
      source.financialRole !== 'payable' ||
      source.reviewState !== 'confirmed' ||
      source.amount == null ||
      !source.currency
    )
      continue;
    const current = purchases.get(source.currency) ?? { amount: 0, documents: 0 };
    current.amount += source.amount;
    current.documents += 1;
    purchases.set(source.currency, current);
  }
  return {
    unclassified: sources.filter((source) => source.financialRole === 'unclassified').length,
    receivableConfirmed: sources.filter(
      (source) => source.financialRole === 'receivable' && source.reviewState === 'confirmed',
    ).length,
    payableConfirmed: sources.filter(
      (source) => source.financialRole === 'payable' && source.reviewState === 'confirmed',
    ).length,
    payableByCurrency: [...purchases.entries()].map(([currency, total]) => ({
      currency,
      ...total,
    })),
  };
}

export async function readFinanceSources(
  db: SupabaseClient,
  opts: { userId: string; canClassify: boolean; limit?: number },
): Promise<FinanceSourcesResult> {
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 999);
  const { data, error } = await db.rpc('finance_list_sources', {
    p_user_id: opts.userId,
    p_limit: limit + 1,
  });
  if (error) throw error;
  const rows = (data ?? []) as SourceRow[];
  const truncated = rows.length > limit;
  const sources = rows.slice(0, limit).map((row) => ({
    extractionId: row.extraction_id,
    documentId: row.document_id,
    title: row.document_title,
    docType: row.doc_type,
    reviewState: row.review_state,
    sourceDomains: row.source_domains,
    financialRole: row.financial_role,
    amount: amount(row.total_amount),
    currency: row.currency,
    counterpartyName: row.counterparty_name,
    issuedOn: row.issued_on,
    classificationQuote: row.classification_quote,
    updatedAt: row.updated_at,
    sourceHref: `/kb?document=${encodeURIComponent(row.document_id)}`,
  }));
  return {
    sources,
    summary: summarizeFinanceSources(sources),
    canClassify: opts.canClassify,
    truncated,
  };
}
