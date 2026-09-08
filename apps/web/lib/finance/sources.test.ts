import { describe, expect, it } from 'vitest';
import type { FinanceSource } from './sources';
import { summarizeFinanceSources } from './sources';

function source(over: Partial<FinanceSource> = {}): FinanceSource {
  return {
    extractionId: 'e1',
    documentId: 'd1',
    title: 'Factura',
    docType: 'invoice',
    reviewState: 'confirmed',
    sourceDomains: ['financial'],
    financialRole: 'unclassified',
    amount: 100,
    currency: 'COP',
    counterpartyName: null,
    issuedOn: null,
    classificationQuote: 'FACTURA ELECTRÓNICA',
    updatedAt: '2026-09-07T12:00:00Z',
    sourceHref: '/kb?document=d1',
    ...over,
  };
}

describe('summarizeFinanceSources', () => {
  it('keeps unclassified legacy invoices out and purchases separate from receivables', () => {
    const summary = summarizeFinanceSources([
      source(),
      source({ extractionId: 'e2', financialRole: 'receivable', amount: 500 }),
      source({ extractionId: 'e3', financialRole: 'payable', amount: 300 }),
      source({ extractionId: 'e4', financialRole: 'payable', reviewState: 'pending', amount: 900 }),
    ]);
    expect(summary).toEqual({
      unclassified: 1,
      receivableConfirmed: 1,
      payableConfirmed: 1,
      payableByCurrency: [{ currency: 'COP', amount: 300, documents: 1 }],
    });
  });

  it('never mixes purchase currencies', () => {
    const summary = summarizeFinanceSources([
      source({ financialRole: 'payable', amount: 300, currency: 'COP' }),
      source({ extractionId: 'e2', financialRole: 'payable', amount: 10, currency: 'USD' }),
    ]);
    expect(summary.payableByCurrency).toEqual([
      { currency: 'COP', amount: 300, documents: 1 },
      { currency: 'USD', amount: 10, documents: 1 },
    ]);
  });
});
