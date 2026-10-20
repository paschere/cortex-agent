import { describe, expect, it } from 'vitest';
import { previewModeOf, previewQuery } from './preview-query';

describe('«Ver como…» en modo prueba', () => {
  it('la dirección lleva el modo y se lee de vuelta', () => {
    expect(previewQuery('operario', undefined, 'prueba')).toBe('?como=operario&modo=prueba');
    expect(previewQuery('cliente', { cliente: 'Andina' }, 'prueba')).toBe(
      '?como=cliente&atr=cliente%3AAndina&modo=prueba',
    );
    expect(previewQuery('operario', undefined, null)).toBe('?como=operario');
    expect(previewModeOf('prueba')).toBe('prueba');
    expect(previewModeOf(['prueba', 'x'])).toBe('prueba');
  });
  it('cualquier otra cosa es datos reales', () => {
    expect(previewModeOf('real')).toBeNull();
    expect(previewModeOf(undefined)).toBeNull();
    expect(previewModeOf('')).toBeNull();
  });
});
