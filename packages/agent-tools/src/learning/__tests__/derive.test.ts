import { describe, expect, it } from 'vitest';
import {
  type TurnRecord,
  decideAdjustments,
  deriveBadCutProposals,
  deriveGapProposals,
  deriveTurnSignals,
  isDecisive,
  summarizeEvidence,
  topicOverlap,
  topicWords,
} from '../derive';
import type { LearningSignalInput } from '../types';

const NOW = new Date('2026-08-07T18:00:00Z');

function turn(over: Partial<TurnRecord> & Pick<TurnRecord, 'id' | 'createdAt'>): TurnRecord {
  return {
    conversationId: 'conv-1',
    userId: 'ana',
    ran: true,
    coverage: 'answered',
    query: '',
    fragments: [],
    ...over,
  };
}

const used = (documentId: string, chunkIndex: number) => ({
  documentId,
  chunkIndex,
  prepended: true,
  verdict: 'strong' as const,
});

describe('asking the same thing again is how a bad answer says so', () => {
  it('records it against the fragments that were actually pasted in', () => {
    const signals = deriveTurnSignals(
      [
        turn({
          id: 't1',
          createdAt: '2026-08-01T10:00:00Z',
          query: '¿cuánto cobramos por bodegaje en Cartagena?',
          fragments: [
            used('doc-1', 3),
            // Came back but was never prepended: it cannot be blamed for an
            // answer it was not part of.
            { documentId: 'doc-9', chunkIndex: 0, prepended: false, verdict: 'weak' },
          ],
        }),
        turn({
          id: 't2',
          createdAt: '2026-08-01T10:02:00Z',
          query: 'la tarifa de bodegaje en Cartagena cuánto es',
        }),
      ],
      NOW,
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]?.kind).toBe('reformulated');
    expect(signals[0]?.polarity).toBe(-1);
    expect(signals[0]?.documentId).toBe('doc-1');
    expect(signals[0]?.chunkIndex).toBe(3);
  });

  it('does not confuse a new subject with a second attempt', () => {
    const signals = deriveTurnSignals(
      [
        turn({
          id: 't1',
          createdAt: '2026-08-01T10:00:00Z',
          query: '¿cuánto cobramos por bodegaje en Cartagena?',
          fragments: [used('doc-1', 3)],
        }),
        turn({
          id: 't2',
          createdAt: '2026-08-01T10:02:00Z',
          query: 'mándale el contrato firmado a Marcela por correo',
        }),
      ],
      NOW,
    );

    // The counterweight, and it is evidence FOR the fragment: they got their
    // answer and went off to do something else.
    expect(signals.map((s) => s.kind)).toEqual(['moved_on']);
    expect(signals[0]?.polarity).toBe(1);
  });

  it('ignores a rephrasing that came an hour later', () => {
    const signals = deriveTurnSignals(
      [
        turn({
          id: 't1',
          createdAt: '2026-08-01T10:00:00Z',
          query: '¿cuánto cobramos por bodegaje en Cartagena?',
          fragments: [used('doc-1', 3)],
        }),
        turn({
          id: 't2',
          createdAt: '2026-08-01T11:30:00Z',
          query: 'la tarifa de bodegaje en Cartagena cuánto es',
        }),
      ],
      NOW,
    );
    expect(signals).toEqual([]);
  });

  it('only blames an abandoned conversation when retrieval had already given up', () => {
    const thin = deriveTurnSignals(
      [
        turn({ id: 't0', createdAt: '2026-08-01T09:58:00Z', query: 'hola buenas' }),
        turn({
          id: 't1',
          createdAt: '2026-08-01T10:00:00Z',
          coverage: 'thin',
          query: '¿cuánto cobramos por bodegaje en Cartagena?',
          fragments: [used('doc-1', 3)],
        }),
      ],
      NOW,
    );
    expect(thin.map((s) => s.kind)).toEqual(['abandoned']);

    const answered = deriveTurnSignals(
      [
        turn({ id: 't0', createdAt: '2026-08-01T09:58:00Z', query: 'hola buenas' }),
        turn({
          id: 't1',
          createdAt: '2026-08-01T10:00:00Z',
          coverage: 'answered',
          query: '¿cuánto cobramos por bodegaje en Cartagena?',
          fragments: [used('doc-1', 3)],
        }),
      ],
      NOW,
    );
    // Leaving after a good answer is what a good answer looks like.
    expect(answered).toEqual([]);
  });

  it('names every signal after the turn it came from, so a re-run is a no-op', () => {
    const turns = [
      turn({
        id: 't1',
        createdAt: '2026-08-01T10:00:00Z',
        query: '¿cuánto cobramos por bodegaje en Cartagena?',
        fragments: [used('doc-1', 3)],
      }),
      turn({
        id: 't2',
        createdAt: '2026-08-01T10:02:00Z',
        query: 'la tarifa de bodegaje en Cartagena cuánto es',
      }),
    ];
    const first = deriveTurnSignals(turns, NOW);
    const second = deriveTurnSignals(turns, NOW);
    expect(second.map((s) => s.dedupeKey)).toEqual(first.map((s) => s.dedupeKey));
  });
});

