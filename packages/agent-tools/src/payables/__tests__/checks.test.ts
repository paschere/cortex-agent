import { describe, expect, it } from 'vitest';
import { nitDv } from '../../clients/shape';
import type { ForecastWeek } from '../../ledger/types';
import {
  type CheckContext,
  type CheckInvoice,
  checkPayable,
  isBlocked,
  withholdingBase,
} from '../checks';
import { applyPayablesOverlay } from '../overlay';
import { referencesOrder } from '../purchase-orders';
import { businessDay, payPlanByWeek, suggestPayDates } from '../schedule';
import { canMove, numberKey, payableDedupeKey, supplierNameKey } from '../shape';

const NIT = '900373115';
const DV = String(nitDv(NIT));

function invoice(over: Partial<CheckInvoice> = {}): CheckInvoice {
  return {
    docNumber: 'FEPA-451',
    supplierNit: NIT,
    supplierDv: DV,
    supplierName: 'Papelería El Cóndor',
    customerNit: '830025281',
    currency: 'COP',
    issueDate: '2026-09-28',
    dueDate: '2026-10-28',
    subtotal: 1_000_000,
    total: 1_190_000,
    lines: [
      {
        position: 1,
        description: 'Resma carta',
        code: 'RES-75',
        quantity: 100,
        unit: '94',
        unitPrice: 10_000,
        amount: 1_000_000,
      },
    ],
    withholdings: { retefuente: 0, reteiva: 0, reteica: 0 },
    orderReference: null,
    dianAccepted: true,
    ...over,
  };
}

function ctx(over: Partial<CheckContext> = {}): CheckContext {
  return {
    today: '2026-10-03',
    companyNit: '830025281',
    supplier: { nit: NIT, name: 'Papelería El Cóndor', hasWithholdingRates: true },
    history: [],
    purchaseOrder: null,
    purchaseOrdersAvailable: false,
    ...over,
  };
}

const codes = (inv: CheckInvoice, c: CheckContext) => checkPayable(inv, c).map((x) => x.code);

describe('identidad', () => {
  it('el mismo número escrito distinto es la misma factura del mismo proveedor', () => {
    expect(numberKey('FEPA-00451')).toBe(numberKey('fepa 451'));
    expect(payableDedupeKey({ supplierNit: '900.373.115-2', docNumber: 'FEPA-00451' })).toBe(
      payableDedupeKey({ supplierNit: '900373115', docNumber: 'FEPA451' }),
    );
    expect(payableDedupeKey({ supplierNit: '900373115', docNumber: '1' })).not.toBe(
      payableDedupeKey({ supplierNit: '800111222', docNumber: '1' }),
    );
    expect(payableDedupeKey({ supplierName: 'Papelería El Cóndor S.A.S.', docNumber: '7' })).toBe(
      payableDedupeKey({ supplierName: 'PAPELERIA EL CONDOR', docNumber: '7' }),
    );
    expect(supplierNameKey('Inversiones ABC Ltda.')).toBe('inversionesabc');
  });

  it('las transiciones del flujo', () => {
    expect(canMove('por_aprobar', 'aprobada')).toBe(true);
    expect(canMove('aprobada', 'programada')).toBe(true);
    expect(canMove('rechazada', 'aprobada')).toBe(false);
    expect(canMove('pagada', 'rechazada')).toBe(false);
    expect(canMove('recibida', 'programada')).toBe(false);
  });
});

