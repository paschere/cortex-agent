import { describe, expect, it } from 'vitest';
import { importSystemPayments } from '../import';
import { claimReceivableNotice, moneyAtRisk, noticeColumn } from '../risk';
import { overdueReceivableInvoices, receivables } from '../store';
import { createPaymentsWorld } from './fake-db';

/**
 * La cartera con un programa contable conectado (0165).
 *
 * Las facturas de Siigo llegan con SU saldo: Siigo ya descontó sus recibos.
 * Lo que se cuida aquí es lo que se rompería sin querer: restarles los pagos
 * otra vez, contar dos veces la factura que además alguien subió en PDF, o
 * llamar «sin atribuir» a un recibo de Siigo que Siigo ya aplicó.
 */

const ORG = 'org-andina';
const TODAY = '2026-10-01';

function siigoInvoice(over: Record<string, unknown> = {}) {
  return {
    id: 'acc-1',
    organization_id: ORG,
    source_system: 'siigo',
    source_ref: 'i-1',
    doc_number: 'FV-2-22',
    client_id: null,
    client_nit: '900123456',
    counterparty_name: 'Coltrans S.A.S.',
    currency: 'COP',
    total: 2_000_000,
    balance: 1_200_000,
    issued_on: '2026-07-15',
    due_on: '2026-08-14',
    annulled: false,
    ...over,
  };
}

function world(seed: Record<string, Array<Record<string, unknown>>> = {}) {
  return createPaymentsWorld(
    {
      clients: [],
      document_extractions: [],
      payments: [],
      payment_reports: [],
      accounting_invoices: [],
      receivable_notices: [],
      commitments: [],
      vehicle_fines: [],
      ...seed,
    },
    ORG,
  );
}

describe('la cartera con Siigo conectado', () => {
  it('una factura vencida de Siigo entra a plata en riesgo con el saldo de Siigo', async () => {
    const w = world({
      accounting_invoices: [
        siigoInvoice(),
        siigoInvoice({ id: 'acc-2', source_ref: 'i-2', doc_number: 'FV-2-23', balance: 0 }),
        siigoInvoice({ id: 'acc-3', source_ref: 'i-3', doc_number: 'FV-2-24', annulled: true }),
        siigoInvoice({
          id: 'acc-4',
          source_ref: 'i-4',
          doc_number: 'FV-2-25',
          due_on: '2026-10-20',
        }),
      ],
    });
    const overdue = await overdueReceivableInvoices(w.db, { today: TODAY });
    expect(overdue).toEqual([
      expect.objectContaining({
        id: 'acc-1',
        source: 'accounting',
        system: 'siigo',
        docNumber: 'FV-2-22',
        balance: 1_200_000,
        daysOverdue: 48,
      }),
    ]);
    const risk = await moneyAtRisk(w.db, { today: TODAY });
    expect(risk.cop.receivablesOverdue).toBe(1_200_000);
    expect(risk.cop.overdueInvoices).toBe(1);
  });

  it('la cartera suma el saldo de Siigo y lo dice en la frase', async () => {
    const w = world({
      accounting_invoices: [
        siigoInvoice(),
        siigoInvoice({
          id: 'acc-4',
          source_ref: 'i-4',
          doc_number: 'FV-2-25',
          due_on: '2026-10-20',
          balance: 300_000,
          total: 300_000,
        }),
      ],
    });
    const result = await receivables(w.db, { today: TODAY });
    expect(result.accountingInvoices).toBe(2);
    expect(result.accountingSystems).toEqual(['siigo']);
    expect(result.byCurrency[0]).toMatchObject({
      currency: 'COP',
      outstanding: 1_500_000,
      paid: 800_000,
      overdue: 1_200_000,
      overdueInvoices: 1,
      openInvoices: 2,
    });
    expect(result.sentence).toContain('traída(s) de Siigo');
  });

  it('la misma factura subida en PDF y confirmada cuenta una sola vez: la del documento', async () => {
    const w = world({
      accounting_invoices: [siigoInvoice()],
      document_extractions: [
        {
          id: 'ext-1',
          organization_id: ORG,
          doc_type: 'invoice',
          financial_role: 'receivable',
          review_state: 'confirmed',
          doc_number: 'FV2-22',
          total_amount: 2_000_000,
          currency: 'COP',
          issued_on: '2026-07-15',
          due_on: '2026-08-14',
        },
      ],
    });
    const overdue = await overdueReceivableInvoices(w.db, { today: TODAY });
    expect(overdue.map((o) => [o.id, o.source])).toEqual([['ext-1', 'document']]);
    const result = await receivables(w.db, { today: TODAY });
    expect(result.accountingInvoices).toBe(0);
    expect(result.byCurrency[0]?.outstanding).toBe(2_000_000);
  });

  it('un recibo de Siigo que nombra una factura de Siigo no se cuenta como «sin atribuir» ni resta otra vez', async () => {
    const w = world({ accounting_invoices: [siigoInvoice()] });
    await importSystemPayments(w.db, {
      system: 'siigo',
      rows: [
        {
          sourceRef: 'rc-1:0',
          amount: 800_000,
          currency: 'COP',
          paidOn: '2026-08-01',
          invoiceNumber: 'FV-2-22',
        },
      ],
    });
    const result = await receivables(w.db, { today: TODAY });
    expect(result.unappliedPayments).toBe(0);
    expect(result.byCurrency[0]?.outstanding).toBe(1_200_000);
    expect(result.sentence).not.toContain('no se pudieron atribuir');
  });

  it('el aviso de mora de una factura de Siigo se reclama por su propia columna, una vez', async () => {
    const w = world({ accounting_invoices: [siigoInvoice()] });
    expect(noticeColumn('accounting')).toBe('accounting_invoice_id');
    expect(noticeColumn(undefined)).toBe('extraction_id');
    const first = await claimReceivableNotice(w.db, {
      invoiceId: 'acc-1',
      stage: 30,
      sentOn: TODAY,
      source: 'accounting',
    });
    expect(first).toBe(true);
    expect(w.tables.receivable_notices?.[0]).toMatchObject({
      accounting_invoice_id: 'acc-1',
      stage: 30,
    });
    expect(w.tables.receivable_notices?.[0]?.extraction_id).toBeUndefined();
  });
});

