import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { FinanceSourcesResult } from './SourceClassification';
import { SourceClassification } from './SourceClassification';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const initial: FinanceSourcesResult = {
  canClassify: true,
  truncated: false,
  summary: {
    unclassified: 1,
    receivableConfirmed: 0,
    payableConfirmed: 1,
    payableByCurrency: [{ currency: 'COP', amount: 250000, documents: 1 }],
  },
  sources: [
    {
      extractionId: 'extract-1',
      documentId: 'document-1',
      title: 'Factura proveedor septiembre.pdf',
      docType: 'Factura',
      reviewState: 'confirmed',
      sourceDomains: ['financial', 'administrative'],
      financialRole: 'payable',
      amount: 250000,
      currency: 'COP',
      counterpartyName: 'Proveedor SAS',
      issuedOn: '2026-09-01',
      classificationQuote: 'Total a pagar: $250.000',
      updatedAt: '2026-09-07T12:00:00Z',
      sourceHref: '/kb?document=document-1&workspace=org-1',
    },
    {
      extractionId: 'extract-2',
      documentId: 'document-2',
      title: 'Informe comercial.docx',
      docType: null,
      reviewState: 'unclassified',
      sourceDomains: ['commercial'],
      financialRole: 'unclassified',
      amount: null,
      currency: null,
      counterpartyName: null,
      issuedOn: null,
      classificationQuote: null,
      updatedAt: '2026-09-07T12:00:00Z',
      sourceHref: '/kb?document=document-2&workspace=org-1',
    },
  ],
};

describe('SourceClassification', () => {
  it('separates consultation, receivables and payables with source evidence', () => {
    const html = renderToStaticMarkup(
      createElement(SourceClassification, {
        initial,
        apiHref: '/api/finance/sources?workspace=org-1',
        extractionHref: '/chat?workspace=org-1',
      }),
    );
    expect(html).toContain('solo una factura confirmada como por cobrar alimenta cartera');
    expect(html).toContain('cuenta por pagar, separada de cartera');
    expect(html).toContain('Total a pagar: $250.000');
    expect(html).toContain('/kb?document=document-1&amp;workspace=org-1');
    expect(html).toContain('1 pendiente');
    expect(html).toContain(
      'Por cobrar y por pagar requieren un documento identificado como factura.',
    );
    expect(html).toMatch(/<option value="receivable" disabled="">Por cobrar<\/option>/);
    expect(html).toMatch(/<option value="payable" disabled="">Por pagar<\/option>/);
  });

  it('explains extraction and disables editing for members', () => {
    const html = renderToStaticMarkup(
      createElement(SourceClassification, {
        initial: { ...initial, canClassify: false, sources: [] },
        apiHref: '/api/finance/sources?workspace=org-1',
        extractionHref: '/chat?workspace=org-1',
      }),
    );
    expect(html).toContain('documentos ya leídos por Cortex');
    expect(html).toContain('Subirlos al Feed por sí solo no los clasifica');
    expect(html).toContain('Solo un administrador del espacio');
  });
});