describe('comparing two questions', () => {
  it('ignores word order and politeness', () => {
    const a = topicWords('¿cuánto cobramos por bodegaje en Cartagena?');
    const b = topicWords('bodegaje Cartagena, cuánto cobramos');
    expect(topicOverlap(a, b)).toBeGreaterThanOrEqual(0.6);
  });

  it('does not collapse two different questions into one', () => {
    const a = topicWords('tarifa de bodegaje en Cartagena');
    const b = topicWords('tarifa de transporte en Medellín');
    expect(topicOverlap(a, b)).toBeLessThan(0.6);
  });
});

// ---------------------------------------------------------------------------

function signal(over: Partial<LearningSignalInput>): LearningSignalInput {
  return {
    kind: 'reformulated',
    polarity: -1,
    weight: 2,
    documentId: 'doc-1',
    chunkIndex: 3,
    actorUserId: 'ana',
    dedupeKey: Math.random().toString(),
    observedAt: '2026-08-01T10:00:00Z',
    ...over,
  };
}

describe('one person on one bad afternoon cannot move anything', () => {
  it('refuses evidence that is heavy but comes from a single sitting', () => {
    const evidence = summarizeEvidence(
      [
        signal({ observedAt: '2026-08-01T10:00:00Z' }),
        signal({ observedAt: '2026-08-01T10:05:00Z' }),
        signal({ observedAt: '2026-08-01T10:11:00Z' }),
        signal({ observedAt: '2026-08-01T10:20:00Z' }),
      ],
      NOW,
    );
    expect(evidence[0]?.negative).toBe(8);
    expect(evidence[0]?.actors).toBe(1);
    expect(evidence[0]?.days).toBe(1);
    expect(evidence[0] && isDecisive(evidence[0])).toBe(false);
    expect(decideAdjustments(evidence)).toEqual([]);
  });

  it('accepts the same weight once a second person agrees', () => {
    const evidence = summarizeEvidence(
      [
        signal({ actorUserId: 'ana', observedAt: '2026-08-01T10:00:00Z' }),
        signal({ actorUserId: 'ben', observedAt: '2026-08-02T10:00:00Z' }),
      ],
      NOW,
    );
    expect(evidence[0] && isDecisive(evidence[0])).toBe(true);
    expect(decideAdjustments(evidence)[0]?.kind).toBe('demote_fragment');
  });

  it('accepts one person only when they said it on three separate days', () => {
    const evidence = summarizeEvidence(
      [
        signal({ observedAt: '2026-08-01T10:00:00Z' }),
        signal({ observedAt: '2026-08-03T10:00:00Z' }),
        signal({ observedAt: '2026-08-05T10:00:00Z' }),
      ],
      NOW,
    );
    expect(evidence[0]?.days).toBe(3);
    expect(evidence[0] && isDecisive(evidence[0])).toBe(true);
  });

  it('lets evidence in favour cancel evidence against', () => {
    const evidence = summarizeEvidence(
      [
        signal({ actorUserId: 'ana', observedAt: '2026-08-01T10:00:00Z' }),
        signal({ actorUserId: 'ben', observedAt: '2026-08-02T10:00:00Z' }),
        signal({
          kind: 'fragment_copied',
          polarity: 1,
          weight: 2,
          actorUserId: 'cami',
          observedAt: '2026-08-03T10:00:00Z',
        }),
        signal({
          kind: 'fragment_copied',
          polarity: 1,
          weight: 2,
          actorUserId: 'dani',
          observedAt: '2026-08-04T10:00:00Z',
        }),
      ],
      NOW,
    );
    expect(evidence[0]?.net).toBe(0);
    expect(decideAdjustments(evidence)).toEqual([]);
  });

  it('forgets evidence older than the window', () => {
    const evidence = summarizeEvidence(
      [
        signal({ actorUserId: 'ana', observedAt: '2025-01-01T10:00:00Z' }),
        signal({ actorUserId: 'ben', observedAt: '2025-01-02T10:00:00Z' }),
      ],
      NOW,
    );
    expect(evidence).toEqual([]);
  });
});