describe('checkPayable', () => {
  it('una factura limpia no levanta nada', () => {
    expect(checkPayable(invoice(), ctx())).toEqual([]);
  });

  it('detiene: a nombre de otro NIT, rechazada por la DIAN, posible doble cobro', () => {
    const c = ctx({
      history: [
        {
          id: 'h1',
          docNumber: 'FEPA-449',
          issueDate: '2026-09-25',
          total: 1_190_000,
          currency: 'COP',
          status: 'aprobada',
          lines: [],
        },
      ],
    });
    const found = checkPayable(invoice({ customerNit: '899999068', dianAccepted: false }), c);
    expect(found.map((x) => x.code).sort()).toEqual([
      'dian_rejected',
      'duplicate_suspect',
      'wrong_customer_nit',
    ]);
    expect(isBlocked(found)).toBe(true);
    expect(found.find((x) => x.code === 'duplicate_suspect')?.message).toContain('FEPA-449');
  });

  it('la misma factura otra vez no es «doble cobro» (eso lo resuelve el dedupe)', () => {
    const c = ctx({
      history: [
        {
          id: 'h',
          docNumber: 'FEPA-00451',
          issueDate: '2026-09-28',
          total: 1_190_000,
          currency: 'COP',
          status: 'por_aprobar',
          lines: [],
        },
      ],
    });
    expect(codes(invoice(), c)).not.toContain('duplicate_suspect');
  });

  it('NIT: dígito de verificación y proveedor conocido con otro NIT', () => {
    const wrongDv = String((Number(DV) + 1) % 10);
    expect(codes(invoice({ supplierDv: wrongDv }), ctx())).toContain('invalid_supplier_dv');
    expect(
      codes(
        invoice(),
        ctx({
          supplier: { nit: '800111222', name: 'Papelería El Cóndor', hasWithholdingRates: true },
        }),
      ),
    ).toContain('supplier_nit_mismatch');
  });

  it('subida de precio por ítem y total inusual contra la historia', () => {
    const history = [
      {
        id: 'a',
        docNumber: 'F1',
        issueDate: '2026-06-01',
        total: 400_000,
        currency: 'COP',
        status: 'pagada',
        lines: [
          {
            position: 1,
            description: 'Resma carta',
            code: 'RES-75',
            quantity: 50,
            unit: null,
            unitPrice: 8_000,
            amount: 400_000,
          },
        ],
      },
      {
        id: 'b',
        docNumber: 'F2',
        issueDate: '2026-07-01',
        total: 420_000,
        currency: 'COP',
        status: 'pagada',
        lines: [],
      },
      {
        id: 'c',
        docNumber: 'F3',
        issueDate: '2026-08-01',
        total: 380_000,
        currency: 'COP',
        status: 'pagada',
        lines: [],
      },
    ];
    const found = checkPayable(invoice(), ctx({ history }));
    const jump = found.find((x) => x.code === 'price_jump');
    expect(jump?.message).toContain('25 %');
    expect(found.map((x) => x.code)).toContain('amount_unusual');
    expect(isBlocked(found)).toBe(false);
  });

  it('retención: avisa sobre la base mínima si el proveedor no tiene retenciones definidas', () => {
    expect(withholdingBase('2026-09-28')).toBe(27 * 52_374);
    const noRates = ctx({ supplier: { nit: NIT, name: 'X', hasWithholdingRates: false } });
    expect(codes(invoice({ subtotal: 2_000_000, total: 2_380_000 }), noRates)).toContain(
      'missing_withholding',
    );
    expect(codes(invoice({ subtotal: 200_000, total: 238_000 }), noRates)).not.toContain(
      'missing_withholding',
    );
    expect(
      codes(
        invoice({
          subtotal: 2_000_000,
          total: 2_380_000,
          withholdings: { retefuente: 50_000, reteiva: 0, reteica: 0 },
        }),
        noRates,
      ),
    ).not.toContain('missing_withholding');
  });

  it('orden de compra: cuadra, no cuadra, o citada y no encontrada', () => {
    const po = {
      id: 'po1',
      number: 'OC-0118',
      total: 1_190_000,
      currency: 'COP',
      status: 'recibida',
      lines: [{ code: 'RES-75', description: 'Resma', quantity: 100, unitPrice: 10_000 }],
    };
    expect(referencesOrder('OC-118', { number: 118, label: 'OC-0118' })).toBe(true);
    expect(referencesOrder('118', { number: 118, label: 'OC-0118' })).toBe(true);
    expect(referencesOrder('OC-0119', { number: 118, label: 'OC-0118' })).toBe(false);
    expect(codes(invoice(), ctx({ purchaseOrder: po, purchaseOrdersAvailable: true }))).toEqual([
      'po_match',
    ]);
    const over = invoice({
      lines: [
        {
          position: 1,
          description: 'Resma',
          code: 'RES-75',
          quantity: 120,
          unit: null,
          unitPrice: 10_000,
          amount: 1_000_000,
        },
      ],
    });
    expect(
      checkPayable(over, ctx({ purchaseOrder: po, purchaseOrdersAvailable: true }))[0]?.message,
    ).toContain('se pidieron 100 y facturan 120');
    expect(
      codes(invoice({ orderReference: 'OC-9' }), ctx({ purchaseOrdersAvailable: true })),
    ).toEqual(['po_missing']);
    expect(codes(invoice({ orderReference: 'OC-9' }), ctx())).toEqual([]);
  });

  it('notas: sin vencimiento, vencida, líneas que no suman', () => {
    expect(codes(invoice({ dueDate: null }), ctx())).toEqual(['no_due_date']);
    expect(codes(invoice({ dueDate: '2026-09-30' }), ctx())).toEqual(['overdue']);
    expect(codes(invoice({ subtotal: 900_000 }), ctx())).toContain('totals_mismatch');
  });
});

