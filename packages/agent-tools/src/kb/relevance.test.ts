import { describe, expect, it } from 'vitest';
import { STRONG_MATCH, WEAK_FLOOR, assessCoverage, rateHit } from './relevance';

/**
 * These tests pin the two behaviours the thresholds exist for, in both
 * directions — because getting this wrong in EITHER direction is a bug:
 * a brain that answers from noise, and a brain that says "no sé" to things it
 * knows perfectly well. The numbers in the fixtures are real cosine
 * similarities from the measured corpus documented in relevance.ts.
 */

const hit = (semanticScore: number | null, keywordScore = 0) => ({
  semanticScore,
  keywordScore,
});

describe('rateHit', () => {
  it('rates a passage that answers the question as strong', () => {
    // Measured top-1 for "¿cuál es la tarifa mensual de un React senior?".
    expect(rateHit(hit(0.674))).toBe('strong');
    // The weakest question the corpus genuinely answers.
    expect(rateHit(hit(0.582))).toBe('strong');
  });

  it('rates a plausible-but-unanswered question as weak, and still returns it', () => {
    // "tarifas de un ingeniero de datos senior" pulls up the rate card, which
    // has no line for that role. Returning it labelled beats hiding it.
    expect(rateHit(hit(0.475))).toBe('weak');
    expect(rateHit(hit(0.46))).toBe('weak');
  });

  it('drops what is only the least-bad row in the index', () => {
    // Measured tops for "receta de arepas", "capital de Mongolia".
    expect(rateHit(hit(0.349))).toBeNull();
    expect(rateHit(hit(0.317))).toBeNull();
  });

  it('treats an unmeasured similarity as unmeasured, never as a miss', () => {
    // Keyword-only retrieval: null is not 0. A literal word match is evidence.
    expect(rateHit(hit(null, 0.27))).toBe('weak');
    expect(rateHit(hit(null, 0))).toBeNull();
  });

  it('puts the boundaries exactly where they are documented', () => {
    expect(rateHit(hit(STRONG_MATCH))).toBe('strong');
    expect(rateHit(hit(STRONG_MATCH - 0.001))).toBe('weak');
    expect(rateHit(hit(WEAK_FLOOR))).toBe('weak');
    expect(rateHit(hit(WEAK_FLOOR - 0.001))).toBeNull();
  });
});

describe('assessCoverage', () => {
  it('says it found the answer when it did', () => {
    const v = assessCoverage([hit(0.66), hit(0.48)], { query: 'tarifa React senior' });
    expect(v.coverage).toBe('answered');
    expect(v.kept).toHaveLength(2);
    expect(v.kept[0]?.relevance).toBe('strong');
    expect(v.kept[1]?.relevance).toBe('weak');
  });

  it('says out loud that it only has something tangential', () => {
    const v = assessCoverage([hit(0.48), hit(0.46)], { query: 'plan de acciones' });
    expect(v.coverage).toBe('thin');
    // The model must be told to present it as tangential, not as the answer.
    expect(v.summary).toMatch(/tangencial|apenas relacionado/i);
    expect(v.kept).toHaveLength(2);
  });

  it('says "there is nothing" instead of handing over the nearest rows', () => {
    const v = assessCoverage([hit(0.38), hit(0.35), hit(0.31)], {
      query: 'receta de arepas de choclo',
    });
    expect(v.coverage).toBe('nothing');
    expect(v.kept).toEqual([]);
    expect(v.discarded).toBe(3);
    // The whole point: the sentence has to be usable as an answer.
    expect(v.summary).toContain('No hay nada');
    expect(v.summary).toContain('receta de arepas de choclo');
  });

  it('never reports an empty result as proof of absence when only keywords ran', () => {
    const v = assessCoverage([], { query: 'tarifas', degraded: true });
    expect(v.coverage).toBe('keyword-only');
    expect(v.summary).toMatch(/NO quiere decir que no haya nada/i);
  });

  it('names the space when the search was narrowed to one', () => {
    const v = assessCoverage([], { query: 'vacaciones', spaceName: 'Legal' });
    expect(v.summary).toContain('«Legal»');
  });

  it('reports an empty search as nothing, not as an error', () => {
    const v = assessCoverage([], { query: 'lo que sea' });
    expect(v.coverage).toBe('nothing');
    expect(v.bestScore).toBeNull();
    expect(v.summary.length).toBeGreaterThan(0);
  });
});
