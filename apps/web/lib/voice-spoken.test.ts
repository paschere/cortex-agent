import { describe, expect, it } from 'vitest';
import { takeSpokenClauses, wantsLiveLookup } from './voice-spoken';

describe('takeSpokenClauses', () => {
  it('corta en oraciones, no a mitad de un «hola»', () => {
    expect(takeSpokenClauses('Hola. Qué tal. más')).toEqual({
      clauses: ['Hola.', 'Qué tal.'],
      rest: 'más',
    });
  });

  it('no parte una TRM colombiana en la primera cifra', () => {
    expect(takeSpokenClauses('La TRM está en 4.247,52 pesos. Sobre la DIAN hay plazo.')).toEqual({
      clauses: ['La TRM está en 4.247,52 pesos.'],
      rest: 'Sobre la DIAN hay plazo.',
    });
  });

  it('no corta en la coma de un inciso', () => {
    expect(takeSpokenClauses('Hoy la TRM, según Banrep, es 4123 pesos. Listo.')).toEqual({
      clauses: ['Hoy la TRM, según Banrep, es 4123 pesos.'],
      rest: 'Listo.',
    });
  });

  it('no dispara con un punto de miles a mitad de stream', () => {
    expect(takeSpokenClauses('La TRM está en 4.')).toEqual({
      clauses: [],
      rest: 'La TRM está en 4.',
    });
  });
});

describe('wantsLiveLookup', () => {
  it('pide consulta para la TRM y la DIAN', () => {
    expect(wantsLiveLookup('cuál es la TRM del día')).toBe(true);
    expect(wantsLiveLookup('qué dijo la DIAN del plazo')).toBe(true);
  });

  it('no dispara en un saludo ni en el CRM', () => {
    expect(wantsLiveLookup('hola cómo estás')).toBe(false);
    expect(wantsLiveLookup('cuánto le cotizamos a Acme')).toBe(false);
    expect(wantsLiveLookup('qué hablamos hoy')).toBe(false);
  });
});
