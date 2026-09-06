import { describe, expect, it } from 'vitest';
import { type LaunchEvidence, buildLaunchPlan, launchProgress } from './launch-plan';
const empty: LaunchEvidence = {
  facts: 0,
  configured: false,
  owner: false,
  sources: 0,
  knowledge: 0,
  people: 1,
  goals: 0,
  manuals: 0,
  browserProfiles: 0,
  browserConfigured: false,
  mandates: 0,
  routines: 0,
  verified: 0,
};
describe('permanent setup journey', () => {
  it('covers all ten stages including browser, mandates, routines and a verified mission', () => {
    const plan = buildLaunchPlan(empty);
    expect(plan.map((s) => s.id)).toEqual([
      'company',
      'scope',
      'context',
      'owner',
      'goals',
      'manual',
      'browser',
      'authority',
      'routine',
      'mission',
    ]);
    expect(launchProgress(plan)).toMatchObject({
      complete: false,
      total: 7,
      ready: 0,
      next: 'company',
    });
  });
  it('does not force integrations, a second employee or autonomous permissions', () => {
    const plan = buildLaunchPlan({
      ...empty,
      facts: 1,
      configured: true,
      owner: true,
      knowledge: 1,
      goals: 1,
      manuals: 1,
      verified: 1,
    });
    expect(launchProgress(plan)).toMatchObject({ complete: true, ready: 7 });
    expect(plan.find((s) => s.id === 'authority')?.evidence).toContain('No hay mandatos');
    expect(plan.find((s) => s.id === 'browser')?.state).toBe('pending');
  });
  it('unknown required reads cannot complete the journey', () => {
    const plan = buildLaunchPlan({ ...empty, facts: null, sources: null, verified: null });
    expect(plan.find((s) => s.id === 'context')?.state).toBe('unknown');
    expect(launchProgress(plan).complete).toBe(false);
  });
  it('a healthy knowledge source is usable even if the other source cannot be read', () => {
    expect(
      buildLaunchPlan({ ...empty, sources: null, knowledge: 1 }).find((s) => s.id === 'context')
        ?.state,
    ).toBe('ready');
  });
  it('a profile does not claim that the remote browser is configured', () => {
    expect(
      buildLaunchPlan({ ...empty, browserProfiles: 1 }).find((s) => s.id === 'browser')?.state,
    ).toBe('pending');
  });
});
