import { describe, expect, it } from 'vitest';
import { cacheSavingsUsd, formatUsd, rateFor, stepCostUsd } from './model-pricing';

describe('rateFor', () => {
  it('cobra sonnet-5 a precio intro hasta el 31 de agosto de 2026 inclusive', () => {
    expect(rateFor('claude-sonnet-5', '2026-08-31T23:59:00Z')).toEqual({
      inputPerMTok: 2,
      outputPerMTok: 10,
    });
    expect(rateFor('claude-sonnet-5', '2026-09-01T00:00:00Z')).toEqual({
      inputPerMTok: 3,
      outputPerMTok: 15,
    });
  });

  it('acepta ids cualificados con proveedor', () => {
    expect(rateFor('anthropic/claude-haiku-4-5', '2026-08-15')).toEqual({
      inputPerMTok: 1,
      outputPerMTok: 5,
    });
  });

  it('devuelve null para modelos que no sabe cobrar, en vez de inventar', () => {
    expect(rateFor('gemini-2.5-pro', '2026-08-15')).toBeNull();
  });
});

describe('stepCostUsd', () => {
  const sonnetIntro = { inputPerMTok: 2, outputPerMTok: 10 };

  it('descuenta el caché como Anthropic: lectura a 0.1x, escritura a 1.25x', () => {
    // 1M de cada cosa para que los números se lean solos:
    // entrada 1M×$2 + lectura 1M×$0.2 + escritura 1M×$2.5 + salida 1M×$10
    const usd = stepCostUsd(sonnetIntro, {
      input: 1_000_000,
      cacheRead: 1_000_000,
      cacheWrite: 1_000_000,
      output: 1_000_000,
    });
    expect(usd).toBeCloseTo(2 + 0.2 + 2.5 + 10, 6);
  });

  it('no deja que un contador negativo (dato corrupto) reste plata', () => {
    expect(stepCostUsd(sonnetIntro, { input: -5, cacheRead: 0, cacheWrite: 0, output: 0 })).toBe(0);
  });
});

describe('cacheSavingsUsd', () => {
  it('el ahorro es el 90% del precio de entrada sobre lo leído', () => {
    // 1M leídos a $2/MTok: habrían costado $2, costaron $0.2 → ahorro $1.8
    expect(cacheSavingsUsd({ inputPerMTok: 2, outputPerMTok: 10 }, 1_000_000)).toBeCloseTo(1.8, 6);
  });
});

describe('formatUsd', () => {
  it('adapta los decimales al tamaño', () => {
    expect(formatUsd(0)).toBe('$0');
    expect(formatUsd(0.0042)).toBe('$0.0042');
    expect(formatUsd(0.042)).toBe('$0.042');
    expect(formatUsd(4.83)).toBe('$4.83');
    expect(formatUsd(483.2)).toBe('$483');
  });
});
