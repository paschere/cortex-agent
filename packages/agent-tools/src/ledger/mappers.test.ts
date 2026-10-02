import { describe, expect, it } from 'vitest';
import {
  accountingInvoiceDrafts,
  bankLineDraft,
  documentDraft,
  looksLikeTransfer,
  paymentReportDraft,
} from './adapters';
import { BUILTIN_RULES, type CategoryRule, categorizeByRules, signatureOf } from './categorize';
import {
  type DedupRow,
  counterpartyMatches,
  findLikelyTwin,
  pickPrimary,
  planGroup,
} from './dedup';
import { cashByAccount, dueSummary, monthlySummary, monthsBack, totalsByCategory } from './query';
import { cleanDraft, invoiceLinkKey, normalizeText, sameTaxId } from './shape';
import type { LedgerMovement } from './types';

/**
 * El libro de plata sin base de datos: cómo entra cada fuente, quién pone la
 * categoría, cuándo dos filas son el mismo movimiento y qué suma cada pregunta.
 */

const TODAY = '2026-10-02';

describe('de cada fuente al libro', () => {
  const invoice = {
    id: 'acc-1',
    source_system: 'siigo',
    source_ref: 'inv-88',
    doc_number: 'FE-88',
    client_nit: '900.123.456-7',
    counterparty_name: 'Nexa Logística',
    currency: 'COP',
    total: '5000000',
    balance: '2000000',
    issued_on: '2026-08-01',
    due_on: '2026-08-31',
    annulled: false,
  };

  it('una factura del programa contable es una cuenta por cobrar con el saldo del programa', () => {
    const [receivable, ...rest] = accountingInvoiceDrafts(invoice, {
      bringsPayments: true,
      priorPaid: 0,
      today: TODAY,
    });
    expect(rest).toEqual([]);
    expect(receivable).toMatchObject({
      direction: 'in',
      kind: 'receivable',
      status: 'expected',
      amount: 5_000_000,
      outstanding: 2_000_000,
      dueDate: '2026-08-31',
      counterpartyTaxId: '9001234567',
      linkKey: 'invoice:in:FE88',
      source: { kind: 'accounting', system: 'siigo', ref: 'invoice:inv-88' },
    });
  });

  it('sin pagos del programa, lo cobrado se infiere del saldo, una vez por subida', () => {
    const first = accountingInvoiceDrafts(invoice, {
      bringsPayments: false,
      priorPaid: 0,
      today: TODAY,
    });
    expect(first[1]).toMatchObject({
      kind: 'income',
      status: 'settled',
      amount: 3_000_000,
      date: '2026-08-31',
      source: { ref: 'paid:inv-88:300000000' },
    });
    // Ya se había visto 3 M; ahora el saldo bajó a 500 mil: entra la subida, hoy.
    const later = accountingInvoiceDrafts(
      { ...invoice, balance: 500_000 },
      { bringsPayments: false, priorPaid: 3_000_000, today: TODAY },
    );
    expect(later[1]).toMatchObject({ amount: 1_500_000, date: TODAY });
    // Nada nuevo cobrado: nada nuevo inferido.
    expect(
      accountingInvoiceDrafts(invoice, {
        bringsPayments: false,
        priorPaid: 3_000_000,
        today: TODAY,
      }),
    ).toHaveLength(1);
  });

  it('anulada no cuenta; pagada queda liquidada', () => {
    expect(
      accountingInvoiceDrafts(
        { ...invoice, annulled: true },
        { bringsPayments: false, priorPaid: 0, today: TODAY },
      ),
    ).toEqual([expect.objectContaining({ status: 'cancelled', outstanding: 0 })]);
    expect(
      accountingInvoiceDrafts(
        { ...invoice, balance: 0 },
        { bringsPayments: true, priorPaid: 0, today: TODAY },
      )[0]?.status,
    ).toBe('settled');
  });

  const report = {
    id: 'rep-1',
    payment_id: 'pay-1',
    kind: 'payment' as const,
    amount: '1200000',
    currency: 'COP',
    paid_on: '2026-09-10',
    client_nit: '900123456',
    invoice_number: 'FE-88',
    reference: 'TRX 991',
    note: null,
    source_kind: 'manual' as const,
    source_system: null,
    source_ref: null,
  };
  const opts = {
    paymentState: 'reported',
    isAccountingSystem: (s: string) => s === 'siigo',
    isBankSystem: (s: string) => s.startsWith('extracto · '),
  };

  it('un pago reportado es un ingreso liquidado con la llave de su pago', () => {
    expect(paymentReportDraft(report, opts)).toMatchObject({
      direction: 'in',
      kind: 'income',
      status: 'settled',
      amount: 1_200_000,
      linkKey: 'payment:pay-1',
      source: { kind: 'payment', system: 'manual', ref: 'report:rep-1' },
    });
    expect(
      paymentReportDraft(
        { ...report, source_kind: 'system', source_system: 'siigo', source_ref: 'RC-7' },
        opts,
      )?.source,
    ).toEqual({ kind: 'accounting', system: 'siigo', ref: 'receipt:RC-7' });
    expect(
      paymentReportDraft(
        {
          ...report,
          source_kind: 'system',
          source_system: 'extracto · bancolombia',
          source_ref: 'h:abc',
        },
        opts,
      )?.source,
    ).toEqual({ kind: 'bank', system: 'extracto · bancolombia', ref: 'h:abc' });
  });

  it('devolución sale; disputa no cuenta; descartado se anula; a la espera no entra', () => {
    expect(paymentReportDraft({ ...report, kind: 'reversal' }, opts)?.direction).toBe('out');
    expect(paymentReportDraft(report, { ...opts, paymentState: 'disputed' })?.excludedReason).toBe(
      'disputed',
    );
    expect(paymentReportDraft(report, { ...opts, paymentState: 'discarded' })?.status).toBe(
      'cancelled',
    );
    expect(paymentReportDraft({ ...report, payment_id: null }, opts)).toBeNull();
  });

  it('el extracto: abonos con la referencia de Pagos, salidas con d:, traslados aparte', () => {
    const line = {
      date: '2026-09-02',
      amount: 1_500_000,
      direction: 'debit' as const,
      description: 'PAGO PSE TRANSPORTES X',
      reference: null,
      nit: null,
      counterparty: null,
      sourceRef: 'h:123',
    };
    const debit = bankLineDraft(line, {
      system: 'extracto · b',
      currency: 'COP',
      accountId: 'acc',
    });
    expect(debit).toMatchObject({
      direction: 'out',
      kind: 'expense',
      accountId: 'acc',
      source: { ref: 'd:h:123' },
    });
    const credit = bankLineDraft(
      { ...line, direction: 'credit' },
      { system: 'extracto · b', currency: 'COP', accountId: 'acc', paymentId: 'pay-9' },
    );
    expect(credit).toMatchObject({
      direction: 'in',
      kind: 'income',
      linkKey: 'payment:pay-9',
      source: { ref: 'h:123' },
    });
    expect(looksLikeTransfer('TRASLADO ENTRE CUENTAS PROPIAS')).toBe(true);
    expect(
      bankLineDraft(
        { ...line, description: 'Traslado a cuenta 4455' },
        { system: 's', currency: 'COP', accountId: null },
      ).kind,
    ).toBe('transfer');
  });

  it('un documento confirmado: por cobrar con lo abonado, por pagar con su proveedor', () => {
    const doc = {
      id: 'ext-1',
      doc_type: 'invoice',
      review_state: 'confirmed',
      financial_role: 'receivable',
      doc_number: 'FV-10',
      counterparty_nit: '800555111',
      counterparty_name: 'Andina',
      total_amount: '1000000',
      currency: 'COP',
      issued_on: '2026-09-01',
      due_on: '2026-10-01',
      created_at: '2026-09-01T00:00:00Z',
    };
    expect(documentDraft(doc, { applied: 400_000, today: TODAY })).toMatchObject({
      kind: 'receivable',
      outstanding: 600_000,
      status: 'expected',
      linkKey: 'invoice:in:FV10',
      source: { kind: 'document', ref: 'extraction:ext-1' },
    });
    expect(documentDraft({ ...doc, financial_role: 'payable' }, { today: TODAY })).toMatchObject({
      direction: 'out',
      kind: 'payable',
      linkKey: 'invoice:out:800555111:FV10',
    });
    expect(documentDraft({ ...doc, review_state: 'pending' }, { today: TODAY })).toBeNull();
    expect(documentDraft({ ...doc, currency: null }, { today: TODAY })).toBeNull();
  });

  it('la limpieza dice en español lo que la base rechazaría', () => {
    const base = paymentReportDraft(report, opts);
    if (!base) throw new Error('falta el borrador');
    expect(() => cleanDraft({ ...base, currency: 'pesos' })).toThrow(/tres letras/);
    expect(() => cleanDraft({ ...base, date: '10/09/2026' })).toThrow(/AAAA-MM-DD/);
    expect(cleanDraft({ ...base, counterpartyTaxId: '12' }).counterpartyTaxId).toBeNull();
  });
});

