import { createOrgScopedClient } from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';
import {
  type Tables,
  createFakeSupabase,
} from '../../../../packages/agent-tools/src/tenancy/__tests__/fake-postgrest';
import { readFinanceOverview } from './overview';

const ACME = 'org-acme';
const GLOBEX = 'org-globex';
const TODAY = '2026-09-07';

function invoice(over: Record<string, unknown> = {}) {
  return {
    id: 'inv-1',
    organization_id: ACME,
    doc_type: 'invoice',
    financial_role: 'receivable',
    review_state: 'confirmed',
    doc_number: 'FV-1',
    client_id: 'client-1',
    counterparty_name: 'Cliente Uno',
    counterparty_nit: null,
    total_amount: 10_000_000,
    currency: 'COP',
    issued_on: '2026-08-01',
    due_on: '2026-08-31',
    ...over,
  };
}

function payment(over: Record<string, unknown> = {}) {
  return {
    id: 'pay-1',
    organization_id: ACME,
    kind: 'payment',
    amount: 2_500_000,
    currency: 'COP',
    paid_on: '2026-09-02',
    client_id: 'client-1',
    client_nit: null,
    client_match_state: 'matched',
    extraction_id: 'inv-1',
    invoice_number: 'FV-1',
    state: 'reported',
    source_count: 1,
    disputed_at: null,
    dispute_note: null,
    resolved_at: null,
    resolved_by: null,
    resolution_note: null,
    created_at: '2026-09-02T12:00:00Z',
    updated_at: '2026-09-02T12:00:00Z',
    ...over,
  };
}

function db(seed: Tables) {
  return createOrgScopedClient(createFakeSupabase(seed).client, ACME);
}

describe('readFinanceOverview', () => {
  it('keeps currencies separate, exposes exclusions, and does not call receivables cash', async () => {
    const overview = await readFinanceOverview(
      db({
        document_extractions: [
          invoice(),
          invoice({ id: 'inv-usd', currency: 'USD', total_amount: 3_000, due_on: '2026-10-01' }),
          invoice({ id: 'pending', review_state: 'pending', total_amount: null }),
          invoice({ id: 'purchase', doc_type: 'purchase_invoice', total_amount: 99_000_000 }),
        ],
        payments: [payment()],
        clients: [{ id: 'client-1', organization_id: ACME, name: 'Cliente Uno' }],
      }),
      { today: TODAY, userId: 'user-1' },
    );

    expect(overview.receivables.status).toBe('available');
    if (overview.receivables.status !== 'available') return;
    expect(overview.receivables.data.byCurrency).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ currency: 'COP', outstanding: 7_500_000 }),
        expect.objectContaining({ currency: 'USD', outstanding: 3_000 }),
      ]),
    );
    expect(overview.receivables.data.confirmedInvoices).toBe(2);
    expect(overview.receivables.data.exclusions.pendingInvoices).toBe(1);
    expect(overview.receivables.data.exclusions.unclassifiedInvoices).toBe(0);
    expect(overview.provenance.caveats.join(' ')).toContain('no es saldo bancario');
    expect(overview.upcomingReceivables).toEqual(
      expect.objectContaining({
        status: 'available',
        data: expect.objectContaining({ supported: false }),
      }),
    );
  });

  it('does not subtract a linked payment whose currency differs from the invoice', async () => {
    const overview = await readFinanceOverview(
      db({
        document_extractions: [invoice()],
        payments: [payment({ currency: 'USD', amount: 2_500 })],
        clients: [],
      }),
      { today: TODAY },
    );

    expect(overview.receivables.status).toBe('available');
    if (overview.receivables.status !== 'available') return;
    expect(overview.receivables.data.byCurrency[0]).toEqual(
      expect.objectContaining({ currency: 'COP', paid: 0, outstanding: 10_000_000 }),
    );
    expect(overview.receivables.data.exclusions.unappliedPayments).toBe(1);
  });

  it('preserves tenant scope for amounts, recent payments, and disputes', async () => {
    const overview = await readFinanceOverview(
      db({
        document_extractions: [
          invoice(),
          invoice({ id: 'foreign-inv', organization_id: GLOBEX, total_amount: 800_000_000 }),
        ],
        payments: [
          payment(),
          payment({ id: 'foreign-pay', organization_id: GLOBEX, state: 'disputed' }),
        ],
        clients: [{ id: 'client-1', organization_id: ACME, name: 'Cliente Uno' }],
      }),
      { today: TODAY },
    );

    expect(overview.receivables.status).toBe('available');
    expect(overview.paymentActivity.status).toBe('available');
    if (
      overview.receivables.status !== 'available' ||
      overview.paymentActivity.status !== 'available'
    )
      return;
    expect(overview.receivables.data.byCurrency[0]?.invoiced).toBe(10_000_000);
    expect(overview.paymentActivity.data.recent.map((row) => row.id)).toEqual(['pay-1']);
    expect(overview.paymentActivity.data.disputedCount).toBe(0);
  });

  it('does not publish a healthy balance when the pending-document count failed', async () => {
    const base = db({ document_extractions: [invoice()], payments: [] });
    const countFailure = {
      from(table: string) {
        const query = base.from(table);
        if (table !== 'document_extractions') return query;
        const select = query.select.bind(query);
        query.select = ((columns: string, options?: { head?: boolean }) => {
          if (!options?.head) return select(columns, options);
          const failed = {
            eq() {
              return failed;
            },
            // biome-ignore lint/suspicious/noThenProperty: models the awaitable PostgREST query in a failure regression.
            then(resolve: (value: unknown) => unknown) {
              return Promise.resolve({
                data: null,
                count: null,
                error: { message: 'private database detail' },
              }).then(resolve);
            },
          };
          return failed;
        }) as typeof query.select;
        return query;
      },
    };
    const overview = await readFinanceOverview(countFailure as never, { today: TODAY });
    expect(overview.receivables).toEqual({
      status: 'unavailable',
      error: 'No se pudo leer la cartera.',
    });
    expect(overview.paymentActivity.status).toBe('available');
    expect(JSON.stringify(overview)).not.toContain('private database detail');
  });

  it('returns unavailable instead of zero when a finance read fails', async () => {
    const broken = {
      from() {
        throw new Error('database offline');
      },
    };
    const overview = await readFinanceOverview(broken as never, { today: TODAY });

    expect(overview.receivables).toEqual({
      status: 'unavailable',
      error: 'No se pudo leer la cartera.',
    });
    expect(overview.paymentActivity).toEqual({
      status: 'unavailable',
      error: 'No se pudo leer la actividad de pagos.',
    });
  });
});
