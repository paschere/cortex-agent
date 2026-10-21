import { describe, expect, it } from 'vitest';
import {
  type CarteraInvoiceIn,
  type CarteraPaymentIn,
  bucketOf,
  buildCartera,
  resolveDue,
} from './cartera';

/**
 * La cartera de la pantalla, con la forma de los datos REALES de Siigo
 * (GROUNDFLEX, 2026-10-21): facturas con «vence» igual a la fecha de expedición,
 * recibos tipo «Anticipo» cuya línea `due` apunta al propio recibo, y un saldo
 * que ya viene neto de cruces y notas crédito.
 */

const TODAY = '2026-10-21';

function inv(over: Partial<CarteraInvoiceIn> & { id: string }): CarteraInvoiceIn {
  return {
    kind: 'accounting',
    docNumber: `FV-2-${over.id}`,
    clientKey: 'charter',
    clientId: null,
    clientName: 'CHARTER LINE AIR SOARA SAS',
    currency: 'COP',
    total: 10_000_000,
    balance: 10_000_000,
    issuedOn: '2026-10-20',
    dueOn: '2026-10-20',
    ...over,
  };
}

function pay(over: Partial<CarteraPaymentIn> & { id: string }): CarteraPaymentIn {
  return {
    kind: 'payment',
    amount: 20_000_000,
    currency: 'COP',
    paidOn: '2026-09-14',
    clientKey: 'beyond',
    clientName: 'BEYOND BORDER',
    invoiceNumber: null,
    reference: null,
    ...over,
  };
}

describe('vencimiento', () => {
  it('vence el mismo día que se expidió = Siigo no trae plazo: no es «vencida»', () => {
    const m = buildCartera({
      today: TODAY,
      invoices: [inv({ id: '1' }), inv({ id: '2' })],
      payments: [],
    });
    expect(m.kpis.overdue.value).toBe(0);
    expect(m.kpis.overdue.invoices).toBe(0);
    expect(m.noTermInvoices).toBe(2);
    expect(m.aging.find((a) => a.key === 'no_term')?.amount).toBe(20_000_000);
    expect(m.kpis.outstanding.value).toBe(20_000_000);
  });

  it('vence ANTES de expedirse (dato roto de Siigo) tampoco cuenta como plazo', () => {
    expect(
      resolveDue({ issuedOn: '2026-09-21', dueOn: '2026-08-23', clientKey: 'x' }, {}).basis,
    ).toBe('sin_plazo');
  });

  it('un plazo de verdad de Siigo manda sobre el del cliente', () => {
    expect(
      resolveDue(
        { issuedOn: '2026-09-01', dueOn: '2026-09-15', clientKey: 'x' },
        { termDays: { x: 60 } },
      ),
    ).toEqual({ dueOn: '2026-09-15', basis: 'siigo' });
  });

  it('sin plazo en Siigo se usa el plazo del cliente', () => {
    const m = buildCartera({
      today: TODAY,
      invoices: [inv({ id: '1', issuedOn: '2026-08-20', dueOn: '2026-08-20' })],
      payments: [],
      termDays: { charter: 30 },
    });
    expect(m.invoices[0]).toMatchObject({
      dueOn: '2026-09-19',
      dueBasis: 'plazo_cliente',
      daysOverdue: 32,
    });
    expect(m.invoices[0]?.bucket).toBe('d31_60');
    expect(m.kpis.overdue.value).toBe(10_000_000);
    expect(m.kpis.overdue.pct).toBe(1);
  });

  it('«¿y si fueran a N días?» es sólo para mirar y se marca como supuesto', () => {
    const m = buildCartera({
      today: TODAY,
      invoices: [inv({ id: '1', issuedOn: '2026-08-20', dueOn: '2026-08-20' }), inv({ id: '2' })],
      payments: [],
      defaultTermDays: 30,
    });
    expect(m.invoices.every((i) => i.dueBasis === 'plazo_supuesto')).toBe(true);
    expect(m.termBasis.plazo_supuesto).toBe(2);
    expect(m.kpis.overdue.value).toBe(10_000_000);
  });

  it('los cortes de antigüedad', () => {
    expect([null, -3, 0, 1, 30, 31, 60, 61, 90, 91].map(bucketOf)).toEqual([
      'no_term',
      'current',
      'current',
      'd1_30',
      'd1_30',
      'd31_60',
      'd31_60',
      'd61_90',
      'd61_90',
      'd90_plus',
    ]);
  });
});

