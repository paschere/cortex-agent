import { describe, expect, it } from 'vitest';
import { formatMoney, isNewFromZero, pctChange } from './forecast-shared';

describe('formatMoney: la unidad se elige después de redondear', () => {
  it('999.950.000 es «$ 1 mil M», no «$ 1000 M» ni «$ 999,9 M»', () => {
    expect(formatMoney(999_950_000)).toBe('$ 1 mil M');
    expect(formatMoney(999_949_999)).toBe('$ 999,9 M');
    expect(formatMoney(1_000_000_000)).toBe('$ 1 mil M');
    expect(formatMoney(1_240_000_000)).toBe('$ 1,2 mil M');
  });

  it('999.500 es «$ 1 M» y 999.499 es «$ 999 mil»', () => {
    expect(formatMoney(999_500)).toBe('$ 1 M');
    expect(formatMoney(999_499)).toBe('$ 999 mil');
    expect(formatMoney(1_000)).toBe('$ 1 mil');
    expect(formatMoney(999)).toBe('$ 999');
  });

  it('el signo, el cero negativo y lo no finito', () => {
    expect(formatMoney(-999_950_000)).toBe('−$ 1 mil M');
    expect(formatMoney(-0.4)).toBe('$ 0');
    expect(formatMoney(Number.NaN)).toBe('—');
    expect(formatMoney(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('otra moneda nunca lleva el signo del peso', () => {
    expect(formatMoney(12_000, 'usd')).toBe('12.000 USD');
    expect(formatMoney(-1_500, 'EUR')).toBe('−1.500 EUR');
  });
});

describe('pctChange: una sola definición, sin ±Infinity ni NaN', () => {
  it('cambio normal y base negativa (mejorar una pérdida es positivo)', () => {
    expect(pctChange(125, 100)).toBeCloseTo(0.25);
    expect(pctChange(50, 100)).toBeCloseTo(-0.5);
    expect(pctChange(-50, -100)).toBeCloseTo(0.5);
    expect(pctChange(-150, -100)).toBeCloseTo(-0.5);
  });

  it('base cero, ausente o ilegible devuelve null', () => {
    expect(pctChange(100, 0)).toBeNull();
    expect(pctChange(100, 0.4)).toBeNull();
    expect(pctChange(100, null)).toBeNull();
    expect(pctChange(100, undefined)).toBeNull();
    expect(pctChange(100, Number.NaN)).toBeNull();
    expect(pctChange(Number.POSITIVE_INFINITY, 100)).toBeNull();
  });

  it('un salto de más de 100 veces la base no se dibuja como porcentaje', () => {
    expect(pctChange(1_000_000, 1)).toBeNull();
    expect(pctChange(10_000, 100)).toBeCloseTo(99);
    expect(pctChange(10_200, 100)).toBeNull();
  });

  it('«nuevo» sólo cuando aparece algo donde había cero', () => {
    expect(isNewFromZero(500, 0)).toBe(true);
    expect(isNewFromZero(1_000_000, 1)).toBe(true);
    expect(isNewFromZero(0, 0)).toBe(false);
    expect(isNewFromZero(500, null)).toBe(false);
    expect(isNewFromZero(500, 100)).toBe(false);
  });
});
