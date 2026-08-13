import { describe, expect, it } from 'vitest';
import { importSystemPayments } from '../import';
import { recordReceiptPayment } from '../receipt';
import { signedAmount } from '../shape';
import {
  listPayments,
  receivables,
  recordPaymentReport,
  reportsFor,
  resolvePaymentDispute,
} from '../store';
import { createPaymentsWorld } from './fake-db';

/**
 * Lo que un pago tiene que aguantar cuando lo cuentan varias fuentes.
 *
 * Cada `describe` de aquí es una de las cinco reglas del diseño, y cada test es
 * la forma concreta en que esa regla se rompería si nadie la sostuviera: la
 * cartera duplicada el día que se conecta el banco, el importe promediado que
 * nadie vuelve a auditar, los dólares sumados a los pesos.
 */

const ORG = 'org-postal';
const ANA = 'user-ana';
const TODAY = '2026-08-13';

const CLIENT = {
  id: 'cli-coltrans',
  organization_id: ORG,
  name: 'Coltrans S.A.S.',
  tax_id: '900123456',
};

/** Una factura ya confirmada por una persona, en el sentido de la 0076. */
function invoice(over: Record<string, unknown> = {}) {
  return {
    id: 'ext-inv-1',
    organization_id: ORG,
    doc_type: 'invoice',
    review_state: 'confirmed',
    doc_number: 'FE-4471',
    client_id: CLIENT.id,
    counterparty_name: 'Coltrans S.A.S.',
    counterparty_nit: '900123456',
    total_amount: 10_000_000,
    currency: 'COP',
    issued_on: '2026-07-01',
    due_on: '2026-07-31',
    ...over,
  };
}

function world(seed: Record<string, Array<Record<string, unknown>>> = {}) {
  return createPaymentsWorld(
    {
      users: [{ id: ANA, organization_id: ORG, name: 'Ana' }],
      clients: [CLIENT],
      document_extractions: [],
      payments: [],
      payment_reports: [],
      ...seed,
    },
    ORG,
  );
}

/** Lo que un extracto bancario diría de un abono. */
function bankRow(over: Record<string, unknown> = {}) {
  return {
    sourceRef: 'TX-887123',
    amount: 4_200_000,
    currency: 'COP',
    paidOn: '2026-07-03',
    clientNit: '900123456',
    ...over,
  };
}

