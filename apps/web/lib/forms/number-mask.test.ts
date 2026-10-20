import { describe, expect, it } from 'vitest';
import { canonicalOf, displayOf, maskTyping } from './number-mask';

const money = { decimals: 0 };
const dec = { decimals: 2, negative: true };

describe('maskTyping', () => {
  it('agrupa los miles con punto', () => {
    expect(maskTyping('1250000', money)).toBe('1.250.000');
    expect(maskTyping('1.250.0000', money)).toBe('12.500.000');
  });
  it('en pesos completos no deja decimales', () => {
    expect(maskTyping('1250,5', money)).toBe('1.250');
  });
  it('conserva la coma del final para seguir escribiendo', () => {
    expect(maskTyping('12,', dec)).toBe('12,');
    expect(maskTyping(',5', dec)).toBe('0,5');
  });
  it('recorta los decimales sobrantes', () => {
    expect(maskTyping('3,14159', dec)).toBe('3,14');
  });
  it('el punto no es decimal y las letras no entran', () => {
    expect(maskTyping('2.5', dec)).toBe('25');
    expect(maskTyping('a1b2', money)).toBe('12');
  });
  it('negativos sólo si se permiten', () => {
    expect(maskTyping('-12', dec)).toBe('-12');
    expect(maskTyping('-12', money)).toBe('12');
    expect(maskTyping('-', dec)).toBe('-');
  });
  it('quita ceros a la izquierda', () => {
    expect(maskTyping('00012', money)).toBe('12');
    expect(maskTyping('0', money)).toBe('0');
  });
});

describe('canonicalOf / displayOf', () => {
  it('ida y vuelta', () => {
    expect(canonicalOf('1.250.000,5')).toBe('1250000.5');
    expect(canonicalOf('12,')).toBe('12');
    expect(canonicalOf('')).toBe('');
    expect(canonicalOf('-')).toBe('');
    expect(displayOf('1250000.5', dec)).toBe('1.250.000,5');
    expect(displayOf('1250000', money)).toBe('1.250.000');
    expect(displayOf('abc', money)).toBe('');
  });
});
