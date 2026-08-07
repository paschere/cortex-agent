import { describe, expect, it } from 'vitest';
import { EMBEDDING_PROVIDERS, qualifyModel } from '../../kb/embedding-providers';
import {
  AWAITING_SELECTION_MEASUREMENT,
  DEFAULT_SELECTION_CALIBRATION,
  DEFAULT_SELECTION_MODEL_ID,
  SELECTION_CALIBRATIONS,
  type SelectableTool,
  rankTools,
  selectionCalibrationFor,
  uncalibratedSelection,
} from '../rank';

/**
 * THE SELECTION FLOOR AND THE MODEL IT WAS MEASURED ON MUST NOT SEPARATE.
 * ASSERTED IN CI, BECAUSE THEY DID.
 *
 * `MIN_FAMILY_SCORE = 0.3` was justified with "0.45+ for a real match" — a range
 * measured against `voyage-3-large`. Migration 0074 moved the default embedding
 * model to `voyage-4-lite`, where the highest tool/query cosine anywhere in the
 * evaluation suite is 0.416 and nothing reaches 0.45. The floor, written to sit
 * above the noise, ended up inside the signal: "mandale un correo a daniela"
 * scored `gmail` at 0.291 and `outlook` at 0.292, so no mail family reached the
 * model on a request that says "send an email". Nothing threw, no test broke,
 * and the only symptom was the agent saying it could not help.
 *
 * It is the same failure `kb/relevance.ts` was recalibrated for, in the other
 * module of this system that thresholds a cosine, and it went unnoticed for the
 * same reason: the number did not name a model. So this file checks the SHAPE of
 * the arrangement rather than any one figure — every model this deployment can
 * be pointed at must have cuts somebody measured, and changing the default
 * without measuring must turn something red here instead of going quiet in
 * production.
 */

describe('selection cuts are tied to the model they were measured on', () => {
  it('accounts for every provider default, as either measured or openly unmeasured', () => {
    const unaccounted: string[] = [];
    for (const provider of Object.values(EMBEDDING_PROVIDERS)) {
      const id = qualifyModel(provider.id, provider.defaultModel);
      if (!selectionCalibrationFor(id).measured && !(id in AWAITING_SELECTION_MEASUREMENT)) {
        unaccounted.push(id);
      }
    }
    expect(
      unaccounted,
      'These models can be selected with one environment variable, and rank.ts neither measures them nor admits that it has not. ' +
        "Applying another model's floor is what left `gmail` below the cut on a request that said «mandale un correo». " +
        'Run the continuous evaluation (EVAL_MEASURE=1) and add the result to SELECTION_CALIBRATIONS, or say so in AWAITING_SELECTION_MEASUREMENT.',
    ).toEqual([]);
  });

  it('never lists a model as both measured and awaiting measurement', () => {
    const both = Object.keys(AWAITING_SELECTION_MEASUREMENT).filter(
      (id) => id in SELECTION_CALIBRATIONS,
    );
    expect(both, 'A model cannot be both measured and awaiting measurement.').toEqual([]);
  });

  it('has a measured calibration for the model this deployment actually uses', () => {
    expect(DEFAULT_SELECTION_CALIBRATION.measured).toBe(true);
    expect(DEFAULT_SELECTION_CALIBRATION.modelId).toBe(DEFAULT_SELECTION_MODEL_ID);
    expect(DEFAULT_SELECTION_CALIBRATION.measuredOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('states, for every calibration, a floor and a band that are actually usable', () => {
    for (const [key, c] of Object.entries(SELECTION_CALIBRATIONS)) {
      expect(c.modelId, `${key} disagrees with its own key`).toBe(key);
      expect(c.minFamilyScore, `${key}: a floor at or below zero filters nothing`).toBeGreaterThan(
        0,
      );
      expect(c.familyBand, `${key}: a band of zero admits only exact ties`).toBeGreaterThan(0);
      expect(c.measured, `${key} is in SELECTION_CALIBRATIONS but claims not to be measured`).toBe(
        true,
      );
      expect(c.measuredOn).toBeTruthy();
    }
  });

  /**
   * The failure itself, pinned. 0.291 is what `gmail.send_draft` scores against
   * "mandale un correo a daniela con el resumen de la reunion", measured against
   * the live API on 2026-08-07 with voyage-4-lite, with `meetings` winning the
   * turn at 0.334. Mail has to travel; it did not.
   */
  it('sends the mail family on a request that says «mandale un correo»', () => {
    const tools: SelectableTool[] = [
      { id: 'meetings.prepare_briefing', description: 'Prepara un resumen de la reunión.' },
      { id: 'gmail.send_draft', description: 'Envía un correo.' },
      { id: 'outlook.send_draft', description: 'Envía un correo por Outlook.' },
      { id: 'chat.send_dm', description: 'Manda un mensaje directo.' },
    ];
    const measured = new Map<string, readonly number[]>([
      ['meetings.prepare_briefing', [0.334]],
      ['gmail.send_draft', [0.291]],
      ['outlook.send_draft', [0.292]],
      ['chat.send_dm', [0.269]],
    ]);

    const ranked = rankTools({
      tools,
      queryVector: [1],
      vectors: measured,
      alwaysFamilies: new Set<string>(),
    });

    expect(ranked.selectedFamilies).toContain('gmail');
    // And the family below the band still does not come along for the ride: this
    // is a floor that was lowered onto measured evidence, not removed.
    expect(ranked.selectedFamilies).not.toContain('chat');
  });

  it('judges the same cosine differently under a different model, which is the point', () => {
    // 0.291 clears the measured floor of the model that is running and falls
    // under the retired 0.30 the file used to hard-code for every model.
    expect(selectionCalibrationFor('voyage:voyage-4-lite').minFamilyScore).toBeLessThan(0.291);
    expect(selectionCalibrationFor('voyage:voyage-3-large').measured).toBe(false);
  });
});

describe('a model nobody measured is permissive, never silent', () => {
  it('falls back to a floor below every measured one, rather than to another model’s', () => {
    const c = uncalibratedSelection('openai:some-model-nobody-measured');
    expect(c.measured).toBe(false);
    expect(c.measuredOn).toBeNull();
    // The asymmetry, asserted: too high makes a granted capability disappear,
    // too low costs a few extra declarations. Only one of those is invisible.
    for (const known of Object.values(SELECTION_CALIBRATIONS)) {
      expect(c.minFamilyScore).toBeLessThan(known.minFamilyScore);
    }
  });

  it('names the model in its own note, so a selection log can print something actionable', () => {
    expect(uncalibratedSelection('google:gemini-embedding-001').note).toContain(
      'google:gemini-embedding-001',
    );
  });

  it('still takes the best family when everything is under the floor', () => {
    // The lesson of the vehicles incident: a cut that is slightly too high must
    // not make a capability vanish. The top family travels unconditionally.
    const tools: SelectableTool[] = [
      { id: 'vehicles.get', description: 'Consulta una placa en el RUNT.' },
      { id: 'payroll.run', description: 'Corre la nómina.' },
    ];
    const ranked = rankTools({
      tools,
      queryVector: [1],
      vectors: new Map([
        ['vehicles.get', [0.09]],
        ['payroll.run', [0.02]],
      ]),
      alwaysFamilies: new Set<string>(),
    });
    expect(ranked.selectedFamilies).toEqual(['vehicles']);
  });
});
