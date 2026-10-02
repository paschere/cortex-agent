import { describe, expect, it } from 'vitest';
import { trackerFieldsSchema } from '../trackers/schema';
import { listAccountingProviders } from './providers';
import { accountingTableSpec, invoiceValues, paymentRowsFor, receivableFor } from './tables';
import { ACCOUNTING_ENTITIES, type NormalizedInvoice, type NormalizedPayment } from './types';

const ctx = { today: '2026-10-01', customerNames: new Map([['c-1', 'Coltrans S.A.S.']]) };

const invoice: NormalizedInvoice = {
  externalId: 'i-1',
  number: 'FV-2-22',
  date: '2026-07-15',
  dueDate: '2026-08-14',
  customerExternalId: 'c-1',
  customerTaxId: '900123456',
  total: 2_000_000,
  balance: 1_200_000,
  currency: 'COP',
  status: 'open',
  url: `https://documentview.siigo.com/document?data=${'x'.repeat(500)}`,
};

describe('las tablas de un programa contable', () => {
  it('se llaman igual en cualquier programa, con el programa en el nombre y en el slug', () => {
    const siigo = { id: 'siigo', name: 'Siigo', paymentsLabel: 'Recibos de caja' };
    const alegra = { id: 'alegra', name: 'Alegra' };
    expect(accountingTableSpec(siigo, 'invoices')).toMatchObject({
      slug: 'siigo_facturas',
      name: 'Facturas (Siigo)',
    });
    expect(accountingTableSpec(siigo, 'payments').name).toBe('Recibos de caja (Siigo)');
    expect(accountingTableSpec(alegra, 'payments')).toMatchObject({
      slug: 'alegra_pagos',
      name: 'Pagos recibidos (Alegra)',
    });
    expect(
      accountingTableSpec({ id: 'quickbooks', name: 'QuickBooks Online' }, 'customers').slug,
    ).toBe('quickbooks_clientes');
  });

  it('cada tabla es una tabla válida (campos, tope de 20, slug)', () => {
    for (const entity of ACCOUNTING_ENTITIES) {
      const spec = accountingTableSpec({ id: 'quickbooks', name: 'QuickBooks Online' }, entity);
      expect(() => trackerFieldsSchema.parse(spec.fields)).not.toThrow();
      expect(spec.slug).toMatch(/^[a-z][a-z0-9_]{1,47}$/);
    }
  });

  it('una factura vencida dice «Vencida», con el nombre del cliente, y no guarda un enlace cortado', () => {
    const values = invoiceValues(invoice, ctx);
    expect(values).toMatchObject({
      cliente: 'Coltrans S.A.S.',
      estado: 'Vencida',
      saldo: 1_200_000,
    });
    expect(values.enlace).toBeUndefined();
    expect(invoiceValues({ ...invoice, dueDate: '2026-10-20' }, ctx).estado).toBe('Por cobrar');
  });

  it('a la cartera va con su saldo, su NIT en dígitos y el cliente de Cortex si el NIT calza', () => {
    expect(
      receivableFor('siigo', invoice, {
        ...ctx,
        clientIdByNit: new Map([['900123456', 'cli-1']]),
        now: '2026-10-01T12:00:00Z',
      }),
    ).toMatchObject({
      source_system: 'siigo',
      source_ref: 'i-1',
      doc_number: 'FV-2-22',
      client_nit: '900123456',
      client_id: 'cli-1',
      counterparty_name: 'Coltrans S.A.S.',
      balance: 1_200_000,
      due_on: '2026-08-14',
      annulled: false,
    });
  });

  it('un pago va a Pagos una fila por factura, con referencia estable', () => {
    const payment: NormalizedPayment = {
      externalId: 'rc-1',
      number: 'RC-1-9',
      date: '2026-08-01',
      customerTaxId: '900123456',
      amount: 1500,
      currency: 'COP',
      applications: [
        { ref: 'rc-1:0', invoiceNumber: 'FV-2-22', amount: 1000 },
        { ref: 'rc-1:1', invoiceNumber: 'FV-2-23', amount: 500 },
      ],
    };
    expect(paymentRowsFor(payment, 'Siigo')).toEqual([
      expect.objectContaining({
        sourceRef: 'rc-1:0',
        amount: 1000,
        invoiceNumber: 'FV-2-22',
        paidOn: '2026-08-01',
      }),
      expect.objectContaining({ sourceRef: 'rc-1:1', amount: 500, invoiceNumber: 'FV-2-23' }),
    ]);
  });

  it('la pantalla ve los tres programas conectables; QuickBooks entra por Intuit, sin formulario', () => {
    const env = { ...process.env };
    process.env.QUICKBOOKS_CLIENT_ID = '';
    process.env.QUICKBOOKS_CLIENT_SECRET = '';
    try {
      const providers = listAccountingProviders();
      expect(providers.map((p) => [p.id, p.available, p.connect])).toEqual([
        ['siigo', true, 'credentials'],
        ['alegra', true, 'credentials'],
        ['quickbooks', true, 'oauth'],
      ]);
      expect(providers[0]?.credentialFields.map((f) => [f.key, f.secret])).toEqual([
        ['username', false],
        ['access_key', true],
      ]);
      expect(providers[1]?.credentialFields.map((f) => [f.key, f.secret])).toEqual([
        ['email', false],
        ['token', true],
      ]);
      // La llave de QuickBooks (refresh token) nunca es un campo de la pantalla.
      expect(providers[2]?.credentialFields).toEqual([]);
      expect(providers[2]?.setupMissing).toContain('Falta configurar la app de QuickBooks');
      expect(providers[0]?.setupMissing).toBeNull();
      process.env.QUICKBOOKS_CLIENT_ID = 'id';
      process.env.QUICKBOOKS_CLIENT_SECRET = 'secreto';
      expect(listAccountingProviders()[2]?.setupMissing).toBeNull();
    } finally {
      process.env = env;
    }
  });
});
