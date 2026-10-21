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

  it('cobra la generación 5.5 a su tarifa plana, sin confundirla con sus prefijos', () => {
    expect(rateFor('claude-sonnet-5-5', '2026-10-21')).toEqual({
      inputPerMTok: 2,
      outputPerMTok: 10,
    });
    expect(rateFor('claude-sonnet-5-5', '2026-08-01')).toEqual({
      inputPerMTok: 2,
      outputPerMTok: 10,
    });
    expect(rateFor('anthropic/claude-opus-5-5', '2026-10-21')).toMatchObject({
      inputPerMTok: 4,
      outputPerMTok: 20,
      cacheReadMultiplier: 0.05,
    });
    expect(rateFor('claude-haiku-5-5', '2026-10-21')).toMatchObject({
      inputPerMTok: 0.1,
      outputPerMTok: 0.5,
      longPrompt: { aboveTokens: 100_000, inputPerMTok: 0.5, outputPerMTok: 2.5 },
    });
  });

  it('conserva las tarifas históricas de los modelos anteriores', () => {
    expect(rateFor('claude-opus-5', '2026-09-01')).toEqual({ inputPerMTok: 5, outputPerMTok: 25 });
    expect(rateFor('claude-sonnet-5', '2026-09-01')).toEqual({
      inputPerMTok: 3,
      outputPerMTok: 15,
    });
    expect(rateFor('claude-haiku-4-5', '2026-09-01')).toEqual({
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

describe('stepCostUsd en la generación 5.5', () => {
  it('Opus 5.5 lee el caché a $0,20 por millón (0,05× de $4)', () => {
    const rate = rateFor('claude-opus-5-5', '2026-10-21');
    if (!rate) throw new Error('sin tarifa');
    expect(
      stepCostUsd(rate, { input: 0, cacheRead: 1_000_000, cacheWrite: 0, output: 0 }),
    ).toBeCloseTo(0.2, 6);
    expect(
      stepCostUsd(rate, { input: 0, cacheRead: 0, cacheWrite: 1_000_000, output: 0 }),
    ).toBeCloseTo(5, 6);
  });

  it('Sonnet 5.5 lee el caché a $0,20 por millón (0,1× de $2)', () => {
    const rate = rateFor('claude-sonnet-5-5', '2026-10-21');
    if (!rate) throw new Error('sin tarifa');
    expect(
      stepCostUsd(rate, { input: 0, cacheRead: 1_000_000, cacheWrite: 0, output: 0 }),
    ).toBeCloseTo(0.2, 6);
  });

  it('Haiku 5.5: tramo corto hasta 100K de prompt', () => {
    const rate = rateFor('claude-haiku-5-5', '2026-10-21');
    if (!rate) throw new Error('sin tarifa');
    // 100K de prompt exactos: sigue en el tramo corto. 100K×$0,10 + 1M×$0,50.
    const usd = stepCostUsd(rate, {
      input: 100_000,
      cacheRead: 0,
      cacheWrite: 0,
      output: 1_000_000,
    });
    expect(usd).toBeCloseTo(0.01 + 0.5, 6);
  });

  it('Haiku 5.5: por encima de 100K de prompt todo se cobra al tramo largo', () => {
    const rate = rateFor('claude-haiku-5-5', '2026-10-21');
    if (!rate) throw new Error('sin tarifa');
    // 200K sin caché ×$0,50 + 1M de salida ×$2,50.
    const usd = stepCostUsd(rate, {
      input: 200_000,
      cacheRead: 0,
      cacheWrite: 0,
      output: 1_000_000,
    });
    expect(usd).toBeCloseTo(0.1 + 2.5, 6);
    // El caché cuenta como prompt: 90K nuevos + 20K leídos = 110K → tramo largo.
    const cached = stepCostUsd(rate, {
      input: 90_000,
      cacheRead: 20_000,
      cacheWrite: 0,
      output: 0,
    });
    expect(cached).toBeCloseTo(90_000 * 0.5e-6 + 20_000 * 0.5e-6 * 0.1, 9);
  });

  it('Haiku 5.5: el tramo se decide por petición, no por la suma de los pasos del turno', () => {
    const rate = rateFor('claude-haiku-5-5', '2026-10-21');
    if (!rate) throw new Error('sin tarifa');
    // 4 pasos de 60K = 240K en total, pero ninguna petición pasa de 100K.
    const perStep = stepCostUsd(
      rate,
      { input: 240_000, cacheRead: 0, cacheWrite: 0, output: 0 },
      4,
    );
    expect(perStep).toBeCloseTo(240_000 * 0.1e-6, 9);
  });
});

describe('cacheSavingsUsd', () => {
  it('el ahorro es el 90% del precio de entrada sobre lo leído', () => {
    // 1M leídos a $2/MTok: habrían costado $2, costaron $0.2 → ahorro $1.8
    expect(cacheSavingsUsd({ inputPerMTok: 2, outputPerMTok: 10 }, 1_000_000)).toBeCloseTo(1.8, 6);
    // Opus 5.5 ahorra el 95 %: $4 → $0,20.
    expect(
      cacheSavingsUsd({ inputPerMTok: 4, outputPerMTok: 20, cacheReadMultiplier: 0.05 }, 1_000_000),
    ).toBeCloseTo(3.8, 6);
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