describe('recibos', () => {
  const ledger = (crossed: Record<string, number>) => ({
    advanceCrossedByClient: crossed,
    receivableCredits: [],
  });

  it('un anticipo (su `due` es el propio recibo) NO es «sin emparejar» ni resta del saldo', () => {
    const m = buildCartera({
      today: TODAY,
      invoices: [inv({ id: '1', clientKey: 'beyond', clientName: 'BEYOND BORDER' })],
      payments: [
        pay({ id: 'p1', invoiceNumber: 'RC-1-10', reference: 'RC-1-10', amount: 200_000_000 }),
      ],
      advanceReceipts: ['RC-1-10'],
      ledger: ledger({}),
    });
    expect(m.payments[0]).toMatchObject({ role: 'advance', advanceStatus: 'pending' });
    expect(m.unmatched.count).toBe(0);
    expect(m.advances).toMatchObject({ count: 1, received: 200_000_000, pending: 200_000_000 });
    // El saldo es el de Siigo: el anticipo no se resta otra vez.
    expect(m.kpis.outstanding.value).toBe(10_000_000);
  });

  it('un anticipo cuyo número es el de su propio reporte se reconoce aunque Siigo no diga el tipo', () => {
    const m = buildCartera({
      today: TODAY,
      invoices: [],
      payments: [pay({ id: 'p1', invoiceNumber: 'RC-1-4', reference: 'RC-1-4' })],
    });
    expect(m.payments[0]?.role).toBe('advance');
    expect(m.payments[0]?.advanceStatus).toBe('unknown');
  });

  it('lo cruzado en la contabilidad (2805) cubre primero los anticipos más viejos', () => {
    const m = buildCartera({
      today: TODAY,
      invoices: [],
      payments: [
        pay({
          id: 'a',
          clientKey: 'charter',
          paidOn: '2026-07-07',
          amount: 20,
          reference: 'RC-1-1',
          invoiceNumber: 'RC-1-1',
        }),
        pay({
          id: 'b',
          clientKey: 'charter',
          paidOn: '2026-07-17',
          amount: 50,
          reference: 'RC-1-2',
          invoiceNumber: 'RC-1-2',
        }),
        pay({
          id: 'c',
          clientKey: 'charter',
          paidOn: '2026-08-06',
          amount: 40,
          reference: 'RC-1-3',
          invoiceNumber: 'RC-1-3',
        }),
      ],
      advanceReceipts: ['RC-1-1', 'RC-1-2', 'RC-1-3'],
      ledger: ledger({ charter: 80 }),
    });
    const status = Object.fromEntries(m.payments.map((p) => [p.id, p.advanceStatus]));
    expect(status).toEqual({ a: 'crossed', b: 'crossed', c: 'partial' });
    expect(m.advances.pending).toBe(30);
    expect(m.advances.crossed).toBe(70);
  });

  it('un recibo que nombra una factura se atribuye a ella', () => {
    const m = buildCartera({
      today: TODAY,
      invoices: [inv({ id: '1', docNumber: 'FV-2-79', total: 13_779_044, balance: 13_313_081 })],
      payments: [
        pay({ id: 'p1', clientKey: 'charter', invoiceNumber: 'fv 2 79', amount: 465_963 }),
      ],
    });
    expect(m.payments[0]).toMatchObject({ role: 'invoice', invoiceNumber: 'FV-2-79' });
    expect(m.kpis.outstanding.value).toBe(13_313_081);
  });

  it('un recibo que no nombra factura queda sin emparejar con FIFO sugerido, nunca aplicado', () => {
    const m = buildCartera({
      today: TODAY,
      invoices: [
        inv({ id: 'nueva', docNumber: 'FV-2-300', issuedOn: '2026-10-10', dueOn: '2026-10-10' }),
        inv({ id: 'vieja', docNumber: 'FV-2-100', issuedOn: '2026-08-20', dueOn: '2026-09-20' }),
      ],
      payments: [pay({ id: 'p1', clientKey: 'charter', amount: 5_000_000 })],
    });
    expect(m.payments[0]?.role).toBe('unmatched');
    expect(m.payments[0]?.suggestion).toEqual({
      invoiceId: 'vieja',
      docNumber: 'FV-2-100',
      basis: 'fifo',
    });
    expect(m.unmatched).toEqual({ count: 1, amount: 5_000_000 });
    expect(m.kpis.outstanding.value).toBe(20_000_000);
  });

  it('sin cliente conocido no hay sugerencia', () => {
    const m = buildCartera({
      today: TODAY,
      invoices: [inv({ id: '1' })],
      payments: [pay({ id: 'p1', clientKey: null, clientName: null })],
    });
    expect(m.payments[0]?.suggestion).toBeNull();
  });
});

