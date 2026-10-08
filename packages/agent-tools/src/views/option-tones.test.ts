import { describe, expect, it } from 'vitest';
import { optionTones } from './compute';

describe('optionTones', () => {
  it('colorea por lo que la opción dice, no por su posición', () => {
    expect(optionTones(['Programado', 'En vuelo', 'Demorado', 'Aterrizó', 'Cancelado'])).toEqual([
      'primary',
      'sky',
      'amber',
      'emerald',
      'rose',
    ]);
  });
  it('lo incompleto no es verde', () => {
    expect(optionTones(['Incompleto', 'Completo'])).toEqual(['amber', 'emerald']);
  });
  it('sin significado, reparte por orden sin repetir vecinos', () => {
    expect(new Set(optionTones(['Norte', 'Sur', 'Centro'])).size).toBe(3);
  });
});