// ---------------------------------------------------------------------------
// Programar contra la caja
// ---------------------------------------------------------------------------

function weeks(closings: number[], items: ForecastWeek['items'][] = []): ForecastWeek[] {
  const starts = ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02'];
  return closings.map((closing, i) => ({
    start: starts[i] as string,
    opening: 0,
    inflows: 0,
    outflows: 0,
    closing,
    items: items[i] ?? [],
  }));
}

describe('suggestPayDates', () => {
  it('paga el día que vence si la semana aguanta', () => {
    const [s] = suggestPayDates({
      today: '2026-10-05',
      currency: 'COP',
      minimumCash: 10_000_000,
      weeks: weeks([30e6, 30e6, 30e6, 30e6, 30e6]),
      candidates: [{ id: 'a', amount: 5e6, currency: 'COP', dueDate: '2026-10-14' }],
    });
    expect(s).toMatchObject({
      date: '2026-10-14',
      lateDays: 0,
      belowMinimum: false,
      closingAfter: 25e6,
    });
  });

  it('nunca en una semana que quede debajo del mínimo: la corre a la siguiente', () => {
    const [s] = suggestPayDates({
      today: '2026-10-05',
      currency: 'COP',
      minimumCash: 10_000_000,
      weeks: weeks([30e6, 12e6, 40e6, 40e6, 40e6]),
      candidates: [{ id: 'a', amount: 5e6, currency: 'COP', dueDate: '2026-10-14' }],
    });
    expect(s?.date).toBe('2026-10-19');
    expect(s?.lateDays).toBe(5);
    expect(s?.reason).toContain('5 días tarde');
  });

  it('no empuja debajo del mínimo una semana siguiente que estaba bien', () => {
    const [s] = suggestPayDates({
      today: '2026-10-05',
      currency: 'COP',
      minimumCash: 10e6,
      // Pagar en la semana 1 deja la 2 en 9M (debajo); en la 2 también; en la 3 ya no.
      weeks: weeks([30e6, 14e6, 20e6, 20e6, 20e6]),
      candidates: [{ id: 'a', amount: 5e6, currency: 'COP', dueDate: '2026-10-07' }],
    });
    expect(s?.weekStart).toBe('2026-10-19');
  });

  it('sin la factura misma: lo que ya estaba en la proyección no se cuenta dos veces', () => {
    const item = {
      label: 'x',
      direction: 'out' as const,
      amount: 5e6,
      expectedAmount: 5e6,
      probability: 1,
      expectedDate: '2026-10-14',
      movementId: 'm1',
      reason: '',
    };
    // Con la factura adentro la semana 2 cierra en 9M; sin ella, 14M: alcanza.
    const [s] = suggestPayDates({
      today: '2026-10-05',
      currency: 'COP',
      minimumCash: 9e6,
      weeks: weeks([30e6, 9e6, 9e6, 9e6, 9e6], [[], [item]]),
      candidates: [
        { id: 'a', amount: 5e6, currency: 'COP', dueDate: '2026-10-14', movementId: 'm1' },
      ],
    });
    expect(s).toMatchObject({ date: '2026-10-14', belowMinimum: false, closingAfter: 9e6 });
  });

  it('si ninguna semana aguanta, sugiere el vencimiento y lo dice', () => {
    const [s] = suggestPayDates({
      today: '2026-10-05',
      currency: 'COP',
      minimumCash: 50e6,
      weeks: weeks([30e6, 30e6, 30e6, 30e6, 30e6]),
      candidates: [{ id: 'a', amount: 5e6, currency: 'COP', dueDate: '2026-10-14' }],
    });
    expect(s).toMatchObject({ date: '2026-10-14', belowMinimum: true });
    expect(s?.reason).toContain('Negocia plazo');
  });

  it('vencida: hoy; fin de semana: día hábil; varias: cada una cuenta para la siguiente', () => {
    expect(businessDay('2026-10-10', '2026-10-05')).toBe('2026-10-09');
    expect(businessDay('2026-10-11', '2026-10-05')).toBe('2026-10-12');
    const out = suggestPayDates({
      today: '2026-10-05',
      currency: 'COP',
      minimumCash: 10e6,
      weeks: weeks([20e6, 20e6, 30e6, 30e6, 30e6]),
      candidates: [
        { id: 'late', amount: 6e6, currency: 'COP', dueDate: '2026-09-20' },
        { id: 'next', amount: 6e6, currency: 'COP', dueDate: '2026-10-06' },
      ],
    });
    expect(out[0]).toMatchObject({ id: 'late', date: '2026-10-05' });
    // Después de la primera, la semana 1 queda en 14M: la segunda ya no cabe ahí.
    expect(out[1]?.weekStart).toBe('2026-10-19');
  });

  it('otra moneda o fuera del horizonte: sin cruzar con la caja', () => {
    const out = suggestPayDates({
      today: '2026-10-05',
      currency: 'COP',
      minimumCash: 0,
      weeks: weeks([1e6]),
      candidates: [
        { id: 'usd', amount: 100, currency: 'USD', dueDate: '2026-10-06' },
        { id: 'far', amount: 100, currency: 'COP', dueDate: '2027-03-01' },
      ],
    });
    expect(out.every((s) => s.unchecked)).toBe(true);
  });
});