describe('cifras de arriba', () => {
  it('cobrado este mes contra el mismo tramo del mes anterior', () => {
    const m = buildCartera({
      today: TODAY,
      invoices: [],
      payments: [
        pay({ id: 'a', paidOn: '2026-10-05', amount: 10 }),
        pay({ id: 'b', paidOn: '2026-09-14', amount: 320 }),
        pay({ id: 'c', paidOn: '2026-09-30', amount: 30 }),
        pay({ id: 'd', paidOn: '2026-09-10', amount: 7 }),
      ],
    });
    expect(m.kpis.collectedMonth.value).toBe(10);
    // sólo hasta el día 21 de septiembre: 320 + 7 (el del día 30 no cuenta)
    expect(m.kpis.collectedMonth.prev).toBe(327);
  });

  it('una anulación resta de lo cobrado', () => {
    const m = buildCartera({
      today: TODAY,
      invoices: [],
      payments: [
        pay({ id: 'a', paidOn: '2026-10-05', amount: 100 }),
        pay({ id: 'b', kind: 'reversal', paidOn: '2026-10-06', amount: 40 }),
      ],
    });
    expect(m.kpis.collectedMonth.value).toBe(60);
  });

  it('días promedio de cobro = por cobrar / facturado de 90 días × 90', () => {
    const m = buildCartera({
      today: TODAY,
      invoices: [
        inv({ id: '1', total: 900, balance: 300, issuedOn: '2026-09-01', dueOn: '2026-10-01' }),
        inv({ id: '2', total: 600, balance: 0, issuedOn: '2026-08-01', dueOn: '2026-08-31' }),
        inv({ id: 'viejo', total: 5_000, balance: 0, issuedOn: '2026-05-01', dueOn: '2026-05-31' }),
      ],
      payments: [],
    });
    // por cobrar 300; facturado desde 2026-07-23: 900 + 600 = 1500 → 300/1500×90 = 18
    expect(m.kpis.dso.value).toBe(18);
  });

  it('la comparación de «por cobrar» descuenta lo facturado y suma lo cobrado en 30 días', () => {
    const m = buildCartera({
      today: TODAY,
      invoices: [
        inv({ id: '1', total: 1_000, balance: 1_000, issuedOn: '2026-10-10', dueOn: '2026-11-10' }),
        inv({ id: '2', total: 500, balance: 500, issuedOn: '2026-08-10', dueOn: '2026-09-10' }),
      ],
      payments: [
        pay({
          id: 'p',
          paidOn: '2026-10-02',
          amount: 200,
          clientKey: 'charter',
          invoiceNumber: 'FV-2-2',
        }),
      ],
    });
    // ahora 1500; hace 30 días: 1500 − 1000 (facturado) + 200 (cobrado) = 700
    expect(m.kpis.outstanding.prev).toBe(700);
  });

  it('doce meses de facturado y cobrado, con ceros donde no hubo', () => {
    const m = buildCartera({
      today: TODAY,
      invoices: [
        inv({ id: '1', total: 100, balance: 0, issuedOn: '2026-07-03', dueOn: '2026-08-03' }),
        inv({ id: '2', total: 50, balance: 50 }),
      ],
      payments: [pay({ id: 'p', paidOn: '2026-09-14', amount: 80 })],
    });
    expect(m.monthly).toHaveLength(12);
    expect(m.monthly[0]?.month).toBe('2025-11');
    expect(m.monthly[11]?.month).toBe('2026-10');
    expect(m.monthly.find((x) => x.month === '2026-07')).toMatchObject({
      invoiced: 100,
      collected: 0,
    });
    expect(m.monthly.find((x) => x.month === '2026-09')).toMatchObject({
      invoiced: 0,
      collected: 80,
    });
  });
});

