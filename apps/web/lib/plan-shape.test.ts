import { LIMIT_POLICY, METERS, ONBOARDING_GOALS, ONBOARDING_STEPS } from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';
import {
  GOAL_FIRST_QUESTION,
  GOAL_LABEL,
  METER_LABEL,
  METERS as SHAPE_METERS,
  METER_STATE_LABEL,
  METER_STATE_TONE,
  METER_STATES,
  ONBOARDING_GOALS as SHAPE_GOALS,
  ONBOARDING_STEPS as SHAPE_STEPS,
  barFill,
  cop,
  count,
  meterAmount,
  percent,
  periodLabel,
  stamp,
} from './plan-shape';

/**
 * `plan-shape.ts` restates the billing vocabulary for the browser, because
 * importing `@cortex/agent-tools` from a `'use client'` module drags `node:dns`
 * into the bundle and breaks the production build while typecheck and tests stay
 * green. That is a real trap this repo has already fallen into twice.
 *
 * The copy is only safe if something notices when it drifts. This runs in Node,
 * imports the real modules, and fails the moment the two disagree — which is the
 * whole reason the duplication is allowed.
 */

describe('the browser copy matches the source of truth', () => {
  it('has the same meters', () => {
    expect([...SHAPE_METERS]).toEqual([...METERS]);
  });

  it('has the same onboarding goals and steps', () => {
    expect([...SHAPE_GOALS]).toEqual([...ONBOARDING_GOALS]);
    expect([...SHAPE_STEPS]).toEqual([...ONBOARDING_STEPS]);
  });

  it('labels every meter, in both numbers', () => {
    for (const meter of METERS) {
      expect(METER_LABEL[meter].one.length).toBeGreaterThan(0);
      expect(METER_LABEL[meter].many.length).toBeGreaterThan(0);
      expect(METER_LABEL[meter].help.length).toBeGreaterThan(0);
    }
  });

  it('labels and tones every state', () => {
    for (const state of METER_STATES) {
      expect(METER_STATE_LABEL[state]).toBeTruthy();
      expect(METER_STATE_TONE[state]).toBeTruthy();
    }
    // rose is reserved for something that has actually stopped. `grace` is a
    // courtesy, not a failure, and drawing it in the alarm colour would teach
    // people to ignore the colour that matters.
    expect(METER_STATE_TONE.grace).toBe('amber');
    expect(METER_STATE_TONE.blocked).toBe('rose');
  });

  it('gives every goal a label and a first question that is really a question', () => {
    for (const goal of ONBOARDING_GOALS) {
      expect(GOAL_LABEL[goal].title.length).toBeGreaterThan(0);
      expect(GOAL_LABEL[goal].detail.length).toBeGreaterThan(0);
      expect(GOAL_FIRST_QUESTION[goal]).toMatch(/\?$/);
    }
  });

  it('still only blocks the meter the policy says it blocks', () => {
    // If somebody flips this, the copy above ("los documentos se siguen
    // guardando") becomes a lie, and this is where they find out.
    expect(LIMIT_POLICY.answers).toBe('block');
    expect(LIMIT_POLICY.documents).toBe('degrade');
  });
});

describe('formatting', () => {
  it('writes pesos in the local format, without cents', () => {
    expect(cop(290_000)).toBe('$290.000');
    expect(cop(0)).toBe('$0');
    expect(cop(1_250_499)).toBe('$1.250.499');
  });

  it('writes counts in the local format', () => {
    expect(count(1240)).toBe('1.240');
  });

  it('agrees with itself about singular and plural', () => {
    expect(meterAmount('answers', 1)).toBe('1 respuesta');
    expect(meterAmount('answers', 2)).toBe('2 respuestas');
    expect(meterAmount('documents', 1)).toBe('1 documento');
  });

  it('caps the bar but never the percentage', () => {
    expect(barFill(180, 150)).toBe(1);
    expect(barFill(75, 150)).toBe(0.5);
    expect(barFill(10, null)).toBe(0);
    // A workspace at 120% has a right to read 120%.
    expect(percent(180, 150)).toBe('120%');
    expect(percent(10, null)).toBeNull();
  });

  it('names the period in Spanish without slipping a month', () => {
    expect(periodLabel('2026-08')).toBe('agosto de 2026');
    expect(periodLabel('2026-01')).toBe('enero de 2026');
    expect(periodLabel('2026-12')).toBe('diciembre de 2026');
  });

  it('stamps a moment in Bogotá, not in UTC', () => {
    // 15:04Z is 10:04 in Bogotá, on the same day.
    expect(stamp('2026-08-07T15:04:00Z')).toBe('07 ago 10:04');
    // 02:00Z on the 1st is still the previous evening locally.
    expect(stamp('2026-09-01T02:00:00Z')).toBe('31 ago 21:00');
  });
});
