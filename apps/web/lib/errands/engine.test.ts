import { LEG_RESERVE_TOKENS, type Spend, canStartLeg, exhaustedNote } from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';
import {
  type Assessment,
  type ErrandSnapshot,
  type LegSnapshot,
  ORPHAN_LEG_MS,
  STUCK_QUESTION,
  decideNext,
  describeState,
  foldAssessment,
} from './engine';

/**
 * The errand machine, exercised without a database, a model or Inngest.
 *
 * Everything interesting about an errand is a decision about rows, so every
 * decision is a pure function over rows and every one of them is tested here.
 * The four things that must hold, and which this file exists to keep holding:
 *
 *   1. a restart changes nothing — the same rows produce the same decision;
 *   2. getting stuck produces a QUESTION, never silence;
 *   3. the ceiling is respected at the only boundary where stopping is free;
 *   4. answering resumes rather than restarts.
 */

const NOW = Date.parse('2026-08-12T10:00:00.000Z');

function spend(over: Partial<Spend> = {}): Spend {
  return { tokensSpent: 0, tokenCeiling: 400_000, legsUsed: 0, legCeiling: 3, ...over };
}

function leg(over: Partial<LegSnapshot> = {}): LegSnapshot {
  return {
    seq: 1,
    status: 'completed',
    runId: 'run-1',
    startedAt: new Date(NOW - 60_000).toISOString(),
    assessed: false,
    ...over,
  };
}

function snapshot(over: Partial<ErrandSnapshot> = {}): ErrandSnapshot {
  return {
    state: 'working',
    kind: 'research_compare',
    brief: 'Compare refrigerated logistics operators in Buenaventura.',
    spend: spend(),
    legs: [],
    openQuestion: false,
    checksDone: 0,
    nextCheckAt: null,
    ...over,
  };
}

