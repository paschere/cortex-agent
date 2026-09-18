import { describe, expect, it } from 'vitest';
import { sourceHealth } from './health';
const now = new Date('2026-09-18T12:00:00Z');
const source = {
  enabled: true,
  status: 'ok',
  last_checked_at: '2026-09-18T11:00:00Z',
  latest_attachment_id: 'capture',
  freshness_minutes: 1440,
};
const capture = { id: 'capture', purge_at: '2026-09-20T00:00:00Z', feed_truncated: false };
describe('Feed source health', () => {
  it('never calls partial, missing or expired captures healthy', () => {
    expect(sourceHealth(source, { ...capture, feed_truncated: true }, [], now).state).toBe(
      'incomplete',
    );
    expect(sourceHealth(source, null, [], now).state).toBe('missing');
    expect(sourceHealth(source, { ...capture, purge_at: '2026-09-17' }, [], now).state).toBe(
      'expired',
    );
  });
  it('reports stale readings and affected rules without claiming data correctness', () => {
    const result = sourceHealth(
      { ...source, last_checked_at: '2026-09-15' },
      capture,
      [{ status: 'active' }, { status: 'paused' }],
      now,
    );
    expect(result.state).toBe('stale');
    expect(result.affectedActivations).toBe(1);
  });
  it('keeps mandatory review and disconnection visible', () => {
    expect(sourceHealth(source, capture, [{ status: 'needs_review' }], now).state).toBe('review');
    expect(sourceHealth({ ...source, enabled: false }, capture, [], now).state).toBe(
      'disconnected',
    );
  });
});
