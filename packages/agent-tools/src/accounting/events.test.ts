import { describe, expect, it } from 'vitest';
import { accountingEventTableSlug, accountingSlugParts, detectAccountingEvents } from './events';

describe('sucesos contables derivados de antes y después', () => {
  it('una factura nueva y una factura que queda pagada', () => {
    expect(detectAccountingEvents('invoices', 'row_created', null, { estado: 'Por cobrar' })).toEqual(['invoice_created']);
    expect(
      detectAccountingEvents('invoices', 'row_updated', { estado: 'Por cobrar', saldo: 100 }, { estado: 'Pagada', saldo: 0 }),
    ).toEqual(['invoice_paid']);
  });
  it('una factura de contado nace pagada: cuenta como creada y pagada', () => {
    expect(detectAccountingEvents('invoices', 'row_created', null, { estado: 'Pagada' })).toEqual(['invoice_created', 'invoice_paid']);
  });
  it('vencida y anulada', () => {
    expect(detectAccountingEvents('invoices', 'row_updated', { estado: 'Por cobrar' }, { estado: 'Vencida' })).toEqual(['invoice_overdue']);
    expect(detectAccountingEvents('invoices', 'row_updated', { estado: 'Vencida' }, { estado: 'Anulada' })).toEqual(['invoice_annulled']);
  });
  it('idempotente: si ya estaba en ese estado no vuelve a salir', () => {
    expect(detectAccountingEvents('invoices', 'row_updated', { estado: 'Pagada' }, { estado: 'Pagada', observaciones: 'x' })).toEqual([]);
  });
  it('una fila cambiada sin su antes no dice nada', () => {
    expect(detectAccountingEvents('invoices', 'row_updated', null, { estado: 'Pagada' })).toEqual([]);
  });
  it('recibos, notas y clientes sólo al crearse', () => {
    expect(detectAccountingEvents('payments', 'row_created', null, {})).toEqual(['receipt_created']);
    expect(detectAccountingEvents('payments', 'row_updated', {}, { valor: 5 })).toEqual([]);
    expect(detectAccountingEvents('credit_notes', 'row_created', null, {})).toEqual(['credit_note_created']);
    expect(detectAccountingEvents('customers', 'row_created', null, {})).toEqual(['customer_created']);
  });
  it('compara sin importar mayúsculas', () => {
    expect(detectAccountingEvents('invoices', 'row_updated', { estado: 'por cobrar' }, { estado: 'PAGADA' })).toEqual(['invoice_paid']);
  });
});

describe('tablas de cada programa', () => {
  it('el nombre de la tabla de cada suceso y el camino de vuelta', () => {
    expect(accountingEventTableSlug('siigo', 'invoice_paid')).toBe('siigo_facturas');
    expect(accountingEventTableSlug('alegra', 'receipt_created')).toBe('alegra_pagos');
    expect(accountingEventTableSlug('siigo', 'credit_note_created')).toBe('siigo_notas_credito');
    expect(accountingEventTableSlug('quickbooks', 'customer_created')).toBe('quickbooks_clientes');
    expect(accountingSlugParts('siigo_facturas')).toEqual({ provider: 'siigo', entity: 'invoices' });
    expect(accountingSlugParts('alegra_clientes')).toEqual({ provider: 'alegra', entity: 'customers' });
    expect(accountingSlugParts('mis_facturas')).toBeNull();
    expect(accountingSlugParts(null)).toBeNull();
  });
});
