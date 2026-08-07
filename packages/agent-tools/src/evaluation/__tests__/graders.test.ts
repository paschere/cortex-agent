/**
 * The two objective graders and the comparison, on numbers made up here.
 *
 * `offline.test.ts` grades the real measurement and is the gate; this file
 * grades the grader. The distinction matters because the interesting cases —
 * the correct chunk that came back and was thrown away, the honest system that
 * gets accused of a regression by a suite somebody edited — are ones the real
 * measurement had better never produce, and a test that could only observe them
 * by breaking production is not a test.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_CALIBRATION, STRONG_MATCH, WEAK_FLOOR } from '../../kb/relevance';
import { compareRuns } from '../compare';
import { corpusChunks } from '../corpus';
import { gradeRetrievalCase, replayHits, scoreRetrieval } from '../retrieval';
import type { EvalCase, EvalRun } from '../types';

const chunks = corpusChunks();
const modelId = DEFAULT_CALIBRATION.modelId;

/** Cosines that give one named document the score asked for, and everything else noise. */
function cosinesFavouring(documentId: string, score: number, floor = 0.1): number[] {
  return chunks.map((c) => (c.documentId === documentId ? score : floor));
}

const answered: EvalCase = {
  id: 'x',
  group: 'answered',
  query: 'q',
  gold: ['plan-bbic'],
  why: 'fixture',
};

const absent: EvalCase = { id: 'y', group: 'absent', query: 'q', gold: [], why: 'fixture' };

describe('grading one retrieval', () => {
  it('passes when the right document comes back and clears the strong cut', () => {
    const hits = replayHits(chunks, cosinesFavouring('plan-bbic', STRONG_MATCH + 0.02), 8, modelId);
    const result = gradeRetrievalCase(answered, hits, modelId);
    expect(result.goldRank).toBe(1);
    expect(result.goldKept).toBe(true);
    expect(result.coverage).toBe('answered');
    expect(result.passed).toBe(true);
    expect(result.missedByFloor).toBe(false);
  });

  it('names the production failure when the right document is retrieved and then discarded', () => {
    // A whisker under the floor — the shape of the bug that shipped: the chunk
    // came back FIRST, scored 0.436, and was thrown away because the floor was
    // 0.45. "Retrieved and discarded" and "never retrieved" have different
    // causes and different fixes, so they are counted separately.
    const hits = replayHits(chunks, cosinesFavouring('plan-bbic', WEAK_FLOOR - 0.01, 0.05), 8, modelId);
    const result = gradeRetrievalCase(answered, hits, modelId);
    expect(result.goldRank).toBe(1);
    expect(result.goldKept).toBe(false);
    expect(result.missedByFloor).toBe(true);
    expect(result.passed).toBe(false);
  });

  it('fails an answerable question kept only as a weak lead', () => {
    // Above the floor, below the strong cut: the material survives, but the
    // model is told it does not answer the question, so it will hedge over the
    // document that does. Keeping it is not the same as answering with it.
    const between = (STRONG_MATCH + WEAK_FLOOR) / 2;
    const hits = replayHits(chunks, cosinesFavouring('plan-bbic', between, 0.05), 8, modelId);
    const result = gradeRetrievalCase(answered, hits, modelId);
    expect(result.goldKept).toBe(true);
    expect(result.coverage).toBe('thin');
    expect(result.passed).toBe(false);
  });

  it('accepts either thin or nothing for a plausible question the corpus does not answer', () => {
    // The neighbouring document IS the one to read; it just has no rule. See
    // the argument in kb/relevance.ts for why demanding `nothing` here would
    // push the floor up until real questions started failing.
    const thin = replayHits(chunks, cosinesFavouring('policy-vacaciones', WEAK_FLOOR + 0.01, 0.05), 8, modelId);
    expect(gradeRetrievalCase(absent, thin, modelId).coverage).toBe('thin');
    expect(gradeRetrievalCase(absent, thin, modelId).passed).toBe(true);

    const nothing = replayHits(chunks, chunks.map(() => 0.05), 8, modelId);
    expect(gradeRetrievalCase(absent, nothing, modelId).coverage).toBe('nothing');
    expect(gradeRetrievalCase(absent, nothing, modelId).passed).toBe(true);
  });

  it('counts an unanswerable question sold as answered', () => {
    const hits = replayHits(chunks, cosinesFavouring('policy-vacaciones', STRONG_MATCH + 0.05), 8, modelId);
    const result = gradeRetrievalCase(absent, hits, modelId);
    expect(result.overclaimed).toBe(true);
    expect(result.passed).toBe(false);
  });
});

