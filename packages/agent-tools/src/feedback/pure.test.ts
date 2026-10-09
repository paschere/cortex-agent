import { describe, expect, it } from 'vitest';
import { cleanComment, inferCorrectionKind, looksLikeCorrection } from './pure';

describe('looksLikeCorrection', () => {
  it('acepta hechos y reglas', () => {
    expect(looksLikeCorrection('el precio es 0,80 por kilo')).toBe(true);
    expect(looksLikeCorrection('a ese cliente no se le escribe los viernes')).toBe(true);
    expect(looksLikeCorrection('Siempre cotiza en dólares para Nexa')).toBe(true);
  });
  it('rechaza quejas sin contenido', () => {
    expect(looksLikeCorrection('está mal')).toBe(false);
    expect(looksLikeCorrection('muy lento')).toBe(false);
    expect(looksLikeCorrection('')).toBe(false);
    expect(looksLikeCorrection(null)).toBe(false);
    expect(looksLikeCorrection('no entendió lo que quise decir con eso')).toBe(false);
  });
});

describe('inferCorrectionKind', () => {
  it('clasifica', () => {
    expect(inferCorrectionKind('el precio es 0,80 por kilo')).toBe('price');
    expect(inferCorrectionKind('a ese cliente no se le escribe los viernes')).toBe('process');
  });
});

describe('cleanComment', () => {
  it('colapsa espacios y devuelve null si queda vacío', () => {
    expect(cleanComment('  hola   mundo ')).toBe('hola mundo');
    expect(cleanComment('   ')).toBeNull();
  });
});
