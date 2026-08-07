import { describe, expect, it } from 'vitest';
import { indexAdjustments, rerankByLearning, tierFor } from '../apply';
import type { ActiveAdjustment } from '../types';

/**
 * ONE CLAIM: learning can reorder inside a relevance band and can do nothing
 * else.
 *
 * This is the property the whole feature is allowed to run unattended on. If it
 * ever stops holding, an adjustment stops being "which of these equally good
 * passages goes first" and becomes "what counts as a good passage" — at which
 * point a loop that learns from usage can be steered, by anybody who can
 * produce usage, into putting material in front of the model that the measured
 * relevance thresholds rejected.
 *
 * So the tests below are deliberately adversarial about the ONE thing that
 * would let that happen: they try to promote something below the floor and to
 * bury the only thing above it.
 */

interface Hit {
  documentId: string;
  chunkIndex: number;
  band: 'strong' | 'weak' | 'dropped';
  name: string;
}

const hit = (name: string, documentId: string, chunkIndex: number, band: Hit['band']): Hit => ({
  name,
  documentId,
  chunkIndex,
  band,
});

const options = {
  key: (h: Hit) => ({ documentId: h.documentId, chunkIndex: h.chunkIndex }),
  band: (h: Hit) => h.band,
};

const rank = (hits: Hit[], adjustments: ActiveAdjustment[]) =>
  rerankByLearning(hits, indexAdjustments(adjustments), options).map((h) => h.name);

describe('a relevance band is a fence, not a preference', () => {
  it('will not lift a fragment below the floor, however much it is preferred', () => {
    const hits = [
      hit('strong-a', 'doc-1', 0, 'strong'),
      hit('weak-a', 'doc-2', 0, 'weak'),
      hit('below-floor', 'doc-3', 0, 'dropped'),
    ];

    // The most favourable adjustment the vocabulary can express, on the worst
    // possible fragment.
    const order = rank(hits, [{ kind: 'prefer_fragment', documentId: 'doc-3', chunkIndex: 0 }]);

    expect(order).toEqual(['strong-a', 'weak-a', 'below-floor']);
  });

  it('will not push the only strong match below a weak one', () => {
    const hits = [hit('the-answer', 'doc-1', 0, 'strong'), hit('tangential', 'doc-2', 0, 'weak')];

    const order = rank(hits, [
      { kind: 'demote_fragment', documentId: 'doc-1', chunkIndex: 0 },
      { kind: 'prefer_fragment', documentId: 'doc-2', chunkIndex: 0 },
    ]);

    // Demoted and still first, because it is the only thing that answers the
    // question and learning does not get a vote on that.
    expect(order).toEqual(['the-answer', 'tangential']);
  });

  it('reorders within a band, which is the whole point', () => {
    const hits = [
      hit('first-by-score', 'doc-1', 0, 'strong'),
      hit('second-by-score', 'doc-2', 0, 'strong'),
      hit('third-by-score', 'doc-3', 0, 'strong'),
    ];

    expect(rank(hits, [{ kind: 'demote_fragment', documentId: 'doc-1', chunkIndex: 0 }])).toEqual([
      'second-by-score',
      'third-by-score',
      'first-by-score',
    ]);

    expect(rank(hits, [{ kind: 'prefer_fragment', documentId: 'doc-3', chunkIndex: 0 }])).toEqual([
      'third-by-score',
      'first-by-score',
      'second-by-score',
    ]);
  });

  it('changes nothing at all when nothing has been learned', () => {
    const hits = [
      hit('a', 'doc-1', 0, 'strong'),
      hit('b', 'doc-2', 0, 'weak'),
      hit('c', 'doc-3', 0, 'dropped'),
    ];
    // The property that makes this safe to switch on for every workspace at
    // once, and that makes an A/B against the evaluation suite mean something:
    // with no adjustments, retrieval is exactly what it was before.
    expect(rank(hits, [])).toEqual(['a', 'b', 'c']);
  });

  it('keeps the database order among fragments it has no opinion about', () => {
    const hits = [
      hit('a', 'doc-1', 0, 'strong'),
      hit('b', 'doc-2', 0, 'strong'),
      hit('c', 'doc-3', 0, 'strong'),
      hit('d', 'doc-4', 0, 'strong'),
    ];
    expect(rank(hits, [{ kind: 'demote_fragment', documentId: 'doc-2', chunkIndex: 0 }])).toEqual([
      'a',
      'c',
      'd',
      'b',
    ]);
  });
});

describe('a whole-document doubt and a fragment verdict compose', () => {
  const index = indexAdjustments([
    { kind: 'stale_document', documentId: 'doc-1', chunkIndex: -1 },
    { kind: 'prefer_fragment', documentId: 'doc-1', chunkIndex: 4 },
  ]);

  it('drags every fragment of a doubtful document to the back of its band', () => {
    expect(tierFor(index, 'doc-1', 0)).toBe('demoted');
    expect(tierFor(index, 'doc-1', 9)).toBe('demoted');
  });

  it('except the one fragment somebody keeps finding useful', () => {
    // A stale contract can still hold the one clause everybody quotes, and the
    // per-fragment verdict is the more specific evidence.
    expect(tierFor(index, 'doc-1', 4)).toBe('preferred');
  });

  it('says nothing about documents it has never seen', () => {
    expect(tierFor(index, 'doc-2', 0)).toBe('normal');
  });
});