describe('what a whole-document verdict may say', () => {
  it('turns corrections into a doubt about the document, never into a promotion', () => {
    const negative = summarizeEvidence(
      [
        signal({
          kind: 'extraction_corrected',
          weight: 3,
          chunkIndex: -1,
          actorUserId: 'ana',
          observedAt: '2026-08-01T10:00:00Z',
        }),
        signal({
          kind: 'field_corrected',
          weight: 3,
          chunkIndex: -1,
          actorUserId: 'ben',
          observedAt: '2026-08-02T10:00:00Z',
        }),
      ],
      NOW,
    );
    expect(decideAdjustments(negative)[0]?.kind).toBe('stale_document');

    const positive = summarizeEvidence(
      [
        signal({
          kind: 'extraction_confirmed',
          polarity: 1,
          weight: 3,
          chunkIndex: -1,
          actorUserId: 'ana',
          observedAt: '2026-08-01T10:00:00Z',
        }),
        signal({
          kind: 'extraction_confirmed',
          polarity: 1,
          weight: 3,
          chunkIndex: -1,
          actorUserId: 'ben',
          observedAt: '2026-08-02T10:00:00Z',
        }),
      ],
      NOW,
    );
    // There is no such thing as auto-promoting a whole document: never having
    // been complained about is the normal case, not an achievement.
    expect(decideAdjustments(positive)).toEqual([]);
  });
});

describe('what it may only propose', () => {
  it('raises a gap when several people ask something nobody wrote down', () => {
    const asks = ['ana', 'ben', 'cami'].map((who, i) =>
      turn({
        id: `t${i}`,
        conversationId: `conv-${i}`,
        userId: who,
        createdAt: `2026-08-0${i + 1}T10:00:00Z`,
        coverage: 'nothing',
        query: 'política de horas extra en festivos',
      }),
    );
    const proposals = deriveGapProposals(asks);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.kind).toBe('unanswered_question');
    // Never applied: there is no retrieval fix for material that does not exist.
    expect(proposals[0]?.documentId).toBeNull();
  });

  it('does not raise a gap one person asked once', () => {
    expect(
      deriveGapProposals([
        turn({
          id: 't1',
          createdAt: '2026-08-01T10:00:00Z',
          coverage: 'nothing',
          query: 'política de horas extra en festivos',
        }),
      ]),
    ).toEqual([]);
  });

  it('spots a fragment that keeps losing next to its own neighbour', () => {
    const turns = [0, 1, 2].map((i) =>
      turn({
        id: `t${i}`,
        conversationId: `conv-${i}`,
        createdAt: `2026-08-0${i + 1}T10:00:00Z`,
        query: 'tarifa de bodegaje',
        fragments: [
          used('doc-1', 7),
          { documentId: 'doc-1', chunkIndex: 8, prepended: false, verdict: 'dropped' },
        ],
      }),
    );
    const proposals = deriveBadCutProposals(turns);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.kind).toBe('badly_cut_fragment');
    expect(proposals[0]?.chunkIndex).toBe(8);
  });
});