describe('decideNext', () => {
  it('reads the request before spending anything', () => {
    expect(decideNext(snapshot({ state: 'queued', brief: null }), NOW)).toEqual({ do: 'triage' });
  });

  it('commissions the first leg once there is a brief', () => {
    expect(decideNext(snapshot(), NOW)).toEqual({ do: 'launch_leg', seq: 1 });
  });

  it('waits while a leg is in flight, and does not commission a second one', () => {
    const s = snapshot({ legs: [leg({ status: 'running' })], spend: spend({ legsUsed: 1 }) });
    expect(decideNext(s, NOW)).toEqual({ do: 'wait', runId: 'run-1' });
  });

  it('reads a finished leg before doing anything else with it', () => {
    const s = snapshot({ legs: [leg()], spend: spend({ legsUsed: 1 }) });
    expect(decideNext(s, NOW)).toEqual({ do: 'assess_leg', seq: 1 });
  });

  it('commissions the next leg once the last one has been read', () => {
    const s = snapshot({ legs: [leg({ assessed: true })], spend: spend({ legsUsed: 1 }) });
    expect(decideNext(s, NOW)).toEqual({ do: 'launch_leg', seq: 2 });
  });

  // ── 1. Survives a restart ───────────────────────────────────────────────
  it('is a pure function of the rows, so a restart changes nothing', () => {
    // The same snapshot decided twice, by "two different workers", in either
    // order, at different moments: identical. This is the whole durability
    // claim — no worker holds anything a successor would need.
    const mid = snapshot({
      legs: [leg({ seq: 1, assessed: true }), leg({ seq: 2, status: 'running', runId: 'run-2' })],
      spend: spend({ legsUsed: 2, tokensSpent: 120_000 }),
    });
    const first = decideNext(mid, NOW);
    const second = decideNext(structuredClone(mid), NOW + 45_000);
    expect(second).toEqual(first);
    expect(first).toEqual({ do: 'wait', runId: 'run-2' });
  });

  it('writes off a leg whose run was never created, instead of waiting for ever', () => {
    // The one shape that could hang an errand permanently: a leg row written,
    // the worker killed, and no run behind it. Nothing is ever coming.
    const orphan = snapshot({
      legs: [
        leg({ status: 'running', runId: null, startedAt: new Date(NOW - 10_000).toISOString() }),
      ],
      spend: spend({ legsUsed: 1 }),
    });
    // Inside the grace window the two writes may still be catching up.
    expect(decideNext(orphan, NOW)).toEqual({ do: 'wait', runId: null });
    // Past it, it is read as a leg that produced nothing — which becomes a
    // question, not silence. See the fold tests below.
    expect(decideNext(orphan, NOW + ORPHAN_LEG_MS + 1_000)).toEqual({ do: 'assess_leg', seq: 1 });
  });

  // ── 4. A question pauses; it does not stop ──────────────────────────────
  it('does nothing at all while a person owes it an answer', () => {
    const blocked = snapshot({
      state: 'blocked',
      openQuestion: true,
      legs: [leg({ assessed: true })],
      spend: spend({ legsUsed: 1 }),
    });
    expect(decideNext(blocked, NOW)).toEqual({ do: 'nothing', why: 'blocked' });
  });

  it('resumes into the next leg the moment the question is gone', () => {
    // What the answer endpoint produces: state back to `working`, no open
    // question, every finished leg still on the table. The errand picks up
    // where it was rather than starting over — leg 2, not leg 1.
    const resumed = snapshot({
      state: 'working',
      openQuestion: false,
      legs: [leg({ assessed: true })],
      spend: spend({ legsUsed: 1, tokensSpent: 95_000 }),
    });
    expect(decideNext(resumed, NOW)).toEqual({ do: 'launch_leg', seq: 2 });
  });

  it('recovers a blocked errand whose question disappeared, rather than wedging', () => {
    const orphanedBlock = snapshot({ state: 'blocked', openQuestion: false });
    expect(decideNext(orphanedBlock, NOW)).toEqual({ do: 'launch_leg', seq: 1 });
  });

  // ── 3. The ceiling ──────────────────────────────────────────────────────
  it('stops rather than commission a leg it cannot pay for', () => {
    const broke = snapshot({
      legs: [leg({ assessed: true })],
      spend: spend({ legsUsed: 1, tokensSpent: 400_000 - LEG_RESERVE_TOKENS + 1 }),
    });
    expect(decideNext(broke, NOW)).toEqual({ do: 'stop', reason: 'tokens' });
  });

  it('stops on the leg ceiling even with tokens to spare', () => {
    const wandering = snapshot({
      legs: [leg({ seq: 1, assessed: true })],
      spend: spend({ legsUsed: 3, legCeiling: 3, tokensSpent: 1_000 }),
    });
    expect(decideNext(wandering, NOW)).toEqual({ do: 'stop', reason: 'legs' });
  });

  it('reserves a whole leg of headroom, so the ceiling is a ceiling', () => {
    // Without the reserve the last leg would be allowed to start on fumes and
    // sail past the number a person set.
    expect(canStartLeg(spend({ tokensSpent: 400_000 - LEG_RESERVE_TOKENS }))).toEqual({
      ok: true,
      headroom: LEG_RESERVE_TOKENS,
    });
    expect(canStartLeg(spend({ tokensSpent: 400_000 - LEG_RESERVE_TOKENS + 1 }))).toEqual({
      ok: false,
      reason: 'tokens',
    });
  });

  it('says nothing is due for a monitor between looks, and wakes it when it is', () => {
    const watching = snapshot({
      state: 'watching',
      kind: 'monitor_change',
      legs: [leg({ assessed: true })],
      spend: spend({ legsUsed: 1 }),
      nextCheckAt: new Date(NOW + 60 * 60_000).toISOString(),
      checksDone: 1,
    });
    expect(decideNext(watching, NOW)).toEqual({ do: 'nothing', why: 'waiting_for_check' });
    expect(decideNext(watching, NOW + 61 * 60_000)).toEqual({ do: 'launch_leg', seq: 2 });
  });

  it('never moves a terminal errand', () => {
    for (const state of ['delivered', 'failed', 'cancelled', 'exhausted'] as const) {
      expect(decideNext(snapshot({ state }), NOW)).toEqual({ do: 'nothing', why: 'terminal' });
    }
  });
});

