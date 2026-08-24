import { describe, expect, it } from 'vitest';
import { figuresForTts } from './voice-figures';

describe('figuresForTts', () => {
  it('expande una TRM colombiana a palabras', () => {
    expect(figuresForTts('La TRM está en 4.247,52 pesos.')).toBe(
      'La TRM está en cuatro mil doscientos cuarenta y siete con cincuenta y dos pesos.',
    );
  });

  it('deja un conteo chico en dígitos', () => {
    expect(figuresForTts('Hay 3 opciones.')).toBe('Hay 3 opciones.');
  });
});