describe('quién pone la categoría', () => {
  const m = (
    description: string,
    direction: 'in' | 'out' = 'out',
    kind: LedgerMovement['kind'] = 'expense',
  ) => ({
    direction,
    kind,
    description,
    counterpartyName: null,
  });
  const cat = (description: string, rules: CategoryRule[] = []) =>
    categorizeByRules(m(description), rules)?.category ?? null;

  it('las reglas de serie reconocen un extracto colombiano', () => {
    expect(cat('PAGO PILA APORTES EN LINEA')).toBe('nomina');
    expect(cat('PAGO PSE EPM SERVICIOS')).toBe('servicios_publicos');
    expect(cat('Codensa factura 3321')).toBe('servicios_publicos');
    expect(cat('DIAN RETENCION EN LA FUENTE')).toBe('impuestos');
    expect(cat('GMF 4X1000')).toBe('bancos_y_financieros');
    // El cobro del banco con IVA es del banco, no de la DIAN.
    expect(cat('IVA COMISION TRANSFERENCIA')).toBe('bancos_y_financieros');
    expect(cat('Canon de arrendamiento oficina')).toBe('arriendo');
    expect(cat('GOOGLE ADS 8812')).toBe('mercadeo');
    // Frases completas: «ica» no está dentro de «medicamentos».
    expect(cat('MEDICAMENTOS DROGUERIA')).toBeNull();
  });

  it('lo que la fuente ya dice: una factura de venta es venta, una de compra es proveedores', () => {
    expect(categorizeByRules(m('Factura FE-1', 'in', 'receivable'), [])?.category).toBe('ventas');
    expect(categorizeByRules(m('Factura de compra 7', 'out', 'payable'), [])?.category).toBe(
      'proveedores',
    );
    expect(
      categorizeByRules({ ...m('Pago recibido', 'in', 'income'), sourceKind: 'payment' }, [])
        ?.category,
    ).toBe('ventas');
  });

  it('persona > regla de la empresa > regla de serie > (modelo)', () => {
    const orgRule: CategoryRule = {
      id: 'r1',
      field: 'any',
      pattern: 'epm',
      direction: 'any',
      category: 'arriendo',
    };
    // La regla de la empresa gana a la de serie.
    expect(categorizeByRules(m('PAGO EPM'), [orgRule])).toEqual({
      category: 'arriendo',
      source: 'rule',
      ruleId: 'r1',
    });
    // Lo que una persona puso no lo toca nadie.
    expect(
      categorizeByRules({ ...m('PAGO EPM'), category: 'software', categorySource: 'person' }, [
        orgRule,
      ]),
    ).toEqual({ category: 'software', source: 'person', ruleId: null });
    // Nadie lo reconoce: le toca al modelo.
    expect(categorizeByRules(m('XJ-77 SERVICIO VARIO'), [orgRule])).toBeNull();
    // La regla más específica gana.
    const longer: CategoryRule = {
      ...orgRule,
      id: 'r2',
      pattern: 'epm agua',
      category: 'servicios_publicos',
    };
    expect(categorizeByRules(m('PAGO EPM AGUA'), [orgRule, longer])?.ruleId).toBe('r2');
  });

  it('las reglas de serie están normalizadas y la firma ignora los números', () => {
    for (const rule of BUILTIN_RULES) expect(rule.pattern).toBe(normalizeText(rule.pattern));
    expect(signatureOf(m('PAGO PSE 0045123 ACME'))).toBe(signatureOf(m('PAGO PSE 0099 ACME')));
  });
});