// ---------------------------------------------------------------------------

describe('foldAssessment', () => {
  const deliver: Assessment = {
    verdict: 'deliver',
    deliverable: '| Operador | Capacidad |\n|---|---|\n| A | 40 ft [1] |',
    note: 'Listo.',
    sources: [{ title: 'A', url: 'https://a.example', readAt: '2026-08-12T09:00:00.000Z' }],
  };

  function fold(over: Partial<Parameters<typeof foldAssessment>[0]> = {}) {
    return foldAssessment({
      kind: 'research_compare',
      spend: spend({ legsUsed: 1, tokensSpent: 80_000 }),
      legStatus: 'completed',
      usableOutput: true,
      checksLeft: 0,
      assessment: deliver,
      ...over,
    });
  }

  // ── 2. Stuck produces a question, never silence ─────────────────────────
  it('turns a leg that produced nothing into a question, whatever the model concluded', () => {
    // The single most important behaviour in the feature. A confident model
    // saying "deliver" over an empty run is exactly the silent failure — a
    // document that looks finished and rests on nothing.
    const stuck = fold({ usableOutput: false, assessment: deliver });
    expect(stuck.outcome).toBe('ask');
    if (stuck.outcome !== 'ask') return;
    expect(stuck.question).toBe(STUCK_QUESTION);
    expect(stuck.why).toContain('inventarme');
  });

  it('never turns a stuck leg into a quiet failure or a partial delivery', () => {
    for (const assessment of [
      deliver,
      { verdict: 'continue', nextObjective: 'try again', findings: '' } as Assessment,
      { verdict: 'unchanged', reading: 'nothing' } as Assessment,
    ]) {
      for (const legStatus of ['failed', 'interrupted', 'cancelled', 'completed'] as const) {
        const resolution = fold({ usableOutput: false, assessment, legStatus });
        expect(resolution.outcome).toBe('ask');
      }
    }
  });

  it('explains how the leg ended inside the question it asks', () => {
    const crashed = fold({ usableOutput: false, legStatus: 'interrupted' });
    expect(crashed.outcome).toBe('ask');
    if (crashed.outcome !== 'ask') return;
    expect(crashed.why).toContain('se cayó a mitad de camino');
  });

  it('keeps the model’s own question when it has a better one', () => {
    const asked = fold({
      usableOutput: false,
      assessment: {
        verdict: 'ask',
        question: '¿Marítima o terrestre?',
        why: 'Son dos mercados distintos.',
        options: ['Marítima', 'Terrestre'],
      },
    });
    expect(asked).toEqual({
      outcome: 'ask',
      question: '¿Marítima o terrestre?',
      why: 'Son dos mercados distintos.',
      options: ['Marítima', 'Terrestre'],
    });
  });

  // ── 3. The ceiling again, at the fold ───────────────────────────────────
  it('refuses another leg it cannot pay for and delivers what exists instead', () => {
    const broke = fold({
      spend: spend({ legsUsed: 3, legCeiling: 3, tokensSpent: 200_000 }),
      assessment: {
        verdict: 'continue',
        nextObjective: 'one more pass over the port authority registry',
        findings: 'Four operators found; two confirmed refrigerated.',
      },
    });
    expect(broke.outcome).toBe('exhausted');
    if (broke.outcome !== 'exhausted') return;
    expect(broke.reason).toBe('legs');
    // Not nothing: what was paid for is still handed over.
    expect(broke.deliverable).toContain('Four operators');
    expect(broke.closingNote).toContain('tope');
  });

  it('allows another leg when there is budget for one', () => {
    const more = fold({
      spend: spend({ legsUsed: 1, legCeiling: 3, tokensSpent: 80_000 }),
      assessment: {
        verdict: 'continue',
        nextObjective: 'confirm the two remaining operators',
        findings: 'so far…',
      },
    });
    expect(more).toEqual({
      outcome: 'continue',
      nextObjective: 'confirm the two remaining operators',
      findings: 'so far…',
    });
  });

  it('closes an exhausted errand with a sentence, never in silence', () => {
    // The storage layer enforces this too (errands_terminal_is_closed in 0089),
    // but a note that only satisfies a CHECK is not a note anybody can read.
    for (const reason of ['tokens', 'legs'] as const) {
      const note = exhaustedNote(spend({ tokensSpent: 390_000, legsUsed: 3 }), reason);
      expect(note.length).toBeGreaterThan(80);
      // Not framed as a fault, and it tells the person what to do next. The
      // ceiling working as designed must not read like a bug report, or people
      // learn to raise ceilings they should be lowering.
      expect(note).not.toMatch(/\berror\b/i);
      expect(note).toContain('tope');
      expect(note).toMatch(/vuelve a encargarlo|súbele el tope/i);
    }
  });

  // ── Monitors ────────────────────────────────────────────────────────────
  it('sends a monitor back to sleep when nothing moved', () => {
    const quiet = fold({
      kind: 'monitor_change',
      checksLeft: 5,
      assessment: { verdict: 'unchanged', reading: 'Tarifa: USD 3.400 [1]' },
    });
    expect(quiet).toEqual({ outcome: 'watch', reading: 'Tarifa: USD 3.400 [1]' });
  });

  it('closes a monitor that ran out of looks, saying it never saw a change', () => {
    const done = fold({
      kind: 'monitor_change',
      checksLeft: 0,
      assessment: { verdict: 'unchanged', reading: 'Tarifa: USD 3.400 [1]' },
    });
    expect(done.outcome).toBe('deliver');
    if (done.outcome !== 'deliver') return;
    expect(done.closingNote).toContain('nunca vi un cambio');
  });

  it('delivers with its sources when the work is done', () => {
    const delivered = fold();
    expect(delivered.outcome).toBe('deliver');
    if (delivered.outcome !== 'deliver') return;
    expect(delivered.sources).toHaveLength(1);
    expect(delivered.sources[0]?.url).toBe('https://a.example');
  });
});