describe('reimportar la misma fuente', () => {
  it('no duplica el pago: el segundo pase no escribe nada y no mueve ni un peso', async () => {
    const w = world();
    const first = await importSystemPayments(w.db, {
      system: 'siigo',
      readAt: '2026-08-13T09:00:00Z',
      rows: [
        bankRow(),
        bankRow({ sourceRef: 'TX-887124', amount: 1_500_000, paidOn: '2026-07-08' }),
      ],
    });
    expect(first.created).toBe(2);
    expect(first.duplicates).toBe(0);
    expect(w.tables.payments).toHaveLength(2);

    // El contador exporta el mismo periodo otra vez, que es lo que pasa de
    // verdad todos los meses.
    const second = await importSystemPayments(w.db, {
      system: 'siigo',
      readAt: '2026-08-14T09:00:00Z',
      rows: [
        bankRow(),
        bankRow({ sourceRef: 'TX-887124', amount: 1_500_000, paidOn: '2026-07-08' }),
      ],
    });
    expect(second.duplicates).toBe(2);
    expect(second.created).toBe(0);
    expect(w.tables.payments).toHaveLength(2);
    expect(w.tables.payment_reports).toHaveLength(2);
  });

  it('rechaza una fila sin referencia en vez de arriesgarse a duplicarla luego', async () => {
    const w = world();
    const result = await importSystemPayments(w.db, {
      system: 'world-office',
      rows: [bankRow({ sourceRef: '' })],
    });
    expect(result.created).toBe(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toContain('referencia');
    expect(w.tables.payments).toHaveLength(0);
  });
});

describe('dos fuentes que hablan del mismo pago', () => {
  it('cuando coinciden suman confianza y no importe: un solo pago, dos fuentes', async () => {
    const w = world({ document_extractions: [invoice()] });

    await recordPaymentReport(w.db, {
      source: { kind: 'manual', userId: ANA },
      amount: 4_200_000,
      currency: 'COP',
      paidOn: '2026-07-03',
      clientId: CLIENT.id,
      extractionId: 'ext-inv-1',
    });
    await importSystemPayments(w.db, {
      system: 'bancolombia',
      readAt: '2026-08-13T09:00:00Z',
      rows: [bankRow({ invoiceNumber: null })],
    });

    // UNA fila de pago. Si fueran dos, la cartera de esta empresa quedaría
    // 4.200.000 más baja el día que se conecte el banco, en silencio.
    expect(w.tables.payments).toHaveLength(1);
    expect(w.tables.payment_reports).toHaveLength(2);

    const [payment] = await listPayments(w.db, {});
    expect(payment?.state).toBe('confirmed');
    expect(payment?.source_count).toBe(2);
    expect(Number(payment?.amount)).toBe(4_200_000);
  });

  it('cuando discrepan el pago queda en disputa y sale de TODAS las cifras', async () => {
    const w = world({ document_extractions: [invoice()] });

    await recordPaymentReport(w.db, {
      source: { kind: 'manual', userId: ANA },
      amount: 4_200_000,
      currency: 'COP',
      paidOn: '2026-07-03',
      clientId: CLIENT.id,
      extractionId: 'ext-inv-1',
    });

    // Antes de la discrepancia el abono ya restaba de la cartera.
    const before = await receivables(w.db, { today: TODAY });
    expect(before.byCurrency[0]?.outstanding).toBe(5_800_000);

    const clash = await importSystemPayments(w.db, {
      system: 'bancolombia',
      readAt: '2026-08-13T09:00:00Z',
      rows: [bankRow({ amount: 4_500_000, invoiceNumber: null })],
    });
    expect(clash.disputed).toBe(1);
    expect(clash.created).toBe(0);

    const [payment] = await listPayments(w.db, { state: 'disputed' });
    expect(payment?.state).toBe('disputed');
    // NI SE PROMEDIA NI GANA EL BANCO POR SER EL BANCO. Lo que estaba escrito
    // sigue escrito; lo que llegó vive en su propio reporte.
    expect(Number(payment?.amount)).toBe(4_200_000);
    expect(payment?.dispute_note).toContain('4200000.00');
    expect(payment?.dispute_note).toContain('4500000.00');

    const reports = await reportsFor(w.db, [payment?.id ?? '']);
    expect(reports.get(payment?.id ?? '')).toHaveLength(2);

    // Y AQUÍ ESTÁ LA REGLA: un pago en disputa no es una cifra menor, NO ESTÁ
    // EN LA CIFRA. La factura vuelve a deberse entera.
    const after = await receivables(w.db, { today: TODAY });
    expect(after.byCurrency[0]?.outstanding).toBe(10_000_000);
    expect(after.disputedPayments).toBe(1);
    expect(after.sentence).toContain('en disputa');
  });

  it('sólo una persona lo devuelve a las cifras', async () => {
    const w = world({ document_extractions: [invoice()] });
    await recordPaymentReport(w.db, {
      source: { kind: 'manual', userId: ANA },
      amount: 4_200_000,
      currency: 'COP',
      paidOn: '2026-07-03',
      clientId: CLIENT.id,
      extractionId: 'ext-inv-1',
    });
    await importSystemPayments(w.db, {
      system: 'bancolombia',
      readAt: '2026-08-13T09:00:00Z',
      rows: [bankRow({ amount: 4_500_000 })],
    });
    const [disputed] = await listPayments(w.db, { state: 'disputed' });

    const resolved = await resolvePaymentDispute(w.db, {
      paymentId: disputed?.id ?? '',
      userId: ANA,
      decision: 'settle',
      amount: 4_500_000,
      note: 'El extracto trae el abono completo; el recibo se escribió a mano mal.',
    });
    expect(resolved.state).toBe('confirmed');
    expect(resolved.resolved_by).toBe(ANA);
    expect(Number(resolved.amount)).toBe(4_500_000);

    const after = await receivables(w.db, { today: TODAY });
    expect(after.byCurrency[0]?.outstanding).toBe(5_500_000);
    expect(after.disputedPayments).toBe(0);
  });

  it('resolver sin decir quién decide es imposible', async () => {
    const w = world();
    await expect(
      resolvePaymentDispute(w.db, { paymentId: 'pay-nope', userId: '', decision: 'discard' }),
    ).rejects.toThrow(/nombre de quien/i);
  });
});

describe('las monedas', () => {
  it('un pago sin moneda se rechaza, y no se asume COP', async () => {
    const w = world();
    await expect(
      recordPaymentReport(w.db, {
        source: { kind: 'manual', userId: ANA },
        amount: 4_200_000,
        currency: '',
        paidOn: '2026-07-03',
        clientId: CLIENT.id,
      }),
    ).rejects.toThrow(/moneda/i);
    // Y no queda nada a medias.
    expect(w.tables.payments).toHaveLength(0);
    expect(w.tables.payment_reports).toHaveLength(0);
  });

  it('nunca se mezclan: dólares y pesos son dos carteras, no una suma', async () => {
    const w = world({
      document_extractions: [
        invoice(),
        invoice({
          id: 'ext-inv-2',
          doc_number: 'FE-4472',
          total_amount: 3_000,
          currency: 'USD',
          issued_on: '2026-07-14',
          due_on: '2026-08-14',
        }),
      ],
    });

    await recordPaymentReport(w.db, {
      source: { kind: 'manual', userId: ANA },
      amount: 4_000_000,
      currency: 'COP',
      paidOn: '2026-07-05',
      clientId: CLIENT.id,
      extractionId: 'ext-inv-1',
    });
    await recordPaymentReport(w.db, {
      source: { kind: 'manual', userId: ANA },
      amount: 1_000,
      currency: 'USD',
      paidOn: '2026-07-20',
      clientId: CLIENT.id,
      extractionId: 'ext-inv-2',
    });

    const result = await receivables(w.db, { today: TODAY });
    const cop = result.byCurrency.find((c) => c.currency === 'COP');
    const usd = result.byCurrency.find((c) => c.currency === 'USD');
    expect(cop?.outstanding).toBe(6_000_000);
    expect(usd?.outstanding).toBe(2_000);
    // Dos cubos, dos edades. Nada suma 6.002.000 de nada.
    expect(result.byCurrency).toHaveLength(2);
    expect(cop?.ageDays).not.toBe(usd?.ageDays);
  });

  it('un abono en otra moneda no empareja con un pago en pesos: son dos hechos', async () => {
    const w = world({ document_extractions: [invoice()] });
    await recordPaymentReport(w.db, {
      source: { kind: 'manual', userId: ANA },
      amount: 4_200_000,
      currency: 'COP',
      paidOn: '2026-07-03',
      clientId: CLIENT.id,
      extractionId: 'ext-inv-1',
    });
    const other = await importSystemPayments(w.db, {
      system: 'siigo',
      readAt: '2026-08-13T09:00:00Z',
      rows: [bankRow({ amount: 4_200_000, currency: 'USD' })],
    });
    // Ni "coincide" (sería contar dólares como pesos) ni "discrepa" (sería
    // comparar dos monedas distintas y llamarlo desacuerdo). Es otro pago.
    expect(other.created).toBe(1);
    expect(other.agreed).toBe(0);
    expect(other.disputed).toBe(0);
    expect(w.tables.payments).toHaveLength(2);
  });
});

describe('una anulación', () => {
  it('es un reporte nuevo que resta, y no borra ni edita el abono original', async () => {
    const w = world({ document_extractions: [invoice()] });
    await recordPaymentReport(w.db, {
      source: { kind: 'manual', userId: ANA },
      amount: 4_200_000,
      currency: 'COP',
      paidOn: '2026-07-03',
      clientId: CLIENT.id,
      extractionId: 'ext-inv-1',
    });
    await recordPaymentReport(w.db, {
      source: { kind: 'manual', userId: ANA },
      kind: 'reversal',
      amount: 4_200_000,
      currency: 'COP',
      paidOn: '2026-07-09',
      clientId: CLIENT.id,
      extractionId: 'ext-inv-1',
      note: 'Cheque devuelto.',
    });

    expect(w.tables.payments).toHaveLength(2);
    const rows = await listPayments(w.db, {});
    expect(rows.map((r) => r.kind).sort()).toEqual(['payment', 'reversal']);
    expect(rows.reduce((sum, r) => sum + signedAmount(r.kind, Number(r.amount)), 0)).toBe(0);

    const result = await receivables(w.db, { today: TODAY });
    expect(result.byCurrency[0]?.outstanding).toBe(10_000_000);
  });
});

describe('la cartera', () => {
  it('se calcula sobre facturas confirmadas y lo dice en la cara', async () => {
    const w = world({
      document_extractions: [
        invoice(),
        invoice({
          id: 'ext-inv-9',
          doc_number: 'FE-9',
          review_state: 'pending',
          total_amount: null,
        }),
        invoice({
          id: 'ext-inv-8',
          doc_number: 'FE-8',
          review_state: 'pending',
          total_amount: null,
        }),
      ],
    });
    const result = await receivables(w.db, { today: TODAY });
    expect(result.confirmedInvoices).toBe(1);
    expect(result.pendingExcluded).toBe(2);
    expect(result.sentence).toContain('sobre 1 factura(s) confirmada(s)');
    expect(result.sentence).toContain('2 factura(s) sin revisar que no entran en la cifra');
  });

  it('no reparte a ciegas un pago que no nombró factura, y dice que no lo restó', async () => {
    const w = world({ document_extractions: [invoice()] });
    await recordPaymentReport(w.db, {
      source: { kind: 'manual', userId: ANA },
      amount: 1_000_000,
      currency: 'COP',
      paidOn: '2026-07-05',
      clientId: CLIENT.id,
    });
    const result = await receivables(w.db, { today: TODAY });
    expect(result.byCurrency[0]?.outstanding).toBe(10_000_000);
    expect(result.unappliedPayments).toBe(1);
    expect(result.sentence).toContain('no se pudieron atribuir a una factura');
  });

  it('envejece ponderando por dinero, no por número de facturas', async () => {
    const w = world({
      document_extractions: [
        invoice({ id: 'ext-a', total_amount: 100_000, issued_on: '2026-08-10' }),
        invoice({ id: 'ext-b', total_amount: 900_000, issued_on: '2026-07-14' }),
      ],
    });
    const result = await receivables(w.db, { today: TODAY });
    // (100.000*3 + 900.000*30) / 1.000.000 = 27,3 -> 27. Una media simple daría 16.
    expect(result.byCurrency[0]?.ageDays).toBe(27);
  });
});

describe('un comprobante de pago confirmado', () => {
  const receipt = {
    id: 'ext-rec-1',
    documentId: 'doc-rec-1',
    docType: 'payment_receipt',
    reviewState: 'confirmed',
    clientId: CLIENT.id,
    clientNit: '900123456',
    clientMatchState: 'matched' as const,
    totalAmount: 4_200_000,
    currency: 'COP',
    issuedOn: '2026-07-03',
  };
  const fields = [
    {
      fieldKey: 'amount_paid',
      reviewState: 'confirmed' as const,
      text: null,
      number: 4_200_000,
      date: null,
      currency: 'COP',
      quote: 'Valor pagado: $4.200.000 pesos colombianos',
      chunkId: 'chunk-1',
    },
    {
      fieldKey: 'invoice_number',
      reviewState: 'confirmed' as const,
      text: 'FE-4471',
      number: null,
      date: null,
      currency: null,
      quote: 'Cancela la factura FE-4471 en su totalidad',
      chunkId: 'chunk-1',
    },
  ];

  it('se convierte en un reporte de origen document, con su cita', async () => {
    const w = world();
    const outcome = await recordReceiptPayment(w.db, { extraction: receipt, fields, userId: ANA });
    expect(outcome.recorded).toBe(true);

    const [report] = w.tables.payment_reports as Array<Record<string, unknown>>;
    expect(report?.source_kind).toBe('document');
    expect(report?.source_document_id).toBe('doc-rec-1');
    expect(String(report?.source_quote).length).toBeGreaterThanOrEqual(8);
    expect(report?.invoice_number).toBe('FE-4471');
    expect(w.tables.payments).toHaveLength(1);
  });

  it('confirmarlo dos veces no registra el pago dos veces', async () => {
    const w = world();
    await recordReceiptPayment(w.db, { extraction: receipt, fields, userId: ANA });
    const again = await recordReceiptPayment(w.db, { extraction: receipt, fields, userId: ANA });
    expect(again.recorded).toBe(false);
    expect(w.tables.payments).toHaveLength(1);
    expect(w.tables.payment_reports).toHaveLength(1);
  });

  it('sin moneda no registra nada, y dice por qué', async () => {
    const w = world();
    const outcome = await recordReceiptPayment(w.db, {
      extraction: { ...receipt, currency: null },
      fields,
      userId: ANA,
    });
    expect(outcome.recorded).toBe(false);
    expect(outcome.reason).toContain('moneda');
    expect(w.tables.payments).toHaveLength(0);
  });

  it('mientras siga pendiente de revisión no mueve ninguna cifra', async () => {
    const w = world();
    const outcome = await recordReceiptPayment(w.db, {
      extraction: { ...receipt, reviewState: 'pending' },
      fields,
      userId: ANA,
    });
    expect(outcome.recorded).toBe(false);
    expect(w.tables.payments).toHaveLength(0);
  });
});
