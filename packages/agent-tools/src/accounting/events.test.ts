import { describe, expect, it } from 'vitest';
import {
  ACCOUNTING_EVENTS,
  accountingEventTableSlug,
  accountingSlugParts,
  detectAccountingEvents,
  stockBecameLow,
} from './events';

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

describe('0234 · compras, pagos a proveedores, cotizaciones y poco inventario', () => {
  it('entra una compra, se registra un pago a proveedor, nueva cotización', () => {
    expect(detectAccountingEvents('purchases', 'row_created', null, { estado: 'Por pagar' })).toEqual(['purchase_created']);
    expect(detectAccountingEvents('supplier_payments', 'row_created', null, { valor: 5 })).toEqual(['supplier_payment_created']);
    expect(detectAccountingEvents('quotations', 'row_created', null, { total: 5 })).toEqual(['quotation_created']);
    // Una compra que cambia de saldo no es una compra nueva.
    expect(detectAccountingEvents('purchases', 'row_updated', { saldo: 5 }, { saldo: 0 })).toEqual([]);
  });
  it('las tablas de los sucesos nuevos se reconocen por su nombre', () => {
    expect(accountingEventTableSlug('siigo', 'purchase_created')).toBe('siigo_compras');
    expect(accountingEventTableSlug('siigo', 'stock_low')).toBe('siigo_existencias');
    expect(accountingSlugParts('siigo_pagos_proveedores')).toEqual({ provider: 'siigo', entity: 'supplier_payments' });
    expect(accountingSlugParts('alegra_cotizaciones')).toEqual({ provider: 'alegra', entity: 'quotations' });
    expect(ACCOUNTING_EVENTS).toContain('stock_low');
  });
  it('producto bajo de existencias con umbral: cruza hacia abajo y no repite', () => {
    const at = (existencias: number) => ({ existencias });
    expect(detectAccountingEvents('stock', 'row_updated', at(12), at(9), { threshold: 10 })).toEqual(['stock_low']);
    expect(detectAccountingEvents('stock', 'row_updated', at(9), at(7), { threshold: 10 })).toEqual([]);
    expect(detectAccountingEvents('stock', 'row_updated', at(12), at(11), { threshold: 10 })).toEqual([]);
    expect(detectAccountingEvents('stock', 'row_updated', at(10), at(10), { threshold: 10 })).toEqual([]);
    expect(detectAccountingEvents('stock', 'row_updated', at(4), at(3), { threshold: 0 })).toEqual([]);
    expect(detectAccountingEvents('stock', 'row_updated', at(4), at(0), { threshold: 0 })).toEqual(['stock_low']);
  });
  it('una fila de existencias nueva que ya nace baja cuenta; sin antes, una fila cambiada no dice nada', () => {
    expect(stockBecameLow(true, null, { existencias: 2 }, 5)).toBe(true);
    expect(stockBecameLow(true, null, { existencias: 20 }, 5)).toBe(false);
    expect(detectAccountingEvents('stock', 'row_updated', null, { existencias: 1 }, { threshold: 5 })).toEqual([]);
  });
  it('sin umbral usa la alerta de la fila (el mínimo de cada producto)', () => {
    expect(
      detectAccountingEvents('stock', 'row_updated', { alerta: 'Con existencias' }, { alerta: 'Bajo mínimo' }),
    ).toEqual(['stock_low']);
    expect(
      detectAccountingEvents('stock', 'row_updated', { alerta: 'Bajo mínimo' }, { alerta: 'Sin existencias' }),
    ).toEqual([]);
    expect(
      detectAccountingEvents('stock', 'row_updated', { alerta: 'Sin existencias' }, { alerta: 'Con existencias' }),
    ).toEqual([]);
  });
});

import { matchesTrigger } from '../apps/automations/match';
import { automationTriggerSchema } from '../apps/automations/spec';

describe('0234 · el disparador «bajo de existencias» con su umbral', () => {
  const event = (before: number, after: number) =>
    ({
      kind: 'row_updated',
      trackerId: 't',
      trackerSlug: 'siigo_existencias',
      rowId: 'r',
      before: { existencias: before },
      after: { existencias: after },
      version: 'v',
      actor: { kind: 'system' },
      chain: [],
      depth: 0,
    }) as never;
  it('el umbral viaja en el disparador y decide cuándo sale', () => {
    const trigger = automationTriggerSchema.parse({ type: 'accounting_event', event: 'stock_low', threshold: 10 });
    expect(trigger).toMatchObject({ provider: 'siigo', threshold: 10 });
    expect(matchesTrigger(trigger, event(12, 9), 'siigo_existencias')).toBe(true);
    expect(matchesTrigger(trigger, event(12, 11), 'siigo_existencias')).toBe(false);
    expect(matchesTrigger(trigger, event(9, 8), 'siigo_existencias')).toBe(false);
  });
  it('los sucesos de compra salen de su tabla y no de otra', () => {
    const trigger = automationTriggerSchema.parse({ type: 'accounting_event', event: 'purchase_created' });
    const created = { ...(event(0, 0) as object), kind: 'row_created', before: null, trackerSlug: 'siigo_compras' } as never;
    expect(matchesTrigger(trigger, created, 'siigo_compras')).toBe(true);
    expect(matchesTrigger(trigger, created, 'siigo_facturas')).toBe(false);
  });
  it('un umbral negativo no es válido', () => {
    expect(automationTriggerSchema.safeParse({ type: 'accounting_event', event: 'stock_low', threshold: -1 }).success).toBe(false);
  });
});
