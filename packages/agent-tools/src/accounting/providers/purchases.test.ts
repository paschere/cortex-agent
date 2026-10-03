import { describe, expect, it } from 'vitest';
import { normalizeAlegraBill, normalizeQuickbooksBill, normalizeSiigoPurchase } from './purchases';

describe('compras del programa contable (cuentas por pagar, 0181)', () => {
  it('Siigo: el número es el de la factura del proveedor', () => {
    expect(
      normalizeSiigoPurchase({
        id: 'abc',
        name: 'FC-1-22',
        date: '2026-09-28',
        supplier: { identification: '900373115', branch_office: 0 },
        provider_invoice: { prefix: 'FEPA', number: '451' },
        currency: { code: 'COP' },
        total: 2380000,
        balance: 2380000,
        payments: [{ value: 2380000, due_date: '2026-10-28' }],
      }),
    ).toEqual({
      externalId: 'abc',
      number: 'FEPA451',
      date: '2026-09-28',
      dueDate: '2026-10-28',
      supplierName: null,
      supplierTaxId: '900373115',
      total: 2380000,
      balance: 2380000,
      currency: 'COP',
      status: 'open',
    });
    expect(
      normalizeSiigoPurchase({ id: 'x', name: 'FC-1-1', date: '2026-01-01', total: 10, balance: 0 })
        ?.status,
    ).toBe('paid');
    expect(normalizeSiigoPurchase({ id: 'x' })).toBeNull();
  });

  it('Alegra: factura de proveedor con su numeración y estado', () => {
    const bill = normalizeAlegraBill({
      id: 7,
      date: '2026-09-01',
      dueDate: '2026-10-01',
      numberTemplate: { prefix: 'FE', number: '99' },
      provider: { name: 'Inmobiliaria Los Andes', identification: '800111222' },
      total: '5000000',
      balance: 0,
      status: 'closed',
    });
    expect(bill).toMatchObject({
      number: 'FE99',
      supplierTaxId: '800111222',
      status: 'paid',
      currency: 'COP',
    });
    expect(
      normalizeAlegraBill({ id: 8, date: '2026-09-01', total: 1, status: 'void' })?.status,
    ).toBe('annulled');
  });

  it('QuickBooks: Bill con proveedor y saldo', () => {
    expect(
      normalizeQuickbooksBill({
        Id: '12',
        DocNumber: 'INV-5',
        TxnDate: '2026-09-15',
        DueDate: '2026-10-15',
        VendorRef: { value: '3', name: 'Acme Supplies' },
        TotalAmt: 120.5,
        Balance: 20,
        CurrencyRef: { value: 'USD' },
      }),
    ).toMatchObject({
      number: 'INV-5',
      supplierName: 'Acme Supplies',
      balance: 20,
      status: 'open',
      currency: 'USD',
    });
  });
});