describe('un movimiento real, contado una vez', () => {
  const row = (over: Partial<DedupRow>): DedupRow => ({
    id: 'x',
    kind: 'expense',
    direction: 'out',
    status: 'settled',
    amount: 2_000_000,
    currency: 'COP',
    date: '2026-10-01',
    counterpartyName: null,
    counterpartyTaxId: null,
    description: '',
    sourceKind: 'chat',
    linkKey: null,
    duplicateOf: null,
    createdAt: '2026-10-01T10:00:00Z',
    ...over,
  });

  it('manda el banco para la plata; el documento para las facturas; lo anulado nunca', () => {
    expect(
      pickPrimary([
        row({ id: 'a', sourceKind: 'accounting' }),
        row({ id: 'b', sourceKind: 'bank' }),
      ])?.id,
    ).toBe('b');
    expect(
      pickPrimary([
        row({ id: 'a', kind: 'receivable', sourceKind: 'accounting' }),
        row({ id: 'd', kind: 'receivable', sourceKind: 'document' }),
      ])?.id,
    ).toBe('d');
    expect(
      pickPrimary([
        row({ id: 'b', sourceKind: 'bank', status: 'cancelled' }),
        row({ id: 'c', sourceKind: 'chat' }),
      ])?.id,
    ).toBe('c');
    expect(
      planGroup([
        row({ id: 'a', sourceKind: 'accounting' }),
        row({ id: 'b', sourceKind: 'bank', duplicateOf: 'a' }),
      ]),
    ).toEqual([
      { id: 'a', duplicateOf: 'b' },
      { id: 'b', duplicateOf: null },
    ]);
  });

  it('lo dicho en el chat y la salida del banco del mismo pago son gemelos', () => {
    const chat = row({ id: 'chat', counterpartyName: 'Transportes X', description: 'Fletes' });
    const bank = row({
      id: 'bank',
      sourceKind: 'bank',
      date: '2026-10-02',
      description: 'PAGO PSE TRANSPORTES X SAS',
    });
    expect(counterpartyMatches(chat, bank)).toBe(true);
    expect(findLikelyTwin(chat, [bank])?.id).toBe('bank');
  });

  it('sin certeza no enlaza: dos candidatos, otra contraparte, otra llave de pago o fuera de ventana', () => {
    const chat = row({ id: 'chat', counterpartyName: 'Transportes X' });
    const b1 = row({ id: 'b1', sourceKind: 'bank', description: 'PAGO TRANSPORTES X' });
    const b2 = row({ id: 'b2', sourceKind: 'bank', description: 'PAGO TRANSPORTES X' });
    expect(findLikelyTwin(chat, [b1, b2])).toBeNull();
    expect(
      findLikelyTwin(chat, [row({ id: 'o', sourceKind: 'bank', description: 'PAGO ACME' })]),
    ).toBeNull();
    expect(
      findLikelyTwin(row({ ...chat, linkKey: 'payment:1' }), [{ ...b1, linkKey: 'payment:2' }]),
    ).toBeNull();
    expect(findLikelyTwin(chat, [{ ...b1, date: '2026-10-08' }])).toBeNull();
    expect(findLikelyTwin(chat, [{ ...b1, amount: 2_000_001 }])).toBeNull();
  });

  it('el NIT con y sin dígito de verificación es el mismo; las facturas de compra llevan proveedor', () => {
    expect(sameTaxId('900123456', '9001234567')).toBe(true);
    expect(sameTaxId('900123456', '900123457')).toBe(false);
    expect(invoiceLinkKey({ direction: 'out', docNumber: '1' })).toBeNull();
    expect(invoiceLinkKey({ direction: 'out', docNumber: '1', counterpartyName: 'Acme SAS' })).toBe(
      'invoice:out:acmesas:1',
    );
  });
});

