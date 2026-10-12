import type { GridColumn, GridRow } from '@/components/datagrid/types';
import {
  PAYMENT_KIND_LABEL,
  PAYMENT_STATE_LABEL,
  PAYMENT_STATE_TONE,
  type PaymentKind,
  type PaymentState,
} from '@/lib/payments-shape';
import type { PaymentView } from './types';

/**
 * «Lo que hay registrado» en la tabla compartida: una fila por pago, con el
 * importe como NÚMERO (negativo en una anulación) para que ordene, filtre y
 * sume el pie. Si todos los pagos son de una moneda, la columna es plata en esa
 * moneda; si hay varias, es un número y la moneda va en su propia columna (no se
 * suman monedas distintas como si fueran una).
 */

export function ledgerColumns(payments: readonly PaymentView[]): GridColumn[] {
  const currencies = [...new Set(payments.map((p) => p.currency))];
  const single = currencies.length <= 1;
  return [
    {
      key: 'client',
      label: 'Cliente',
      type: 'text',
      pinned: true,
      primary: true,
      editable: false,
      width: 220,
    },
    single
      ? {
          key: 'amount',
          label: 'Importe',
          type: 'money',
          currency: currencies[0] ?? 'COP',
          editable: false,
        }
      : { key: 'amount', label: 'Importe', type: 'number', editable: false },
    ...(single
      ? []
      : ([
          {
            key: 'currency',
            label: 'Moneda',
            type: 'select',
            editable: false,
            width: 100,
            options: currencies.map((value) => ({ value })),
          },
        ] satisfies GridColumn[])),
    { key: 'paidOn', label: 'Fecha', type: 'date', editable: false },
    { key: 'invoice', label: 'Factura', type: 'text', editable: false, width: 140 },
    {
      key: 'state',
      label: 'Estado',
      type: 'status',
      editable: false,
      description: 'Qué tanto se sabe del pago. Sólo el confirmado cuenta como cobrado.',
      options: (Object.keys(PAYMENT_STATE_LABEL) as PaymentState[]).map((value) => ({
        value,
        label: PAYMENT_STATE_LABEL[value],
        tone: PAYMENT_STATE_TONE[value],
      })),
    },
    {
      key: 'kind',
      label: 'Tipo',
      type: 'select',
      editable: false,
      width: 120,
      options: (Object.keys(PAYMENT_KIND_LABEL) as PaymentKind[]).map((value) => ({
        value,
        label: PAYMENT_KIND_LABEL[value],
      })),
    },
    { key: 'sources', label: 'Fuentes', type: 'number', editable: false, width: 90 },
  ];
}

export function ledgerRow(p: PaymentView): GridRow {
  return {
    id: p.id,
    values: {
      client: p.client ?? 'Sin cliente',
      amount: p.amountValue,
      currency: p.currency,
      paidOn: p.paidOnIso,
      invoice: p.invoiceNumber ?? '',
      state: p.state,
      kind: p.kind,
      sources: p.sourceCount,
    },
    locked: true,
  };
}
