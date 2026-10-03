import { describe, expect, it } from 'vitest';
import {
  type ReorderInput,
  annualTurnover,
  averageCostAfter,
  consumption,
  expectedPaymentDue,
  groupBySupplier,
  planReceipt,
  poTotals,
  productAlert,
  reorderFor,
  reorderSuggestions,
  replayAverageCost,
  stockByProduct,
} from './math';
import { canMovePo, parsePoNumber, poLabel } from './shape';
import { parseCsv, parseNumberCo, parseProductSheet } from './sheet';

const TODAY = '2026-10-03';

describe('existencias', () => {
  it('suman el libro por producto y por bodega', () => {
    const s = stockByProduct([
      { productId: 'a', locationId: 'b1', onHand: 10 },
      { productId: 'a', locationId: 'b2', onHand: 5.5 },
      { productId: 'b', locationId: 'b1', onHand: -2 },
    ]);
    expect(s.get('a')?.total).toBe(15.5);
    expect(s.get('a')?.byLocation.get('b2')).toBe(5.5);
    expect(s.get('b')?.total).toBe(-2);
  });
});

describe('costo promedio ponderado', () => {
  it('promedia cada entrada con costo', () => {
    // 100 a $10 y 50 a $16 → (1000 + 800) / 150 = 12
    const s = replayAverageCost([
      { kind: 'entrada', qty: 100, unitCost: 10 },
      { kind: 'entrada', qty: 50, unitCost: 16 },
    ]);
    expect(s).toEqual({ onHand: 150, cost: 12 });
  });

  it('una salida baja la existencia pero no el costo', () => {
    const s = replayAverageCost([
      { kind: 'entrada', qty: 100, unitCost: 10 },
      { kind: 'salida', qty: -60, unitCost: 10 },
      { kind: 'entrada', qty: 40, unitCost: 15 },
    ]);
    // quedaban 40 a $10; entran 40 a $15 → 12,5
    expect(s).toEqual({ onHand: 80, cost: 12.5 });
  });

  it('con existencia en cero o negativa manda el costo nuevo', () => {
    expect(
      averageCostAfter({ onHand: -5, cost: 3 }, { kind: 'entrada', qty: 10, unitCost: 9 }),
    ).toEqual({ onHand: 5, cost: 9 });
  });

  it('una entrada sin costo, un ajuste negativo o un traslado no lo mueven', () => {
    const start = { onHand: 10, cost: 7 };
    expect(averageCostAfter(start, { kind: 'entrada', qty: 5 }).cost).toBe(7);
    expect(averageCostAfter(start, { kind: 'ajuste', qty: -3, unitCost: 1 }).cost).toBe(7);
    expect(averageCostAfter(start, { kind: 'traslado', qty: 4, unitCost: 100 }).cost).toBe(7);
  });
});

describe('consumo', () => {
  const moves = [
    { kind: 'salida' as const, qty: -30, occurredOn: '2026-09-30' },
    { kind: 'salida' as const, qty: -60, occurredOn: '2026-08-01' },
    { kind: 'ajuste' as const, qty: -500, occurredOn: '2026-09-29' },
    { kind: 'entrada' as const, qty: 200, occurredOn: '2026-09-28' },
    { kind: 'salida' as const, qty: -999, occurredOn: '2026-05-01' },
  ];

  it('cuenta sólo salidas dentro de la ventana; un ajuste no es consumo', () => {
    const c = consumption(moves, TODAY, 90);
    expect(c.outQty).toBe(90);
    expect(c.daily).toBe(1);
    expect(c.weekly).toHaveLength(13);
    expect(c.weekly.at(-1)?.qty).toBe(30);
  });

  it('rotación anualizada', () => {
    const c = consumption(moves, TODAY, 90);
    // 90 en 90 días → 365 al año, con 73 en bodega → 5 vueltas
    expect(annualTurnover(73, c)).toBe(5);
    expect(annualTurnover(0, c)).toBeNull();
  });
});

