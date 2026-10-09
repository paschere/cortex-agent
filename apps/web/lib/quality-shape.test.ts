import { describe, expect, it } from 'vitest';
import { percentile, summarizeQuality } from './quality-shape';

describe('percentile', () => {
  it('rango más cercano', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([10, 20, 30, 40, 50], 50)).toBe(30);
    expect(percentile([10, 20, 30, 40, 50], 95)).toBe(50);
  });
});

describe('summarizeQuality', () => {
  it('cuenta turnos rotos, herramientas que fallan y 👍/👎', () => {
    const s = summarizeQuality({
      latencies: [
        { total_ms: 1000, message_id: 'a' },
        { total_ms: 3000, message_id: null },
        { total_ms: 2000, message_id: 'b' },
        { total_ms: 9000, message_id: 'c' },
      ],
      errorToolIds: ['gmail.send', 'ledger.x', 'gmail.send', 'gmail.send', 'ledger.x'],
      feedback: [
        { rating: 1, reason: null, comment: null, created_at: '2026-10-01T00:00:00Z' },
        {
          rating: -1,
          reason: 'wrong_data',
          comment: 'mal precio',
          created_at: '2026-10-02T00:00:00Z',
        },
        { rating: -1, reason: 'slow', comment: null, created_at: '2026-10-03T00:00:00Z' },
      ],
    });
    expect(s.turns).toBe(4);
    expect(s.brokenTurns).toBe(1);
    expect(s.brokenRatio).toBe(0.25);
    expect(s.p50Ms).toBe(2000);
    expect(s.p95Ms).toBe(9000);
    expect(s.failingTools[0]).toEqual({ toolId: 'gmail.send', errors: 3 });
    expect(s.up).toBe(1);
    expect(s.down).toBe(2);
    expect(s.latestDown).toHaveLength(1);
  });

  it('sin datos no inventa cifras', () => {
    const s = summarizeQuality({ latencies: [], errorToolIds: [], feedback: [] });
    expect(s.brokenRatio).toBeNull();
    expect(s.p50Ms).toBeNull();
  });
});
