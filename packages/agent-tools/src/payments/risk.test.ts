import { describe, expect, it } from 'vitest';
import { OVERDUE_STAGES, overdueStage } from './risk';

describe('los escalones de mora que merecen aviso', () => {
  it('avisa al cruzar cada escalón, no todos los días', () => {
    expect(overdueStage(0)).toBeNull();
    expect(overdueStage(1)).toBe(1);
    expect(overdueStage(29)).toBe(1);
    expect(overdueStage(30)).toBe(30);
    expect(overdueStage(59)).toBe(30);
    expect(overdueStage(60)).toBe(60);
    expect(overdueStage(400)).toBe(90);
  });

  it('los escalones coinciden con el CHECK de la 0159', () => {
    expect([...OVERDUE_STAGES]).toEqual([1, 30, 60, 90]);
  });
});
