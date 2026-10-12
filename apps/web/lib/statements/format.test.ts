import { describe, expect, it } from 'vitest';
import { change, isNewFromZero, shortMoney } from './format';

describe('formatos de estados', () => {
  it('shortMoney usa la misma regla de unidades que el resto de Finanzas', () => {
    expect(shortMoney(999_950_000)).toBe('$ 1 mil millones');
    expect(shortMoney(999_500)).toBe('$ 999.500');
    expect(shortMoney(38_500_000)).toBe('$ 38.500.000');
    expect(shortMoney(-3_200_000)).toBe('−$ 3.200.000');
  });

  it('change nunca devuelve Infinity ni NaN: base cero es «nuevo»', () => {
    expect(change(100, 0)).toBeNull();
    expect(isNewFromZero(100, 0)).toBe(true);
    expect(change(150, 100)).toBeCloseTo(0.5);
    expect(change(Number.NaN, 100)).toBeNull();
  });
});
