import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CALIBRATION,
  STRONG_MATCH,
  WEAK_FLOOR,
  assessCoverage,
  queryNamesDocument,
  rateHit,
} from './relevance';

/**
 * These tests pin the two behaviours the thresholds exist for, in both
 * directions — because getting this wrong in EITHER direction is a bug:
 * a brain that answers from noise, and a brain that says "no sé" to things it
 * knows perfectly well. The second one is what shipped, and the numbers in the
 * fixtures below are real cosine similarities from the measured corpus
 * documented in relevance.ts, on the model this deployment actually runs.
 *
 * That a calibration has to be named to rate a hit at all is the structural
 * half of the fix; `__tests__/relevance-calibration.test.ts` covers it.
 */

const cal = DEFAULT_CALIBRATION;

const hit = (semanticScore: number | null, keywordScore = 0) => ({
  semanticScore,
  keywordScore,
});

describe('rateHit', () => {
  it('rates a passage that answers the question as strong', () => {
    // Measured top-1 for "¿qué tengo que hacer la primera semana de onboarding?".
    expect(rateHit(hit(0.633), cal)).toBe('strong');
    // The weakest question the corpus genuinely answers — and the real one:
    // "¿plan de arranque de cortex?" against the BBIC start-up plan, the query
    // that was being discarded outright before this recalibration.
    expect(rateHit(hit(0.489), cal)).toBe('strong');
  });

  it('rates a plausible-but-unanswered question as weak, and still returns it', () => {
    // "tarifa de un ingeniero de datos senior" pulls up the contract's rate
    // clause, which has no line for that role. Returning it labelled beats
    // hiding it.
    expect(rateHit(hit(0.448), cal)).toBe('weak');
    expect(rateHit(hit(0.394), cal)).toBe('weak');
  });

  it('drops what is only the least-bad row in the index', () => {
    // Measured tops for "altura del Nevado del Ruiz", "cómo se poda un rosal".
    expect(rateHit(hit(0.247), cal)).toBeNull();
    expect(rateHit(hit(0.216), cal)).toBeNull();
  });

  it('treats an unmeasured similarity as unmeasured, never as a miss', () => {
    // Keyword-only retrieval: null is not 0. A literal word match is evidence.
    expect(rateHit(hit(null, 0.27), cal)).toBe('weak');
    expect(rateHit(hit(null, 0), cal)).toBeNull();
  });

  it('puts the boundaries exactly where they are documented', () => {
    expect(rateHit(hit(STRONG_MATCH), cal)).toBe('strong');
    expect(rateHit(hit(STRONG_MATCH - 0.001), cal)).toBe('weak');
    expect(rateHit(hit(WEAK_FLOOR), cal)).toBe('weak');
    expect(rateHit(hit(WEAK_FLOOR - 0.001), cal)).toBeNull();
  });
});

/**
 * The second kind of evidence, and the reason the strong cut did NOT have to
 * move. On the evaluation corpus the question that started all of this scores
 * 0.458 against a cut of 0.46, and every cut low enough to admit it also admits
 * questions the corpus does not answer — the sweep is in relevance.ts. So a
 * passage from a document the question NAMED is read as an answer instead.
 */
