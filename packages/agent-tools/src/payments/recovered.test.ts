import { describe, expect, it } from 'vitest';
import {
  type AttributeRecoveredInput,
  RECOVERY_WINDOW_DAYS,
  type RecoveryInvoice,
  type RecoveryPayment,
  type RecoveryTrigger,
  attributeRecovered,
  pickTrigger,
} from './recovered';

/**
 * Plata recuperada con Cortex: las reglas, una por una.
 *
 * Cada caso es una pregunta que un contador escéptico haría: ¿y si pagó antes
 * del aviso? ¿y si pagó de más? ¿y si el mismo pago aparece dos veces? Ante la
 * duda la cifra NO cuenta: es la cifra que prueba el valor de Cortex y no
 * puede inflarse.
 */

const TODAY = '2026-10-01';

function doc(over: Partial<RecoveryInvoice> = {}): RecoveryInvoice {
  return {
    id: 'inv-1',
    source: 'document',
    system: null,
    docNumber: 'FV-100',
    clientId: 'cli-1',
    counterparty: 'Coltrans S.A.S.',
    currency: 'COP',
    total: 1_000_000,
    ...over,
  };
}

function acc(over: Partial<RecoveryInvoice> = {}): RecoveryInvoice {
  return {
    id: 'acc-1',
    source: 'accounting',
    system: 'siigo',
    docNumber: 'FV-2-22',
    clientId: null,
    counterparty: 'Andina Ltda.',
    currency: 'COP',
    total: 2_000_000,
    paymentsSynced: true,
    href: 'https://siigo.example/fv-2-22',
    ...over,
  };
}

function notice(over: Partial<RecoveryTrigger> = {}): RecoveryTrigger {
  return {
    kind: 'notice',
    id: 'n-1',
    invoiceId: 'inv-1',
    on: '2026-09-01',
    stage: 1,
    href: '/payments',
    ...over,
  };
}

function pay(over: Partial<RecoveryPayment> = {}): RecoveryPayment {
  return {
    id: 'p-1',
    extractionId: 'inv-1',
    invoiceNumber: null,
    kind: 'payment',
    amount: 400_000,
    currency: 'COP',
    paidOn: '2026-09-10',
    state: 'confirmed',
    ...over,
  };
}

function run(over: Partial<AttributeRecoveredInput> = {}) {
  return attributeRecovered({
    today: TODAY,
    invoices: [doc()],
    triggers: [notice()],
    payments: [pay()],
    ...over,
  });
}

describe('qué pago cuenta', () => {
  it('cuenta un pago parcial que llegó después del aviso, por lo que se pagó', () => {
    const r = run();
    expect(r.cop.total).toBe(400_000);
    expect(r.cop.automatic).toBe(400_000);
    expect(r.items).toHaveLength(1);
    const item = r.items[0];
    expect(item?.amount).toBe(400_000);
    expect(item?.trigger).toMatchObject({ kind: 'notice', id: 'n-1', on: '2026-09-01' });
    expect(item?.movements).toEqual([
      expect.objectContaining({ kind: 'payment', id: 'p-1', counted: 400_000, on: '2026-09-10' }),
    ]);
  });

  it('no cuenta un pago anterior a la acción ni uno del mismo día', () => {
    expect(run({ payments: [pay({ paidOn: '2026-08-30' })] }).cop.total).toBe(0);
    expect(run({ payments: [pay({ paidOn: '2026-09-01' })] }).cop.total).toBe(0);
    expect(run({ payments: [pay({ paidOn: '2026-09-02' })] }).cop.total).toBe(400_000);
  });

  it('no cuenta un pago fuera de la ventana', () => {
    const last = '2026-10-16'; // 1 sep + 45 días
    expect(RECOVERY_WINDOW_DAYS).toBe(45);
    expect(run({ today: '2026-12-01', payments: [pay({ paidOn: last })] }).cop.total).toBe(400_000);
    expect(run({ today: '2026-12-01', payments: [pay({ paidOn: '2026-10-17' })] }).cop.total).toBe(
      0,
    );
  });

  it('no cuenta pagos en disputa, descartados ni ajustes', () => {
    expect(run({ payments: [pay({ state: 'disputed' })] }).cop.total).toBe(0);
    expect(run({ payments: [pay({ state: 'discarded' })] }).cop.total).toBe(0);
    expect(run({ payments: [pay({ kind: 'adjustment' })] }).cop.total).toBe(0);
    expect(run({ payments: [pay({ state: 'reported' })] }).cop.total).toBe(400_000);
  });

  it('no cruza monedas', () => {
    expect(run({ payments: [pay({ currency: 'USD' })] }).cop.total).toBe(0);
  });

  it('no cuenta pagos con fecha futura', () => {
    expect(run({ payments: [pay({ paidOn: '2026-10-02' })] }).cop.total).toBe(0);
  });

  it('un pago sin acción de Cortex sobre su factura no cuenta', () => {
    expect(run({ triggers: [] }).cop.total).toBe(0);
    expect(run({ triggers: [notice({ invoiceId: 'otra' })] }).cop.total).toBe(0);
  });

  it('un pago atado a otra factura no cuenta para ésta', () => {
    expect(run({ payments: [pay({ extractionId: 'otra' })] }).cop.total).toBe(0);
  });
});