describe('scoring a set of retrievals', () => {
  it('keeps grounding and restraint apart', () => {
    // The whole reason there are two numbers: a system that answers everything
    // confidently is perfect on one and hopeless on the other, and one figure
    // would put it level with an honest mediocre system.
    const yes = replayHits(chunks, cosinesFavouring('plan-bbic', STRONG_MATCH + 0.05), 8, modelId);
    const alsoYes = replayHits(chunks, cosinesFavouring('policy-vacaciones', STRONG_MATCH + 0.05), 8, modelId);
    const score = scoreRetrieval([
      gradeRetrievalCase(answered, yes, modelId),
      gradeRetrievalCase(absent, alsoYes, modelId),
    ]);
    expect(score.grounding).toBe(1);
    expect(score.restraint).toBe(0);
    expect(score.overclaimed).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */

function run(over: Partial<EvalRun> & { digest?: string } = {}): EvalRun {
  const { digest = 'aaaaaaaaaaaaaaaa', ...rest } = over;
  return {
    identity: {
      suiteId: 'cortex-brain-v1',
      suiteDigest: digest,
      embeddingModel: modelId,
      calibration: DEFAULT_CALIBRATION,
      chatModel: null,
      judgeModel: null,
      answerPromptDigest: null,
      judgePromptDigest: null,
    },
    tier: 'offline',
    startedAt: '2026-08-07T00:00:00.000Z',
    elapsedMs: 100,
    vectorSource: 'fixture',
    retrieval: {
      cases: 10,
      top1: 1,
      recall: 1,
      grounding: 1,
      restraint: 1,
      missedByFloor: 0,
      overclaimed: 0,
      results: [],
    },
    selection: { cases: 5, reach: 1, staleTools: 0, results: [] },
    answers: null,
    costUsd: 0,
    warnings: [],
    ...rest,
  };
}

describe('comparing two runs', () => {
  it('refuses when the two runs did not take the same test', () => {
    // Not a warning next to the deltas — a refusal. A warning beside two
    // numbers that both say 0,9 gets skipped every single time.
    const comparison = compareRuns(run(), run({ digest: 'bbbbbbbbbbbbbbbb' }));
    expect(comparison.comparable).toBe(false);
    expect(comparison.retrieval).toEqual([]);
    expect(comparison.reason).toContain('cuestionario');
  });

  it('calls a fall in grounding a regression', () => {
    const after = run();
    after.retrieval = { ...after.retrieval, grounding: 0.8 };
    const comparison = compareRuns(run(), after);
    expect(comparison.regression).toBe(true);
    expect(comparison.retrieval.find((d) => d.label === 'fundamento')?.worse).toBe(true);
  });

  it('calls a rise in discarded-correct-fragments a regression even when the ratios hold', () => {
    // The trade this is here to catch: a change that keeps every percentage
    // still while turning near-misses into thrown-away answers.
    const after = run();
    after.retrieval = { ...after.retrieval, missedByFloor: 2 };
    expect(compareRuns(run(), after).regression).toBe(true);
  });

  it('reports what changed in the configuration', () => {
    const after = run();
    after.identity = { ...after.identity, chatModel: 'claude-sonnet-5' };
    const comparison = compareRuns(run(), after);
    expect(comparison.changed.map((c) => c.field)).toContain('modelo de chat');
  });

  it('withholds the answer deltas when either judge failed its own calibration', () => {
    const judge = { probes: 9, leniency: 0, severity: 0, trusted: true, failures: [] };
    const before = run();
    before.answers = { cases: 5, grounding: 1, restraint: 1, judge, results: [] };
    const after = run();
    after.answers = {
      cases: 5,
      grounding: 0.2,
      restraint: 0.2,
      judge: { ...judge, leniency: 0.4, trusted: false },
      results: [],
    };
    const comparison = compareRuns(before, after);
    expect(comparison.answers).toEqual([]);
    expect(comparison.caveats.join(' ')).toContain('juez');
    // And the collapse in the answer scores does NOT count as a regression:
    // an untrusted judge produced them, so they are not evidence of anything.
    expect(comparison.regression).toBe(false);
  });
});
