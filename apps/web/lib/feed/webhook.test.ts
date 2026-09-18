import { describe, expect, it } from 'vitest';
import { validateFeedSignal } from './webhook';
const now = Date.parse('2026-09-18T12:00:00Z');
const headers = () =>
  new Headers({
    'x-cortex-hook-token': 'a'.repeat(43),
    'x-cortex-event-id': 'order:42:changed',
    'x-cortex-timestamp': String(now / 1000),
  });
describe('Feed change notifications', () => {
  it('accepts fresh authenticated metadata and hashes the bearer', () => {
    expect(validateFeedSignal(headers(), now)).toMatchObject({
      eventId: 'order:42:changed',
      tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });
  it('rejects missing, malformed and expired headers', () => {
    expect(validateFeedSignal(new Headers(), now)).toBeNull();
    expect(validateFeedSignal(headers(), now + 300001)).toBeNull();
    const invalid = headers();
    invalid.set('x-cortex-event-id', '\n');
    expect(validateFeedSignal(invalid, now)).toBeNull();
  });
});
