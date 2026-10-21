import { describe, expect, it } from 'vitest';
import { trackerFieldsSchema } from '../trackers/schema';
import { listAccountingProviders } from './providers';
import {
  accountingTableSpec,
  catalogValues,
  customerValues,
  invoiceValues,
  journalLineValues,
  paymentRowsFor,
  purchaseState,
  receivableFor,
  statementValues,
  stockState,
  valuesFor,
} from './tables';
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
      expect(providers[2]?.setupMissing).toContain('QuickBooks todavía no está habilitado');
      expect(providers[0]?.setupMissing).toBeNull();
      process.env.QUICKBOOKS_CLIENT_ID = 'id';
      process.env.QUICKBOOKS_CLIENT_SECRET = 'secreto';
      expect(listAccountingProviders()[2]?.setupMissing).toBeNull();
    } finally {
      process.env = env;
    }
  });
});

describe('0234 · tablas de compras, egresos, movimientos, existencias, estados y catálogos', () => {
  const siigo = { id: 'siigo', name: 'Siigo' };
  const ctx = { today: '2026-10-21', customerNames: new Map([['s-1', 'Papelería Andina']]) };

  it('cada cosa nueva tiene su tabla siigo_*, con campos legibles y una clave única', () => {
    const slugs = ACCOUNTING_ENTITIES.map((e) => accountingTableSpec(siigo, e).slug);
    expect(new Set(slugs).size).toBe(ACCOUNTING_ENTITIES.length);
    expect(slugs).toEqual(expect.arrayContaining([
      'siigo_compras',
      'siigo_pagos_proveedores',
      'siigo_movimientos_contables',
      'siigo_cotizaciones',
      'siigo_existencias',
      'siigo_estados_financieros',
      'siigo_costo_nomina',
      'siigo_centros_costo',
      'siigo_impuestos',
      'siigo_formas_pago',
      'siigo_bodegas',
      'siigo_tipos_documento',
      'siigo_vendedores',
    ]));
    for (const e of ACCOUNTING_ENTITIES) {
      const spec = accountingTableSpec(siigo, e);
      expect(spec.fields.length).toBeGreaterThan(0);
      expect(spec.fields.length).toBeLessThanOrEqual(20);
      expect(spec.slug.length).toBeLessThanOrEqual(48);
      for (const f of spec.fields) expect(f.label).toMatch(/[a-záéíóúñ]/i);
    }
  });

  it('proveedores y clientes comparten la tabla, filtrable por «Relación»', () => {
    const spec = accountingTableSpec(siigo, 'customers');
    const rel = spec.fields.find((f) => f.key === 'relacion');
    expect(rel?.options).toEqual(['Cliente', 'Proveedor', 'Otro']);
    expect(spec.description).toContain('proveedores');
    expect(customerValues({ externalId: '1', name: 'X', relationship: 'Proveedor' })).toMatchObject({ relacion: 'Proveedor' });
  });

  it('compra: estado Por pagar, Vencida, Pagada o Anulada', () => {
    const base = { externalId: 'p', number: 'F1', date: '2026-09-01', total: 100, currency: 'COP' };
    expect(purchaseState({ status: 'open', balance: 100, dueDate: '2026-12-01' }, '2026-10-21')).toBe('Por pagar');
    expect(purchaseState({ status: 'open', balance: 100, dueDate: '2026-10-01' }, '2026-10-21')).toBe('Vencida');
    expect(purchaseState({ status: 'paid', balance: 0 }, '2026-10-21')).toBe('Pagada');
    expect(purchaseState({ status: 'annulled', balance: 100 }, '2026-10-21')).toBe('Anulada');
    expect(
      valuesFor('purchases', { ...base, balance: 100, status: 'open', supplierExternalId: 's-1', supplierTaxId: '900.373.115-2' } as never, ctx),
    ).toMatchObject({ proveedor: 'Papelería Andina', nit: '9003731152', estado: 'Por pagar', tipo: 'Compra' });
  });

  it('movimiento: débito o crédito en su columna, y la nómina sin tercero', () => {
    const line = {
      externalId: 'j:0',
      journalId: 'j',
      journalNumber: 'CC-1-1',
      date: '2026-09-30',
      account: '2205',
      movement: 'credit' as const,
      value: 70,
    };
    const v = journalLineValues(line, ctx);
    expect(v).toMatchObject({ credito: 70, movimiento: 'Crédito', mes: '2026-09' });
    expect(v.debito).toBeUndefined();
    const conf = journalLineValues({ ...line, confidential: true, partyTaxId: '123', description: 'Ana' }, ctx);
    expect(conf.tercero).toBe('Nómina (confidencial)');
    expect(conf.nit_tercero).toBeUndefined();
    expect(conf.descripcion).toBeUndefined();
  });

  it('existencias: sin existencias, bajo el mínimo (del producto o de la regla) o con existencias', () => {
    expect(stockState(0, 5)).toBe('Sin existencias');
    expect(stockState(4, 5)).toBe('Bajo mínimo');
    expect(stockState(6, 5)).toBe('Con existencias');
    expect(stockState(6, undefined)).toBe('Con existencias');
    expect(stockState(8, undefined, 10)).toBe('Bajo mínimo');
  });

  it('un catálogo y un renglón de estado llevan sus campos', () => {
    expect(catalogValues({ externalId: '1', catalog: 'taxes', name: 'IVA 19%', kind: 'IVA', percentage: 19, active: false })).toEqual({
      nombre: 'IVA 19%',
      tipo: 'IVA',
      porcentaje: 19,
      estado: 'Inactivo',
    });
    expect(
      statementValues({ externalId: 'x', period: '2026-09', statement: 'Balance general', section: 'Activo', name: 'Efectivo', amount: 5, inProgress: true }),
    ).toMatchObject({ periodo: '2026-09', mes: '2026-09-01', en_curso: 'Sí' });
  });
});
