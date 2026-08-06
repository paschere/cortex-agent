import { describe, expect, it } from 'vitest';
import { EMBEDDING_PROVIDERS, qualifyModel } from '../embedding-providers';
import {
  AWAITING_MEASUREMENT,
  CALIBRATIONS,
  DEFAULT_CALIBRATION,
  DEFAULT_MODEL_ID,
  assessCoverage,
  calibrationFor,
  rateHit,
  uncalibrated,
} from '../relevance';

/**
 * THRESHOLDS AND THE MODEL THEY WERE MEASURED ON MUST NOT SEPARATE. ASSERTED IN
 * CI, BECAUSE THEY DID.
 *
 * A PDF titled "Plan de arranque para BBIC" was uploaded and asked about with
 * the words its owner typed — "¿plan de arranque de cortex?". The right chunk
 * came back top, scored 0.436, and was thrown away because the floor was 0.45.
 * The screen said "No tiene nada de esto" over the only document that answered
 * the question. Nothing failed: no type was wrong, no test broke, no log line
 * said anything. A retrieval threshold that is too high produces SILENCE, and
 * silence over a full brain is indistinguishable from an empty one.
 *
 * The thresholds had been measured against `voyage-3-large` and the default had
 * since moved to `voyage-4-lite`, and nobody connected the two — because
 * nothing in the code said they were connected. Cosine similarity is on a scale
 * each model chooses for itself; the same perfect hit scores 0.530 under one
 * and 0.489 under the other, and an unrelated question scores 0.404 under one
 * and 0.216 under the other. A number carried across is not approximately
 * right, it is meaningless.
 *
 * So this is written as a check on the SHAPE of the arrangement rather than on
 * any one number: every model this deployment can be pointed at must have
 * thresholds somebody measured, and changing the default without measuring must
 * turn something red here — not go quiet in production.
 */