describe('nunca más de lo que se debía', () => {
  it('un pago que cubre de más cuenta hasta el saldo', () => {
    const r = run({ payments: [pay({ amount: 1_500_000 })] });
    expect(r.cop.total).toBe(1_000_000);
    expect(r.items[0]?.capped).toBe(true);
    expect(r.items[0]?.movements[0]).toMatchObject({ counted: 1_000_000, reported: 1_500_000 });
  });

  it('lo pagado antes de la acción baja lo que se debía', () => {
    const r = run({
      payments: [
        pay({ id: 'antes', paidOn: '2026-08-20', amount: 700_000 }),
        pay({ id: 'despues', paidOn: '2026-09-15', amount: 700_000 }),
      ],
    });
    expect(r.cop.total).toBe(300_000);
  });

  it('el saldo escrito en el aviso manda sobre el total', () => {
    const r = attributeRecovered({
      today: TODAY,
      invoices: [acc({ paymentsSynced: true })],
      triggers: [notice({ invoiceId: 'acc-1', balance: 500_000 })],
      payments: [
        pay({
          extractionId: null,
          invoiceNumber: 'fv 2 22',
          amount: 800_000,
          paidOn: '2026-09-05',
        }),
      ],
    });
    expect(r.cop.total).toBe(500_000);
    expect(r.items[0]?.capped).toBe(true);
  });

  it('varios pagos parciales suman hasta el saldo y no más', () => {
    const r = run({
      payments: [
        pay({ id: 'a', paidOn: '2026-09-05', amount: 600_000 }),
        pay({ id: 'b', paidOn: '2026-09-20', amount: 600_000 }),
      ],
    });
    expect(r.cop.total).toBe(1_000_000);
    expect(r.items[0]?.movements.map((m) => m.counted)).toEqual([600_000, 400_000]);
  });
});