describe('cartera por cliente y cuadre', () => {
  const invoices = [
    inv({ id: '1', balance: 700, total: 1000, issuedOn: '2026-08-20', dueOn: '2026-09-20' }),
    inv({ id: '2', balance: 300, total: 300, issuedOn: '2026-10-15', dueOn: '2026-11-15' }),
    inv({
      id: '3',
      clientKey: 'tranexco',
      clientName: 'TRANEXCO',
      balance: 50,
      total: 50,
      issuedOn: '2026-10-07',
      dueOn: '2026-10-07',
    }),
    inv({ id: '4', balance: 0, total: 400, issuedOn: '2026-09-01', dueOn: '2026-09-01' }),
  ];

  it('ordena por saldo, parte vencido / al día / sin plazo y pone el último pago', () => {
    const m = buildCartera({
      today: TODAY,
      invoices,
      payments: [
        pay({
          id: 'p',
          clientKey: 'charter',
          paidOn: '2026-09-30',
          amount: 30,
          invoiceNumber: 'FV-2-1',
        }),
      ],
    });
    expect(m.clients.map((c) => c.key)).toEqual(['charter', 'tranexco']);
    expect(m.clients[0]).toMatchObject({
      open: 1000,
      overdue: 700,
      current: 300,
      noTerm: 0,
      lastPaymentOn: '2026-09-30',
      lastPaymentAmount: 30,
    });
    expect(m.clients[1]).toMatchObject({ open: 50, noTerm: 50 });
  });

  it('antigüedad apilada por cliente, con «Otros»', () => {
    const m = buildCartera({ today: TODAY, invoices, payments: [] });
    const current = m.aging.find((a) => a.key === 'current');
    expect(current?.amount).toBe(300);
    expect(m.aging.reduce((s, a) => s + a.amount, 0)).toBe(1050);
  });

  it('facturado = por cobrar + abonado/cruzado + notas crédito', () => {
    const m = buildCartera({
      today: TODAY,
      invoices: [
        inv({ id: '1', total: 1000, balance: 400 }),
        inv({ id: '2', total: 500, balance: 0 }),
        inv({ id: '3', total: 200, balance: 0, docNumber: 'FV-2-155' }),
      ],
      payments: [],
      creditNotes: [
        {
          number: 'NC-1',
          invoiceNumber: 'FV-2-155',
          amount: 200,
          date: '2026-10-09',
          clientKey: 'charter',
          clientName: 'C',
        },
      ],
    });
    expect(m.reconciliation).toEqual({
      invoiced: 1700,
      open: 400,
      settled: 1300,
      creditNotes: 200,
      cashApplied: 1100,
    });
  });

  it('cuadra contra la 1305 de los saldos por tercero y muestra la diferencia', () => {
    const m = buildCartera({
      today: TODAY,
      invoices,
      payments: [],
      ledger: { balance1305ByClient: { charter: 990, tranexco: 50 }, balancePeriod: '2026-10' },
    });
    expect(m.ledgerCheck).toEqual({ period: '2026-10', ledger: 1040, invoices: 1050, diff: 10 });
    expect(m.clients[0]?.ledgerDiff).toBe(10);
    expect(m.clients[1]?.ledgerDiff).toBe(0);
  });

  it('sin saldos por tercero no inventa el cuadre', () => {
    const m = buildCartera({ today: TODAY, invoices, payments: [] });
    expect(m.ledgerCheck).toBeNull();
    expect(m.clients[0]?.ledgerBalance).toBeNull();
  });

  it('nunca mezcla monedas', () => {
    const m = buildCartera({
      today: TODAY,
      invoices: [
        inv({ id: '1', balance: 1_000 }),
        inv({ id: '2', currency: 'USD', balance: 50, total: 50 }),
      ],
      payments: [],
    });
    expect(m.currency).toBe('COP');
    expect(m.kpis.outstanding.value).toBe(1_000);
    expect(m.otherCurrencies).toEqual([{ currency: 'USD', open: 50, count: 1 }]);
  });

  it('proyección: vencido ahora, vencimientos por semana y lo que no tiene fecha', () => {
    const m = buildCartera({
      today: TODAY, // miércoles; la semana empieza el lunes 19
      invoices: [
        inv({ id: '1', balance: 100, issuedOn: '2026-09-01', dueOn: '2026-10-01' }),
        inv({ id: '2', balance: 200, issuedOn: '2026-10-15', dueOn: '2026-10-23' }),
        inv({ id: '3', balance: 300, issuedOn: '2026-10-15', dueOn: '2026-11-02' }),
        inv({ id: '4', balance: 400, issuedOn: '2026-10-15', dueOn: '2027-03-01' }),
        inv({ id: '5', balance: 500 }),
      ],
      payments: [],
    });
    expect(m.projection.overdue).toBe(100);
    expect(m.projection.weeks[0]).toMatchObject({
      from: '2026-10-19',
      to: '2026-10-25',
      amount: 200,
      count: 1,
    });
    expect(m.projection.weeks[2]).toMatchObject({ from: '2026-11-02', amount: 300 });
    expect(m.projection.later).toBe(400);
    expect(m.projection.noTerm).toBe(500);
  });
});