describe('payPlanByWeek y la superposición en la proyección', () => {
  it('agrupa por semana con la caja de cada semana', () => {
    const plan = payPlanByWeek({
      currency: 'COP',
      minimumCash: 10e6,
      weeks: weeks([30e6, 8e6]),
      invoices: [
        {
          id: '1',
          supplierName: 'A',
          docNumber: '1',
          amount: 2e6,
          currency: 'COP',
          date: '2026-10-07',
          status: 'programada',
        },
        {
          id: '2',
          supplierName: 'B',
          docNumber: '2',
          amount: 1e6,
          currency: 'COP',
          date: '2026-10-05',
          status: 'programada',
        },
        {
          id: '3',
          supplierName: 'C',
          docNumber: '3',
          amount: 4e6,
          currency: 'COP',
          date: '2026-10-13',
          status: 'programada',
        },
      ],
    });
    expect(plan.map((w) => [w.start, w.total, w.belowMinimum])).toEqual([
      ['2026-10-05', 3e6, false],
      ['2026-10-12', 4e6, true],
    ]);
    expect(plan[0]?.items.map((i) => i.id)).toEqual(['2', '1']);
  });

  it('programada sale el día programado y por el neto; pagada o rechazada ya no sale', () => {
    const base = {
      direction: 'out' as const,
      kind: 'payable' as const,
      status: 'expected' as const,
      amount: 1_190_000,
      outstanding: 1_190_000,
      currency: 'COP',
      date: '2026-09-28',
      dueDate: '2026-10-28',
      description: 'x',
      source: { kind: 'document' as const, ref: 'r' },
    };
    const out = applyPayablesOverlay(
      [
        { ...base, id: 'a' },
        { ...base, id: 'b' },
        { ...base, id: 'c', kind: 'receivable', direction: 'in' },
      ],
      new Map([
        ['a', { dueDate: '2026-11-04', outstanding: 1_165_000, drop: false }],
        ['b', { dueDate: null, outstanding: null, drop: true }],
        ['c', { dueDate: '2027-01-01', outstanding: 1, drop: false }],
      ]),
    );
    expect(out.map((m) => m.id)).toEqual(['a', 'c']);
    expect(out[0]).toMatchObject({ dueDate: '2026-11-04', outstanding: 1_165_000 });
    expect(out[1]?.dueDate).toBe('2026-10-28');
  });
});