describe('alerta de un producto', () => {
  const base = { daily: 0, leadTimeDays: null, lastMovementOn: '2026-09-30', today: TODAY };
  it('agotado, bajo mínimo, se agota, sin movimiento, al día', () => {
    expect(productAlert({ ...base, onHand: 0, minStock: 5 })).toBe('agotado');
    expect(productAlert({ ...base, onHand: 5, minStock: 5 })).toBe('bajo_minimo');
    expect(productAlert({ ...base, onHand: 20, minStock: 5, daily: 2, leadTimeDays: 10 })).toBe(
      'se_agota',
    );
    expect(productAlert({ ...base, onHand: 20, minStock: 5, lastMovementOn: '2026-05-01' })).toBe(
      'sin_movimiento',
    );
    expect(productAlert({ ...base, onHand: 20, minStock: 5 })).toBe('ok');
    expect(productAlert({ ...base, onHand: 0, minStock: 5, trackStock: false })).toBe('ok');
  });
});

describe('sugerencias de reposición', () => {
  const p = (over: Partial<ReorderInput>): ReorderInput => ({
    productId: 'p1',
    name: 'Tornillo',
    sku: 'T-1',
    unit: 'und',
    onHand: 10,
    onOrder: 0,
    minStock: 50,
    reorderQty: null,
    leadTimeDays: 10,
    daily: 3,
    unitCost: 100,
    supplierId: 's1',
    supplierName: 'Ferretería',
    ...over,
  });

  it('bajo el mínimo con cantidad de reposición: pide esa cantidad', () => {
    const s = reorderFor(p({ reorderQty: 200 }));
    expect(s?.qty).toBe(200);
    expect(s?.reason).toBe('bajo_minimo');
    expect(s?.lineTotal).toBe(20_000);
    expect(s?.why).toContain('cantidad de reposición');
  });

  it('la cantidad de reposición nunca queda por debajo del hueco al mínimo', () => {
    expect(reorderFor(p({ reorderQty: 10, onHand: 0 }))?.qty).toBe(50);
  });

  it('sin cantidad de reposición: hueco al mínimo + consumo de los días de entrega', () => {
    // hueco 40 + 3/día × 10 días = 70
    expect(reorderFor(p({}))?.qty).toBe(70);
  });

  it('lo que ya viene pedido cuenta: no se pide dos veces', () => {
    expect(reorderFor(p({ onOrder: 60 }))).toBeNull();
    expect(reorderFor(p({ onOrder: 20 }))?.qty).toBe(50);
  });

  it('sin mínimo: se pide si no alcanza para los días de entrega', () => {
    const s = reorderFor(p({ minStock: null, onHand: 20 }));
    expect(s?.reason).toBe('se_agota');
    expect(s?.qty).toBe(30);
    expect(reorderFor(p({ minStock: null, onHand: 40 }))).toBeNull();
    expect(reorderFor(p({ minStock: null, daily: 0 }))).toBeNull();
  });

  it('servicios e inactivos no se reponen', () => {
    expect(reorderFor(p({ trackStock: false }))).toBeNull();
    expect(reorderFor(p({ active: false }))).toBeNull();
  });

  it('agrupa por proveedor; lo que no tiene proveedor va al final', () => {
    const list = reorderSuggestions([
      p({ productId: 'a', supplierId: null, supplierName: null }),
      p({ productId: 'b', supplierId: 's2', supplierName: 'Otro', unitCost: null }),
      p({ productId: 'c' }),
      p({ productId: 'd', onHand: 0 }),
    ]);
    expect(list[0]?.productId).toBe('d');
    const groups = groupBySupplier(list);
    expect(groups.map((g) => g.supplierId)).toEqual(['s1', 's2', null]);
    expect(groups[0]?.lines).toHaveLength(2);
    expect(groups[1]?.missingCost).toBe(1);
  });
});

