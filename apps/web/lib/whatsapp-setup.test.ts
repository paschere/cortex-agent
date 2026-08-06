import { describe, expect, it } from 'vitest';
import { type SetupFacts, nextStep, setupSteps, wouldAnswerMe } from './whatsapp-setup';

const NOTHING: SetupFacts = { connected: false, myNumberLinked: false, groupsConfigured: 0 };

function states(facts: SetupFacts): Record<string, string> {
  return Object.fromEntries(setupSteps(facts).map((s) => [s.key, s.state]));
}

describe('setupSteps', () => {
  it('starts everybody at pairing and nothing else', () => {
    expect(states(NOTHING)).toEqual({ pair: 'now', link: 'later', groups: 'later' });
  });

  it('moves to linking your own number the moment the line is paired', () => {
    expect(states({ ...NOTHING, connected: true })).toEqual({
      pair: 'done',
      link: 'now',
      groups: 'later',
    });
  });

  it('only asks about groups once the reader can be answered', () => {
    expect(states({ connected: true, myNumberLinked: true, groupsConfigured: 0 })).toEqual({
      pair: 'done',
      link: 'done',
      groups: 'now',
    });
  });

  it('is finished when all three are true', () => {
    const facts = { connected: true, myNumberLinked: true, groupsConfigured: 2 };
    expect(states(facts)).toEqual({ pair: 'done', link: 'done', groups: 'done' });
    expect(nextStep(facts)).toBeNull();
  });

  // Groups can be configured by an admin who never linked their own number.
  // That is reported as it is, and the missing link is still the next thing.
  it('reports a step done out of order without hiding the gap', () => {
    expect(states({ connected: true, myNumberLinked: false, groupsConfigured: 3 })).toEqual({
      pair: 'done',
      link: 'now',
      groups: 'done',
    });
  });

  it('never highlights two steps at once', () => {
    for (const connected of [true, false]) {
      for (const myNumberLinked of [true, false]) {
        for (const groupsConfigured of [0, 4]) {
          const steps = setupSteps({ connected, myNumberLinked, groupsConfigured });
          expect(steps.filter((s) => s.state === 'now')).toHaveLength(
            connected && myNumberLinked && groupsConfigured > 0 ? 0 : 1,
          );
        }
      }
    }
  });
});

describe('wouldAnswerMe', () => {
  it('blames pairing before it blames the missing link', () => {
    expect(wouldAnswerMe({ ...NOTHING, myNumberLinked: true })).toEqual({
      yes: false,
      blockedBy: 'pair',
    });
  });

  it('names the missing link, which is the one people trip over', () => {
    expect(wouldAnswerMe({ ...NOTHING, connected: true })).toEqual({
      yes: false,
      blockedBy: 'link',
    });
  });

  it('says yes with no groups at all: a direct message needs no group', () => {
    expect(wouldAnswerMe({ connected: true, myNumberLinked: true, groupsConfigured: 0 })).toEqual({
      yes: true,
      blockedBy: null,
    });
  });
});
