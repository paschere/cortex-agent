import type { FinanceOverview } from '@/lib/finance';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { FinanceHub } from './FinanceHub';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const links = {
  payments: '/payments?workspace=org-1',
  mission: '/management/mission?workspace=org-1',
  integrations: '/integrations?workspace=org-1',
  feed: '/feed?workspace=org-1',
  review: '/chat?prompt=revisar&workspace=org-1',
  sources: '/finance?workspace=org-1#sources',
};

function overview(): FinanceOverview {
  return {
    asOf: '2026-09-07',
    receivables: {
      status: 'available',
      data: {
        byCurrency: [
          {
            currency: 'COP',
            outstanding: 700,
            invoiced: 1000,
            paid: 300,
            openInvoices: 2,
            ageDays: 12,
            overdue: 200,
            overdueInvoices: 1,
          },
        ],
        confirmedInvoices: 2,
        exclusions: {
          unclassifiedInvoices: 2,
          pendingInvoices: 3,
          withoutCurrency: 1,
          disputedPayments: 1,
          unappliedPayments: 1,
        },
        truncated: false,
        guidance: 'Estimación basada en registros confirmados.',
      },
    },
    paymentActivity: {
      status: 'available',
      data: {
        recent: [
          {
            id: 'confirmed',
            kind: 'payment',
            amount: 100,
            currency: 'COP',
            paidOn: '2026-09-01',
            state: 'confirmed',
            clientName: 'Acme',
            invoiceNumber: 'F-1',
          },
          {
            id: 'reported',
            kind: 'payment',
            amount: 90,
            currency: 'COP',
            paidOn: '2026-09-02',
            state: 'reported',
            clientName: 'Beta',
            invoiceNumber: null,
          },
          {
            id: 'disputed',
            kind: 'adjustment',
            amount: 80,
            currency: 'COP',
            paidOn: '2026-09-03',
            state: 'disputed',
            clientName: null,
            invoiceNumber: null,
          },
          {
            id: 'discarded',
            kind: 'reversal',
            amount: 70,
            currency: 'COP',
            paidOn: '2026-09-04',
            state: 'discarded',
            clientName: 'Delta',
            invoiceNumber: null,
          },
        ],
        disputedCount: 1,
        scanLimit: 1000,
        truncated: false,
      },
    },
    upcomingReceivables: {
      status: 'available',
      data: { supported: false, reason: 'No hay saldo por factura.' },
    },
    provenance: {
      scope: 'organization',
      userId: 'user-1',
      sources: ['confirmed_invoice_records', 'counted_linked_payments'],
      caveats: [],
    },
  };
}

describe('FinanceHub', () => {
  it('renders honest states, movement kinds, and scoped destinations', () => {
    const html = renderToStaticMarkup(createElement(FinanceHub, { overview: overview(), links }));
    for (const label of [
      'Confirmado',
      'Reportado',
      'En disputa',
      'Descartado',
      'Abono',
      'Ajuste',
      'Anulación',
    ])
      expect(html).toContain(label);
    for (const href of Object.values(links)) expect(html).toContain(href.replaceAll('&', '&amp;'));
    expect(html).toContain('una etiqueta financiera no cambia los totales');
    expect(html).toContain('Clasificar fuentes');
    expect(html).not.toContain('Pagos confirmados');
  });

  it('shows unavailable sections without presenting zeroes', () => {
    const unavailable: FinanceOverview = {
      ...overview(),
      receivables: { status: 'unavailable', error: 'cartera temporalmente inaccesible' },
      paymentActivity: { status: 'unavailable', error: 'pagos temporalmente inaccesibles' },
      upcomingReceivables: { status: 'unavailable', error: 'proyección inaccesible' },
    };
    const html = renderToStaticMarkup(createElement(FinanceHub, { overview: unavailable, links }));
    expect(html).toContain('No disponible');
    expect(html).toContain('cartera temporalmente inaccesible');
    expect(html).toContain('pagos temporalmente inaccesibles');
    expect(html).not.toContain('$0');
  });
});