describe('naming a document', () => {
  const PLAN = 'CÓRTEX · Plan de arranque para BBIC S.A.S.';

  it('recognises the question that started this, typed the way it was typed', () => {
    expect(queryNamesDocument('¿plan de arranque de cortex?', PLAN)).toBe(true);
    // Accents and case are the person's business, not the rule's.
    expect(queryNamesDocument('plan de arranque cortex', PLAN)).toBe(true);
  });

  it('needs every word, because partial credit is what would let the misses in', () => {
    // Measured on the evaluation corpus: the best a question the corpus does not
    // answer manages is one content word out of four.
    expect(
      queryNamesDocument(
        'cual es la penalidad por terminar el contrato con bbic',
        'Contrato de prestación de servicios — Nexa Logística S.A.S.',
      ),
    ).toBe(false);
    expect(
      queryNamesDocument(
        'licencia de paternidad cuantas semanas da cortex',
        'Política de vacaciones y ausencias',
      ),
    ).toBe(false);
    // A word the title does not carry is enough to stop it, on purpose: the rule
    // fails closed and leaves the cosine to decide.
    expect(queryNamesDocument('cuando arranca el plan de cortex', PLAN)).toBe(false);
  });

  it('refuses to be satisfied by a single word', () => {
    // "cortex" is in half these titles. One word names nothing.
    expect(queryNamesDocument('cortex', PLAN)).toBe(false);
    expect(queryNamesDocument('¿el plan?', PLAN)).toBe(false);
  });

  it('promotes a named document over the cut, and only from inside the band', () => {
    const named = { semanticScore: 0.458, keywordScore: 0, documentTitle: PLAN };
    expect(rateHit(named, cal, '¿plan de arranque de cortex?')).toBe('strong');
    // Same hit, nobody passed the question: the cosine decides, as before.
    expect(rateHit(named, cal)).toBe('weak');
    // Below the floor it cannot be resurrected — a promotion may re-read a
    // passage that was going to be shown, never bring back a discarded one.
    const belowFloor = { semanticScore: 0.2, keywordScore: 0, documentTitle: PLAN };
    expect(rateHit(belowFloor, cal, '¿plan de arranque de cortex?')).toBeNull();
  });

  it('turns the verdict into an answer, which is the whole point', () => {
    const v = assessCoverage(
      [
        { semanticScore: 0.458, keywordScore: 0, documentTitle: PLAN },
        { semanticScore: 0.372, keywordScore: 0, documentTitle: 'Guía de onboarding' },
      ],
      { query: '¿plan de arranque de cortex?' },
    );
    expect(v.coverage).toBe('answered');
    expect(v.kept[0]?.relevance).toBe('strong');
    expect(v.kept[1]?.relevance).toBe('weak');
  });
});

describe('assessCoverage', () => {
  it('says it found the answer when it did', () => {
    const v = assessCoverage([hit(0.62), hit(0.44)], { query: 'tarifa desarrollador senior' });
    expect(v.coverage).toBe('answered');
    expect(v.kept).toHaveLength(2);
    expect(v.kept[0]?.relevance).toBe('strong');
    expect(v.kept[1]?.relevance).toBe('weak');
  });

  it('says out loud that it only has something tangential', () => {
    const v = assessCoverage([hit(0.44), hit(0.4)], { query: 'plan de acciones' });
    expect(v.coverage).toBe('thin');
    // The model must be told to present it as tangential, not as the answer.
    expect(v.summary).toMatch(/tangencial|apenas relacionado/i);
    expect(v.kept).toHaveLength(2);
  });

  it('says "there is nothing" instead of handing over the nearest rows', () => {
    const v = assessCoverage([hit(0.25), hit(0.22), hit(0.16)], {
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

  it('reports which scale it judged on, so the bench can draw the real cuts', () => {
    const v = assessCoverage([hit(0.5)], { query: 'nómina' });
    expect(v.calibration.modelId).toBe(DEFAULT_CALIBRATION.modelId);
    expect(v.calibration.measured).toBe(true);
  });

  /**
   * The regression this whole change exists for. Before it, the BBIC start-up
   * plan came back top of the list and was discarded, and the screen said the
   * brain held nothing about it.
   */
  it('no longer discards the document that answers the question that started this', () => {
    const v = assessCoverage([hit(0.489), hit(0.41), hit(0.2)], {
      query: '¿plan de arranque de cortex?',
    });
    expect(v.coverage).toBe('answered');
    expect(v.kept[0]?.relevance).toBe('strong');
    expect(v.bestScore).toBe(0.489);
  });
});