describe('órdenes de compra', () => {
  it('totales con IVA', () => {
    expect(
      poTotals([
        { qty: 10, unitCost: 1000, taxRate: 19 },
        { qty: 2, unitCost: 500 },
      ]),
    ).toEqual({ subtotal: 11_000, taxTotal: 1900, total: 12_900 });
  });

  it('recepción total, parcial y de más', () => {
    const lines = [
      { id: 'l1', qty: 10, qtyReceived: 0 },
      { id: 'l2', qty: 5, qtyReceived: 2 },
    ];
    const all = planReceipt(lines);
    expect(all.status).toBe('recibida');
    expect(all.receive).toEqual([
      { id: 'l1', qty: 10, qtyReceived: 10 },
      { id: 'l2', qty: 3, qtyReceived: 5 },
    ]);
    const part = planReceipt(lines, new Map([['l1', 4]]));
    expect(part.status).toBe('recibida_parcial');
    expect(part.receive).toEqual([{ id: 'l1', qty: 4, qtyReceived: 4 }]);
    const over = planReceipt(lines, new Map([['l2', 4]]));
    expect(over.errors[0]).toContain('no caben');
    expect(over.receive).toEqual([]);
    expect(planReceipt([{ id: 'l1', qty: 1, qtyReceived: 1 }]).errors).toEqual([
      'No hay nada pendiente por recibir.',
    ]);
    expect(planReceipt(lines, new Map([['otra', 1]])).errors).toContain(
      'Una de las líneas no es de esta orden.',
    );
  });

  it('estados: no se cancela lo recibido, no se salta la aprobación hacia atrás', () => {
    expect(canMovePo('borrador', 'por_aprobar')).toBe(true);
    expect(canMovePo('por_aprobar', 'aprobada')).toBe(true);
    expect(canMovePo('recibida', 'cancelada')).toBe(false);
    expect(canMovePo('cerrada', 'aprobada')).toBe(false);
    expect(canMovePo('enviada', 'por_aprobar')).toBe(false);
  });

  it('número de la orden', () => {
    expect(poLabel(7)).toBe('OC-0007');
    expect(parsePoNumber('OC-0007')).toBe(7);
    expect(parsePoNumber('oc 12')).toBe(12);
    expect(parsePoNumber('Ferretería')).toBeNull();
  });

  it('vencimiento esperado: llegada + plazo', () => {
    expect(expectedPaymentDue({ approvedOn: TODAY, expectedOn: '2026-10-10', termsDays: 30 })).toBe(
      '2026-11-09',
    );
    expect(expectedPaymentDue({ approvedOn: TODAY, expectedOn: null, termsDays: 0 })).toBe(TODAY);
  });
});

describe('hoja de productos', () => {
  it('números colombianos', () => {
    expect(parseNumberCo('$ 12.500')).toBe(12_500);
    expect(parseNumberCo('1.234,5')).toBe(1234.5);
    expect(parseNumberCo('1,234.50')).toBe(1234.5);
    expect(parseNumberCo('12,5')).toBe(12.5);
    expect(parseNumberCo('1.500')).toBe(1500);
    expect(parseNumberCo('2.5')).toBe(2.5);
    expect(parseNumberCo('(30)')).toBe(-30);
    expect(parseNumberCo('n/a')).toBeNull();
    expect(parseNumberCo('')).toBeNull();
  });

  it('reconoce columnas en español, con «;» y comillas', () => {
    const rows = parseCsv(
      '﻿Código;Descripción;Existencias;Mínimo;Costo unitario;Proveedor;Color\n' +
        'T-1;"Tornillo 10mm; galvanizado";120;50;$ 1.200;Ferretería Central;gris\n' +
        ';;;;;;\n' +
        ';;5;;;;\n',
    );
    const r = parseProductSheet(rows);
    expect(r.recognized).toMatchObject({
      sku: 'Código',
      name: 'Descripción',
      stock: 'Existencias',
    });
    expect(r.ignored).toEqual(['Color']);
    expect(r.drafts).toHaveLength(1);
    expect(r.drafts[0]).toMatchObject({
      sku: 'T-1',
      name: 'Tornillo 10mm; galvanizado',
      stock: 120,
      minStock: 50,
      cost: 1200,
      supplierName: 'Ferretería Central',
    });
    expect(r.skipped).toEqual([{ row: 2, reason: 'sin nombre ni código' }]);
  });
});
