import { describe, expect, it } from 'vitest';
import {
  UVT_2026,
  displayTotal,
  documentTotals,
  formatMoney,
  lineTotals,
  roundCents,
  roundPesos,
  withholdingWarnings,
} from './totals';

describe('una línea', () => {
  it('IVA 19 % sobre la base después del descuento', () => {
    expect(lineTotals({ quantity: 10, unitPrice: 1_200_000, taxRate: 'iva_19' })).toEqual({
      gross: 12_000_000,
      discount: 0,
      base: 12_000_000,
      iva: 2_280_000,
      lineTotal: 14_280_000,
    });
    const discounted = lineTotals({
      quantity: 3,
      unitPrice: 100_000,
      discountPct: 10,
      taxRate: 'iva_19',
    });
    expect(discounted).toMatchObject({ gross: 300_000, discount: 30_000, base: 270_000 });
    expect(discounted.iva).toBe(51_300);
  });

  it('IVA 5 %, exento y excluido', () => {
    expect(lineTotals({ quantity: 1, unitPrice: 1000, taxRate: 'iva_5' }).iva).toBe(50);
    expect(lineTotals({ quantity: 1, unitPrice: 1000, taxRate: 'iva_0' }).iva).toBe(0);
    expect(lineTotals({ quantity: 1, unitPrice: 1000, taxRate: 'excluido' })).toMatchObject({
      iva: 0,
      lineTotal: 1000,
    });
  });

  it('sin tarifa es IVA 19 % (lo general en Colombia)', () => {
    expect(lineTotals({ quantity: 1, unitPrice: 100 }).iva).toBe(19);
  });

  it('cantidades fraccionarias y redondeo al centavo, mitad hacia arriba', () => {
    // 2,5 × 1.333,33 = 3.333,325 → 3.333,33
    expect(lineTotals({ quantity: 2.5, unitPrice: 1333.33, taxRate: 'excluido' }).gross).toBe(
      3333.33,
    );
    expect(roundCents(1.005)).toBe(1.01);
    expect(roundCents(-1.005)).toBe(-1.01);
  });

  it('valores imposibles no rompen la cuenta', () => {
    expect(lineTotals({ quantity: -2, unitPrice: 100 }).lineTotal).toBe(0);
    expect(lineTotals({ quantity: 1, unitPrice: Number.NaN }).lineTotal).toBe(0);
    expect(lineTotals({ quantity: 1, unitPrice: 100, discountPct: 150 }).base).toBe(0);
  });
});

describe('el documento', () => {
  const lines = [
    { quantity: 10, unitPrice: 1_200_000, taxRate: 'iva_19' as const },
    { quantity: 2, unitPrice: 50_000, discountPct: 10, taxRate: 'iva_5' as const },
    { quantity: 1, unitPrice: 80_000, taxRate: 'excluido' as const },
  ];

  it('suma las líneas ya redondeadas', () => {
    const t = documentTotals(lines);
    expect(t.subtotal).toBe(12_180_000);
    expect(t.discountTotal).toBe(10_000);
    expect(t.taxBase).toBe(12_170_000);
    expect(t.taxableBase).toBe(12_090_000);
    expect(t.ivaTotal).toBe(2_280_000 + 4_500);
    expect(t.total).toBe(12_170_000 + 2_284_500);
    expect(t.netTotal).toBe(t.total);
    expect(t.ivaByRate.map((r) => r.rate)).toEqual(['iva_19', 'iva_5', 'excluido']);
  });

  it('retención en la fuente, ICA e IVA bajan el neto, no el total', () => {
    const t = documentTotals(lines, { retefuentePct: 4, reteicaPerMil: 9.66, reteivaPct: 15 });
    expect(t.retefuente).toBe(486_800);
    expect(t.reteica).toBe(117_562.2);
    expect(t.reteiva).toBe(342_675);
    expect(t.total).toBe(14_454_500);
    expect(t.netTotal).toBe(roundCents(14_454_500 - 486_800 - 117_562.2 - 342_675));
  });

  it('una retención absurda se topa', () => {
    const t = documentTotals([{ quantity: 1, unitPrice: 1000 }], { retefuentePct: 90 });
    expect(t.retefuente).toBe(200);
  });

  it('sin líneas todo es cero', () => {
    const t = documentTotals([]);
    expect(t.total).toBe(0);
    expect(t.ivaByRate).toEqual([]);
  });
});

describe('pesos y avisos', () => {
  it('el total en COP se muestra al peso y nombra el ajuste', () => {
    expect(displayTotal(1190.5)).toEqual({ value: 1191, rounding: 0.5 });
    expect(displayTotal(1190.49)).toEqual({ value: 1190, rounding: -0.49 });
    expect(displayTotal(10.5, 'USD')).toEqual({ value: 10.5, rounding: 0 });
    expect(roundPesos(-2.5)).toBe(-3);
  });

  it('formatea como en Colombia', () => {
    expect(formatMoney(12_000_000)).toBe('$12.000.000');
    expect(formatMoney(1234.5)).toBe('$1.234,50');
    expect(formatMoney(10, 'USD')).toBe('USD 10');
  });

  it('avisa cuando la base no llega a la mínima de retención por servicios', () => {
    const small = documentTotals([{ quantity: 1, unitPrice: 100_000 }], { retefuentePct: 4 });
    expect(withholdingWarnings(small, { retefuentePct: 4 })[0]).toMatch(/4 UVT/);
    const big = documentTotals([{ quantity: 1, unitPrice: 5 * UVT_2026 }], { retefuentePct: 4 });
    expect(withholdingWarnings(big, { retefuentePct: 4 })).toEqual([]);
    const noIva = documentTotals([{ quantity: 1, unitPrice: 1, taxRate: 'excluido' }]);
    expect(withholdingWarnings(noIva, { reteivaPct: 15 })[0]).toMatch(/ReteIVA/);
  });
});