describe('sin doble conteo', () => {
  it('el mismo pago dos veces cuenta una', () => {
    expect(run({ payments: [pay(), pay()] }).cop.total).toBe(400_000);
  });

  it('varias acciones antes del mismo pago: una sola atribución, a la más fuerte', () => {
    const r = run({
      triggers: [
        notice(),
        notice({ id: 'n-30', on: '2026-09-03', stage: 30 }),
        {
          kind: 'case',
          id: 'wf-1',
          invoiceId: 'inv-1',
          on: '2026-09-04',
          caseId: 'case-1',
          href: '/management?case=case-1',
        },
        {
          kind: 'collection',
          id: 'act-1',
          invoiceId: 'inv-1',
          on: '2026-09-05',
          caseId: 'case-1',
          href: '/actions',
        },
      ],
    });
    expect(r.cop.total).toBe(400_000);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]?.trigger).toMatchObject({
      kind: 'collection',
      id: 'act-1',
      caseId: 'case-1',
    });
    expect(r.items[0]?.triggers).toBe(1);
  });

  it('entre acciones iguales gana la más reciente', () => {
    const t = pickTrigger(
      [notice({ id: 'a', on: '2026-09-01' }), notice({ id: 'b', on: '2026-09-05' })],
      '2026-09-10',
      45,
    );
    expect(t?.id).toBe('b');
  });

  it('un pago con número de factura repetido en dos programas no se ata a ninguna', () => {
    const r = attributeRecovered({
      today: TODAY,
      invoices: [acc(), acc({ id: 'acc-2', system: 'alegra' })],
      triggers: [notice({ invoiceId: 'acc-1' }), notice({ id: 'n-2', invoiceId: 'acc-2' })],
      payments: [pay({ extractionId: null, invoiceNumber: 'FV-2-22' })],
    });
    expect(r.cop.total).toBe(0);
  });

  it('un pago con id de documento no se ata por número a una del programa contable', () => {
    const r = attributeRecovered({
      today: TODAY,
      invoices: [acc()],
      triggers: [notice({ invoiceId: 'acc-1' })],
      payments: [pay({ extractionId: 'acc-1', invoiceNumber: 'FV-2-22' })],
    });
    expect(r.cop.total).toBe(0);
  });
});

describe('devoluciones', () => {
  it('una devolución posterior descuenta lo ya contado', () => {
    const r = run({
      payments: [
        pay(),
        pay({ id: 'rev', kind: 'reversal', amount: 150_000, paidOn: '2026-09-12' }),
      ],
    });
    expect(r.cop.total).toBe(250_000);
    expect(r.items[0]?.movements.map((m) => m.counted)).toEqual([400_000, -150_000]);
  });

  it('una devolución no deja la cifra en negativo', () => {
    const r = run({
      payments: [
        pay(),
        pay({ id: 'rev', kind: 'reversal', amount: 900_000, paidOn: '2026-09-12' }),
      ],
    });
    expect(r.cop.total).toBe(0);
    expect(r.items).toHaveLength(0);
  });
});

describe('caídas de saldo de un programa contable', () => {
  const drop = {
    id: 'd-1',
    invoiceId: 'acc-1',
    amount: 2_000_000,
    currency: 'COP',
    seenBeforeOn: '2026-09-01',
    observedOn: '2026-09-08',
  };

  it('cuentan si el programa no trae pagos', () => {
    const r = attributeRecovered({
      today: TODAY,
      invoices: [acc({ paymentsSynced: false })],
      triggers: [notice({ invoiceId: 'acc-1', balance: 2_000_000 })],
      payments: [],
      drops: [drop],
    });
    expect(r.cop.total).toBe(2_000_000);
    expect(r.items[0]?.movements[0]).toMatchObject({ kind: 'balance_drop', id: 'd-1' });
    expect(r.items[0]?.href).toBe('https://siigo.example/fv-2-22');
  });

  it('no cuentan si el programa trae pagos (suele ser una nota crédito)', () => {
    const r = attributeRecovered({
      today: TODAY,
      invoices: [acc({ paymentsSynced: true })],
      triggers: [notice({ invoiceId: 'acc-1' })],
      payments: [],
      drops: [drop],
    });
    expect(r.cop.total).toBe(0);
  });

  it('si hay pagos atados, mandan los pagos y la caída no se suma', () => {
    const r = attributeRecovered({
      today: TODAY,
      invoices: [acc({ paymentsSynced: false })],
      triggers: [notice({ invoiceId: 'acc-1' })],
      payments: [pay({ extractionId: null, invoiceNumber: 'FV-2-22', amount: 2_000_000 })],
      drops: [drop],
    });
    expect(r.cop.total).toBe(2_000_000);
    expect(r.items[0]?.movements.map((m) => m.kind)).toEqual(['payment']);
  });

  it('no cuenta una caída cuyo saldo de antes se vio antes de la acción', () => {
    const r = attributeRecovered({
      today: TODAY,
      invoices: [acc({ paymentsSynced: false })],
      triggers: [notice({ invoiceId: 'acc-1', on: '2026-09-05' })],
      payments: [],
      drops: [drop],
    });
    expect(r.cop.total).toBe(0);
  });
});