// ---------------------------------------------------------------------------

describe('describeState', () => {
  it('says something concrete in every state, so nothing ever just spins', () => {
    // A forty-minute job that says nothing feels hung. Every state owes the
    // person a sentence, including the boring ones.
    for (const state of [
      'queued',
      'working',
      'blocked',
      'watching',
      'delivered',
      'failed',
      'cancelled',
      'exhausted',
    ] as const) {
      const line = describeState({
        state,
        kind: state === 'watching' ? 'monitor_change' : 'research_compare',
        legsUsed: 1,
        legCeiling: 3,
        checksDone: 2,
        nextCheckAt: new Date(NOW + 3_600_000).toISOString(),
        openQuestion: state === 'blocked',
        spend: spend({ tokensSpent: 100_000 }),
      });
      expect(line.length, `${state} needs a sentence`).toBeGreaterThan(30);
    }
  });

  it('tells somebody watching a working errand that they may leave', () => {
    const line = describeState({
      state: 'working',
      kind: 'research_compare',
      legsUsed: 2,
      legCeiling: 3,
      checksDone: 0,
      nextCheckAt: null,
      openQuestion: false,
      spend: spend({ tokensSpent: 200_000 }),
    });
    expect(line).toContain('vuelta 2 de 3');
    expect(line).toContain('50%');
    expect(line).toContain('cerrar esta pestaña');
  });
});