describe('las preguntas de plata', () => {
  const mv = (over: Partial<LedgerMovement>): LedgerMovement => ({
    id: Math.random().toString(36).slice(2),
    direction: 'out',
    kind: 'expense',
    status: 'settled',
    amount: 100,
    currency: 'COP',
    date: '2026-09-10',
    description: 'x',
    source: { kind: 'bank', ref: 'r' },
    ...over,
  });
  const book = [
    mv({ direction: 'in', kind: 'income', amount: 1000, category: 'ventas' }),
    mv({ direction: 'out', kind: 'income', amount: 50, category: 'ventas' }), // devolución
    mv({ amount: 300, category: 'nomina' }),
    mv({ amount: 100, category: 'arriendo', date: '2026-08-05' }),
    mv({ amount: 20, category: null }),
    mv({ kind: 'transfer', amount: 999 }),
    mv({
      direction: 'in',
      kind: 'receivable',
      status: 'expected',
      amount: 800,
      outstanding: 500,
      dueDate: '2026-09-30',
    }),
    mv({
      kind: 'payable',
      status: 'expected',
      amount: 400,
      outstanding: 400,
      dueDate: '2026-10-05',
    }),
  ];

  it('ingresos, gastos y margen por mes son caja; facturado aparte; traslados fuera', () => {
    const months = monthlySummary(book, { from: '2026-08-01', to: '2026-09-30' });
    expect(months.map((m) => m.month)).toEqual(['2026-08', '2026-09']);
    expect(months[1]).toMatchObject({
      ingresos: 950,
      gastos: 320,
      margen: 630,
      facturado: 800,
      compras: 400,
    });
    expect(months[0]).toMatchObject({ gastos: 100, margen: -100 });
  });

  it('por categoría, con lo que aún no tiene categoría a la vista', () => {
    const out = totalsByCategory(book, 'out');
    expect(out.map((c) => [c.category, c.total])).toEqual([
      ['nomina', 300],
      ['arriendo', 100],
      ['sin_categoria', 20],
    ]);
    expect(out[0]?.label).toBe('Nómina y seguridad social');
  });

  it('lo que vence: saldo pendiente, vencido o por venir', () => {
    const due = dueSummary(book, TODAY);
    expect(due.receivable.overdue).toBe(500);
    expect(due.payable.next7).toBe(400);
    expect(due.items[0]?.daysToDue).toBe(-2);
  });

  it('la caja por cuenta dice si el saldo es viejo; los meses hacia atrás', () => {
    const cash = cashByAccount(
      [
        {
          id: 'a',
          name: 'Bancolombia',
          currency: 'COP',
          balance: 10,
          balanceAt: '2026-09-01',
          source: { kind: 'bank', ref: 'a' },
        },
        {
          id: 'b',
          name: 'Caja menor',
          currency: 'COP',
          balance: 5,
          balanceAt: TODAY,
          source: { kind: 'manual', ref: 'b' },
        },
      ],
      TODAY,
    );
    expect(cash.totals).toEqual([{ currency: 'COP', total: 15 }]);
    expect(cash.lines.find((l) => l.name === 'Bancolombia')?.stale).toBe(true);
    expect(monthsBack(TODAY, 3)).toBe('2026-08-01');
    expect(monthsBack('2026-02-10', 3)).toBe('2025-12-01');
  });
});