describe('lo manual', () => {
  const manual = {
    caseId: 'case-9',
    title: 'Multa de la DIAN',
    amountCop: 3_000_000,
    note: 'Se evitó la sanción por extemporaneidad',
    on: '2026-09-20',
  };

  it('suma a la cifra en pesos, con su enlace al asunto', () => {
    const r = run({ manual: [manual] });
    expect(r.cop.manual).toBe(3_000_000);
    expect(r.cop.total).toBe(3_400_000);
    expect(r.cop.month).toBe(0); // septiembre; hoy es octubre
    expect(r.manual[0]).toMatchObject({ counted: 3_000_000, href: '/management?case=case-9' });
  });

  it('no repite lo que ya contaron los pagos de la factura del asunto', () => {
    const r = run({ manual: [{ ...manual, amountCop: 1_000_000, invoiceId: 'inv-1' }] });
    expect(r.manual[0]).toMatchObject({ counted: 600_000, overlap: 400_000 });
    expect(r.cop.total).toBe(1_000_000);
  });

  it('el mismo asunto cuenta una vez y lo inválido no cuenta', () => {
    const r = run({
      payments: [],
      manual: [
        manual,
        manual,
        { ...manual, caseId: 'x', amountCop: 0 },
        { ...manual, caseId: 'y', on: '2026-10-05' },
      ],
    });
    expect(r.cop.manual).toBe(3_000_000);
    expect(r.manual).toHaveLength(1);
  });
});

describe('las cifras', () => {
  it('el mes cuenta por el día de cada pago', () => {
    const r = attributeRecovered({
      today: '2026-09-30',
      invoices: [doc()],
      triggers: [notice({ on: '2026-08-25' })],
      payments: [
        pay({ id: 'ago', paidOn: '2026-08-28', amount: 100_000 }),
        pay({ id: 'sep', paidOn: '2026-09-02', amount: 200_000 }),
      ],
      manual: [
        { caseId: 'c', title: 'Descuento', amountCop: 50_000, note: 'Negociado', on: '2026-09-10' },
      ],
    });
    expect(r.month).toBe('2026-09');
    expect(r.cop.month).toBe(250_000);
    expect(r.cop.total).toBe(350_000);
    expect(r.cop.monthInvoices).toBe(1);
  });

  it('otras monedas van aparte y nunca se suman a los pesos', () => {
    const r = attributeRecovered({
      today: TODAY,
      invoices: [doc(), doc({ id: 'usd', currency: 'USD', total: 5_000 })],
      triggers: [notice(), notice({ id: 'n-usd', invoiceId: 'usd' })],
      payments: [pay(), pay({ id: 'pu', extractionId: 'usd', currency: 'usd', amount: 1_200 })],
    });
    expect(r.cop.total).toBe(400_000);
    expect(r.otherCurrencies).toEqual([{ currency: 'USD', month: 0, total: 1_200, invoices: 1 }]);
  });

  it('sin nada atribuible, la cifra es cero y dice sus reglas', () => {
    const r = attributeRecovered({ today: TODAY, invoices: [], triggers: [], payments: [] });
    expect(r.cop).toMatchObject({ month: 0, total: 0, invoices: 0 });
    expect(r.items).toEqual([]);
    expect(r.rules).toContain('45 días');
  });

  it('ordena lo más reciente primero', () => {
    const r = attributeRecovered({
      today: TODAY,
      invoices: [doc(), doc({ id: 'inv-2', docNumber: 'FV-200' })],
      triggers: [notice(), notice({ id: 'n-2', invoiceId: 'inv-2' })],
      payments: [pay(), pay({ id: 'p-2', extractionId: 'inv-2', paidOn: '2026-09-25' })],
    });
    expect(r.items.map((i) => i.invoiceId)).toEqual(['inv-2', 'inv-1']);
  });
});
