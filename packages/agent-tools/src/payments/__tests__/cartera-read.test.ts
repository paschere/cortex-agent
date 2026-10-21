import { describe, expect, it } from 'vitest';
import { readCartera } from '../cartera-read';
import { importSystemPayments } from '../import';
import { receivables } from '../store';
import { createPaymentsWorld } from './fake-db';

/**
 * La lectura de la cartera con la forma de lo que hay en producción: facturas de
 * Siigo con «vence» = fecha de la factura, recibos tipo Anticipo que Siigo manda
 * con la línea `due` apuntando al propio recibo, y tablas sincronizadas.
 */

const ORG = 'org-groundflex';
const TODAY = '2026-10-21';

const invoice = (n: number, over: Record<string, unknown> = {}) => ({
  id: `acc-${n}`,
  organization_id: ORG,
  source_system: 'siigo',
  source_ref: `i-${n}`,
  doc_number: `FV-2-${n}`,
  client_id: null,
  client_nit: '901889897',
  counterparty_name: 'CHARTER LINE AIR SOARA SAS',
  currency: 'COP',
  total: 10_000_000,
  balance: 10_000_000,
  issued_on: '2026-10-20',
  due_on: '2026-10-20',
  annulled: false,
  ...over,
});

const tracker = (slug: string) => ({ id: `t-${slug}`, organization_id: ORG, slug });
const row = (slug: string, values: Record<string, unknown>) => ({
  id: `r-${Math.random()}`,
  organization_id: ORG,
  tracker_id: `t-${slug}`,
  label: String(values.numero ?? 'x'),
  values,
});

function world() {
  return createPaymentsWorld(
    {
      clients: [
        {
          id: 'cl-charter',
          organization_id: ORG,
          name: 'Charter Line Air Soara SAS',
          tax_id: '901889897',
          payment_terms_days: null,
        },
      ],
      accounting_invoices: [
        invoice(1),
        invoice(2, { balance: 0 }),
        invoice(3, {
          client_nit: '830045825',
          counterparty_name: 'TRANEXCO S.A.S',
          balance: 2_000_000,
          total: 2_000_000,
        }),
      ],
      document_extractions: [],
      payments: [],
      payment_reports: [],
      trackers: ['siigo_notas_credito', 'siigo_pagos', 'siigo_movimientos_contables'].map(tracker),
      tracker_rows: [
        row('siigo_pagos', { numero: 'RC-1-4', tipo: 'Anticipo', valor: 20_000_000 }),
        row('siigo_notas_credito', {
          numero: 'NC-1-10',
          nit: '830045825',
          cliente: 'TRANEXCO S.A.S',
          fecha: '2026-10-08',
          valor: 440_003.55,
          factura: 'FV-2-9',
        }),
        row('siigo_movimientos_contables', {
          cuenta: '28050501',
          tercero: 'CHARTER LINE AIR SOARA SAS',
          debito: 20_000_000,
          fecha: '2026-09-30',
        }),
        row('siigo_movimientos_contables', {
          cuenta: '13050501',
          tercero: 'CHARTER LINE AIR SOARA SAS',
          credito: 20_000_000,
          fecha: '2026-09-30',
        }),
        row('siigo_movimientos_contables', {
          cuenta: '51050601',
          tercero: 'Nómina (confidencial)',
          debito: 5,
          fecha: '2026-09-30',
        }),
      ],
    },
    ORG,
  );
}

const anticipo = (n: number, amount = 20_000_000) => ({
  sourceRef: `rc-${n}:0`,
  amount,
  currency: 'COP',
  paidOn: '2026-07-30',
  clientNit: '901889897',
  // Lo que manda Siigo en un anticipo: la «factura» es el propio recibo.
  invoiceNumber: `RC-1-${n}`,
  reference: `RC-1-${n}`,
});

describe('readCartera con datos como los de Siigo', () => {
  it('une facturas, recibos y tablas sincronizadas en un solo modelo', async () => {
    const w = world();
    await importSystemPayments(w.db, { system: 'siigo', rows: [anticipo(4)] });
    const m = await readCartera(w.db, { today: TODAY });

    // El saldo es el de Siigo, sin restar el anticipo otra vez.
    expect(m.kpis.outstanding.value).toBe(12_000_000);
    // Nadie escribió plazo: no es «todo vencido», es «sin plazo».
    expect(m.kpis.overdue.value).toBe(0);
    expect(m.noTermInvoices).toBe(2);
    // El recibo es un anticipo ya cruzado (2805 débito 20 M), no un pago sin emparejar.
    expect(m.payments).toHaveLength(1);
    expect(m.payments[0]).toMatchObject({
      role: 'advance',
      advanceStatus: 'crossed',
      number: 'RC-1-4',
    });
    expect(m.unmatched.count).toBe(0);
    // Dos formas de escribir el cliente (id y NIT) son un solo cliente.
    expect(m.clients.map((c) => c.name)).toEqual(['Charter Line Air Soara SAS', 'TRANEXCO S.A.S']);
    expect(m.creditNotes[0]).toMatchObject({ number: 'NC-1-10', clientName: 'TRANEXCO S.A.S' });
    expect(m.clients[0]?.lastPaymentOn).toBe('2026-07-30');
  });

  it('el plazo del cliente convierte «sin plazo» en una fecha de vencimiento', async () => {
    const w = world();
    const client = w.tables.clients?.[0];
    if (client) client.payment_terms_days = 5;
    const m = await readCartera(w.db, { today: TODAY });
    const first = m.invoices.find((i) => i.docNumber === 'FV-2-1');
    expect(first).toMatchObject({
      dueOn: '2026-10-25',
      dueBasis: 'plazo_cliente',
      daysOverdue: -4,
    });
  });

  it('sin tablas sincronizadas la cartera sigue y los recibos quedan «por confirmar»', async () => {
    const w = world();
    w.tables.trackers = [];
    w.tables.tracker_rows = [];
    await importSystemPayments(w.db, { system: 'siigo', rows: [anticipo(4)] });
    const m = await readCartera(w.db, { today: TODAY });
    expect(m.kpis.outstanding.value).toBe(12_000_000);
    expect(m.payments[0]).toMatchObject({ role: 'advance', advanceStatus: 'unknown' });
  });
});

describe('receivables() y los anticipos', () => {
  it('un anticipo no es «pago sin atribuir»: no se busca una factura que no existe', async () => {
    const w = world();
    await importSystemPayments(w.db, { system: 'siigo', rows: [anticipo(4), anticipo(5)] });
    const r = await receivables(w.db, { today: TODAY });
    expect(r.unappliedPayments).toBe(0);
    expect(r.advancePayments).toBe(2);
    expect(r.advanceAmount).toBe(40_000_000);
    expect(r.sentence).not.toContain('no se pudieron atribuir');
    expect(r.sentence).toContain('2 anticipo(s) de clientes');
    expect(r.byCurrency[0]?.outstanding).toBe(12_000_000);
  });

  it('un recibo sin factura y que NO es anticipo sigue contando como sin atribuir', async () => {
    const w = world();
    await importSystemPayments(w.db, {
      system: 'siigo',
      rows: [
        {
          sourceRef: 'rc-9:0',
          amount: 1_000,
          currency: 'COP',
          paidOn: '2026-08-01',
          clientNit: '901889897',
        },
      ],
    });
    const r = await receivables(w.db, { today: TODAY });
    expect(r.unappliedPayments).toBe(1);
    expect(r.advancePayments).toBe(0);
  });
});