describe('duplicados entre fuentes, saldos a favor y fechas con hora', () => {
  const confirmed = (over: Record<string, unknown> = {}) => ({
    id: 'ext-1',
    organization_id: ORG,
    doc_type: 'invoice',
    financial_role: 'receivable',
    review_state: 'confirmed',
    doc_number: 'FV-2-22',
    client_id: 'cli-otro',
    counterparty_nit: '800555111',
    total_amount: 500_000,
    currency: 'COP',
    issued_on: '2026-07-15',
    due_on: '2026-08-14',
    ...over,
  });

  it('el mismo número de otro cliente NO es un duplicado: son dos facturas', async () => {
    const w = world({
      accounting_invoices: [siigoInvoice({ client_id: 'cli-coltrans', client_nit: '900123456' })],
      document_extractions: [confirmed()],
    });
    const result = await receivables(w.db, { today: TODAY });
    expect(result.accountingInvoices).toBe(1);
    expect(result.byCurrency[0]?.outstanding).toBe(1_700_000);
  });

  it('la misma factura traída por dos programas cuenta una vez', async () => {
    const w = world({
      accounting_invoices: [
        siigoInvoice(),
        siigoInvoice({ id: 'acc-9', source_system: 'alegra', source_ref: 'a-9' }),
      ],
    });
    const result = await receivables(w.db, { today: TODAY });
    expect(result.accountingInvoices).toBe(1);
    expect(result.byCurrency[0]?.outstanding).toBe(1_200_000);
    const overdue = await overdueReceivableInvoices(w.db, { today: TODAY });
    expect(overdue).toHaveLength(1);
  });

  it('una factura pagada de más se cuenta aparte y no esconde la deuda de otra', async () => {
    const w = world({
      document_extractions: [
        confirmed({ id: 'ext-a', doc_number: 'FV-1', total_amount: 1_000_000, client_id: null }),
        confirmed({ id: 'ext-b', doc_number: 'FV-2', total_amount: 400_000, client_id: null }),
      ],
      payments: [
        {
          id: 'p-1',
          organization_id: ORG,
          kind: 'payment',
          amount: 1_100_000,
          currency: 'COP',
          paid_on: '2026-08-20',
          extraction_id: 'ext-a',
          invoice_number: 'FV-1',
          state: 'confirmed',
        },
      ],
    });
    const result = await receivables(w.db, { today: TODAY });
    const cop = result.byCurrency[0];
    expect(cop?.outstanding).toBe(400_000);
    expect(cop?.creditInvoices).toBe(1);
    expect(cop?.creditBalance).toBe(100_000);
    expect(result.sentence).toContain('saldo a favor del cliente');
  });

  it('un vencimiento escrito con hora sigue contando como vencido', async () => {
    const w = world({
      document_extractions: [
        confirmed({ client_id: null, due_on: '2026-08-14T00:00:00Z', total_amount: 750_000 }),
      ],
    });
    const overdue = await overdueReceivableInvoices(w.db, { today: TODAY });
    expect(overdue).toHaveLength(1);
    expect(overdue[0]?.daysOverdue).toBe(48);
  });
});
