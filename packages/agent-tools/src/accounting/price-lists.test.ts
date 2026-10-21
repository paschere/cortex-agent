import { describe, expect, it } from 'vitest';
import { buildInvoiceDraft } from '../apps/automations/invoice-draft';
import { buildListPriceLookup } from './price-lists';

const lookup = buildListPriceLookup([
  { codigo: 'CAF1', lista: 'Mayorista', posicion: 2, precio: 9000 },
  { codigo: 'CAF1', lista: 'Detal', posicion: 1, precio: 12000 },
]);

describe('precios por lista en la prefactura', () => {
  it('busca por nombre o por posición, sin distinguir mayúsculas', () => {
    expect(lookup('caf1', 'MAYORISTA')).toBe(9000);
    expect(lookup('CAF1', '1')).toBe(12000);
    expect(lookup('CAF1', 'Distribuidor')).toBeUndefined();
  });

  const base = {
    customer: { taxId: '900111222' },
    currency: 'COP',
    paymentForm: 'contado' as const,
    paymentDays: 0,
    ctx: { after: { lista: 'Mayorista' }, before: null, label: 'x', labels: {} } as never,
    listPrice: lookup,
  };

  it('el precio sale de la lista (también la que trae el cliente) y manda sobre el de respaldo', () => {
    const r = buildInvoiceDraft({
      ...base,
      items: [
        { description: 'Café', productCode: 'CAF1', quantity: 10, unitPrice: 15000, priceList: '{{lista}}', taxRate: 'iva_19' },
      ],
    });
    expect(r.ok && r.draft.lines[0]?.unitPrice).toBe(9000);
  });

  it('si el producto no tiene precio en esa lista usa el de respaldo; sin respaldo, avisa', () => {
    const fallback = buildInvoiceDraft({
      ...base,
      items: [{ description: 'X', productCode: 'ZZZ', quantity: 1, unitPrice: 5000, priceList: 'Mayorista', taxRate: 'iva_19' }],
    });
    expect(fallback.ok && fallback.draft.lines[0]?.unitPrice).toBe(5000);
    const none = buildInvoiceDraft({
      ...base,
      items: [{ description: 'X', productCode: 'ZZZ', quantity: 1, unitPrice: 'lista', priceList: 'Mayorista', taxRate: 'iva_19' }],
    });
    expect(none.ok).toBe(false);
    expect(!none.ok && none.reason).toContain('no tiene precio en la lista');
  });
});
