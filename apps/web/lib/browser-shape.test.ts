import { STEP_ACTIONS as REAL_ACTIONS, TARGET_KINDS as REAL_KINDS } from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';
import {
  ACTION_LABEL,
  EFFECT_LABEL,
  FLOW_EFFECTS,
  FLOW_STATUSES,
  STATUS_LABEL,
  STATUS_TONE,
  STEP_ACTIONS,
  TARGET_KINDS,
  TARGET_LABEL,
  TARGET_WHY,
} from './browser-shape';

/**
 * `browser-shape.ts` is a hand-written copy of vocabulary that lives in
 * `@cortex/agent-tools`, because importing the barrel from a `'use client'`
 * component drags `node:dns` into the browser bundle and breaks the production
 * build without failing typecheck or tests.
 *
 * This test is the price of that copy: it runs in Node, imports the real
 * module, and fails the moment the two disagree.
 */

describe('the client-side copy of the trámites-web vocabulary', () => {
  it('lists exactly the step actions agent-tools does', () => {
    expect([...STEP_ACTIONS].sort()).toEqual([...REAL_ACTIONS].sort());
  });

  it('lists exactly the target kinds agent-tools does', () => {
    expect([...TARGET_KINDS].sort()).toEqual([...REAL_KINDS].sort());
  });

  it('has a Spanish label for every action, kind, effect and status', () => {
    for (const action of STEP_ACTIONS) expect(ACTION_LABEL[action]).toBeTruthy();
    for (const kind of TARGET_KINDS) {
      expect(TARGET_LABEL[kind]).toBeTruthy();
      // The ranking is the robustness story, so every rung explains itself on
      // the screen rather than only in a comment nobody using it will read.
      expect(TARGET_WHY[kind]).toBeTruthy();
    }
    for (const effect of FLOW_EFFECTS) expect(EFFECT_LABEL[effect]).toBeTruthy();
    for (const status of FLOW_STATUSES) {
      expect(STATUS_LABEL[status]).toBeTruthy();
      expect(STATUS_TONE[status]).toBeTruthy();
    }
  });

  it('keeps propuesto and probado as the words on screen', () => {
    // Renaming these is a product decision, not a refactor: the difference
    // between a hypothesis and a proven errand is the whole reason the states
    // exist.
    expect(STATUS_LABEL.draft).toBe('Propuesto');
    expect(STATUS_LABEL.ready).toBe('Probado');
    // Rose is for the irreversible. A proposal is not a failure.
    expect(STATUS_TONE.draft).not.toBe('rose');
    expect(STATUS_TONE.broken).toBe('rose');
  });
});
