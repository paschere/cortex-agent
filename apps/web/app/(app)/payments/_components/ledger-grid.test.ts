import { aggregate } from '@/lib/datagrid/aggregate';
import { applyView, normalizeView } from '@/lib/datagrid/view';
import { describe, expect, it } from 'vitest';
import { ledgerColumns, ledgerRow } from './ledger-grid';
import type { PaymentView } from './types';

const pay = (over: Partial<PaymentView>): PaymentView => ({
  id: 'p1',
  kind: 'payment',
  kindLabel: 'Abono',
  amount: '$100 COP',
  amountValue: 100,
  currency: 'COP',
  paidOn: '3 jul 2026',
  paidOnIso: '2026-07-03',
  client: 'Acme',
  invoiceNumber: 'F-1',
  state: 'confirmed',
  sourceCount: 2,
  ...over,
});

describe('la tabla de pagos registrados', () => {
  it('una sola moneda: plata en esa moneda; varias: número y columna de moneda', () => {
    const one = ledgerColumns([pay({}), pay({ id: 'p2' })]);
    expect(one.find((c) => c.key === 'amount')?.type).toBe('money');
    expect(one.some((c) => c.key === 'currency')).toBe(false);
    const many = ledgerColumns([pay({}), pay({ id: 'p2', currency: 'USD' })]);
    expect(many.find((c) => c.key === 'amount')?.type).toBe('number');
    expect(many.some((c) => c.key === 'currency')).toBe(true);
  });

  it('suma con signo (la anulación resta) y filtra por estado', () => {
    const payments = [
      pay({ id: 'a', amountValue: 500 }),
      pay({ id: 'b', amountValue: -200, kind: 'reversal' }),
      pay({ id: 'c', amountValue: 50, state: 'disputed' }),
    ];
    const cols = ledgerColumns(payments);
    const rows = payments.map(ledgerRow);
    expect(aggregate(rows, 'amount', 'sum')).toBe(350);
    const view = normalizeView(cols, {
      filters: [{ key: 'state', op: 'in', value: ['disputed'] }],
    });
    expect(applyView(rows, cols, view).rows.map((r) => r.id)).toEqual(['c']);
  });

  it('un pago sin cliente se llama «Sin cliente»', () => {
    expect(ledgerRow(pay({ client: null })).values.client).toBe('Sin cliente');
  });
});