describe('retrieval thresholds are tied to the model they were measured on', () => {
  it('accounts for every provider default, as either measured or openly unmeasured', () => {
    const unaccounted: string[] = [];
    for (const provider of Object.values(EMBEDDING_PROVIDERS)) {
      const id = qualifyModel(provider.id, provider.defaultModel);
      if (!calibrationFor(id).measured && !(id in AWAITING_MEASUREMENT)) unaccounted.push(id);
    }
    expect(
      unaccounted,
      'These models can be selected with one environment variable, and relevance.ts neither measures them nor admits that it has not. ' +
        'Applying another model\'s thresholds is the bug that made Brain Knowledge answer "no hay nada" over the one document that answered the question. ' +
        'Run the corpus — the procedure and the three query groups are documented at the top of relevance.ts — and add the result to CALIBRATIONS, or say so in AWAITING_MEASUREMENT.',
    ).toEqual([]);
  });

  it('never lists a model as both measured and awaiting measurement', () => {
    const both = Object.keys(AWAITING_MEASUREMENT).filter((id) => id in CALIBRATIONS);
    expect(both, 'A model cannot be both measured and awaiting measurement.').toEqual([]);
  });

  it('has a measured calibration for the model this deployment actually uses', () => {
    expect(DEFAULT_CALIBRATION.measured).toBe(true);
    expect(DEFAULT_CALIBRATION.modelId).toBe(DEFAULT_MODEL_ID);
    expect(DEFAULT_CALIBRATION.measuredOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('states, for every calibration, a floor below a strong cut below the rail top', () => {
    for (const [key, c] of Object.entries(CALIBRATIONS)) {
      expect(c.modelId, `${key} disagrees with its own key`).toBe(key);
      expect(c.weakFloor, `${key}: the floor must sit below the strong cut`).toBeLessThan(
        c.strongMatch,
      );
      expect(c.strongMatch, `${key}: the rail must reach above the strong cut`).toBeLessThan(
        c.railCeiling,
      );
      expect(c.measured, `${key} is in CALIBRATIONS but claims not to be measured`).toBe(true);
      expect(c.measuredOn).toBeTruthy();
    }
  });

  /**
   * The failure itself, pinned. 0.489 is what the passage carrying "CÓRTEX ·
   * Plan de arranque para BBIC S.A.S." scores against the question as typed,
   * measured against the live API on 2026-08-05 with voyage-4-lite. It must be
   * a strong match, not a weak one and certainly not a discard.
   */
  it('rates the document that started this as an answer, not as nothing', () => {
    const hit = { semanticScore: 0.489, keywordScore: 0, embeddingModel: 'voyage:voyage-4-lite' };
    expect(rateHit(hit, calibrationFor(hit.embeddingModel))).toBe('strong');

    const verdict = assessCoverage([hit], { query: '¿plan de arranque de cortex?' });
    expect(verdict.coverage).toBe('answered');
    expect(verdict.discarded).toBe(0);
  });

  /**
   * The same cosines under both models, to show the numbers are not
   * interchangeable. This is the whole argument for keying them by model: one
   * score is an answer on one scale and a passing mention on the other, and a
   * second score is worth offering on one scale and worth nothing on the other.
   */
  it('judges the same cosine differently under a different model, which is the point', () => {
    const rate = (score: number, model: string) =>
      rateHit({ semanticScore: score, keywordScore: 0 }, calibrationFor(model));

    // The production hit: an answer on the model that is running, a mere lead
    // on the model the old thresholds were measured against.
    expect(rate(0.489, 'voyage:voyage-4-lite')).toBe('strong');
    expect(rate(0.489, 'voyage:voyage-3-large')).toBe('weak');

    // And lower down, the difference between being offered and being discarded.
    expect(rate(0.4, 'voyage:voyage-4-lite')).toBe('weak');
    expect(rate(0.4, 'voyage:voyage-3-large')).toBeNull();
  });

  it('picks the scale from the hits when the caller does not name one', () => {
    const hits = [{ semanticScore: 0.5, keywordScore: 0, embeddingModel: 'voyage:voyage-3-large' }];
    const verdict = assessCoverage(hits, { query: 'tarifas' });
    expect(verdict.calibration.modelId).toBe('voyage:voyage-3-large');
    // 0.5 is above voyage-3-large's floor of 0.48 but below its strong cut.
    expect(verdict.coverage).toBe('thin');
  });
});

describe('a model nobody measured is loud, never silent', () => {
  it('falls back to a wide margin rather than to the last model that was measured', () => {
    const c = calibrationFor('openai:some-model-nobody-measured');
    expect(c.measured).toBe(false);
    expect(c.measuredOn).toBeNull();
    // Deliberately below every measured floor: the failure being prevented is
    // swallowing real answers, and a reader can dismiss a weak-looking hit far
    // more easily than they can notice one that never arrived.
    for (const known of Object.values(CALIBRATIONS)) {
      expect(c.weakFloor).toBeLessThan(known.weakFloor);
    }
  });

  it('says so in the sentence handed to the model, not only in a log', () => {
    const verdict = assessCoverage(
      [{ semanticScore: 0.2, keywordScore: 0, embeddingModel: 'cohere:embed-v4.0' }],
      { query: 'plan de arranque' },
    );
    expect(verdict.calibration.measured).toBe(false);
    expect(verdict.summary).toMatch(/no están medidos/i);
    expect(verdict.summary).toContain('cohere:embed-v4.0');
  });

  it('names the model in its own note, so the bench can print something actionable', () => {
    expect(uncalibrated('google:gemini-embedding-001').note).toContain(
      'google:gemini-embedding-001',
    );
  });

  it('does not caveat a keyword-only verdict, where no cosine was judged at all', () => {
    const verdict = assessCoverage([], {
      query: 'tarifas',
      degraded: true,
      embeddingModel: 'cohere:embed-v4.0',
    });
    expect(verdict.summary).not.toMatch(/no están medidos/i);
  });
});
