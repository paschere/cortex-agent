import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MAX_WEBHOOK_AGE_MS,
  verifyLinearRequest,
  verifyLinearSignature,
  verifyWebhookTimestamp,
} from './verify';

const SECRET = 'lin_wh_test_secret';
const ENV = { LINEAR_WEBHOOK_SECRET: SECRET } as unknown as NodeJS.ProcessEnv;

function sign(rawBody: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

function bodyAt(timestamp: number): string {
  return JSON.stringify({
    action: 'update',
    type: 'Issue',
    webhookTimestamp: timestamp,
    data: { id: 'issue-uuid', identifier: 'ENG-1' },
  });
}

describe('verifyLinearSignature', () => {
  it('accepts a body signed with the configured secret', () => {
    const raw = bodyAt(Date.now());
    expect(verifyLinearSignature({ rawBody: raw, signature: sign(raw), env: ENV })).toEqual({
      ok: true,
    });
  });

  it('accepts an upper-case digest (header casing is not ours to control)', () => {
    const raw = bodyAt(Date.now());
    const result = verifyLinearSignature({
      rawBody: raw,
      signature: sign(raw).toUpperCase(),
      env: ENV,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a body signed with a different secret', () => {
    const raw = bodyAt(Date.now());
    expect(
      verifyLinearSignature({ rawBody: raw, signature: sign(raw, 'other-secret'), env: ENV }),
    ).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects when a single byte of the body changed', () => {
    const raw = bodyAt(Date.now());
    const signature = sign(raw);
    const tampered = raw.replace('ENG-1', 'ENG-2');
    expect(verifyLinearSignature({ rawBody: tampered, signature, env: ENV })).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it.each([
    ['an absent header', null],
    ['an empty header', '   '],
  ])('rejects %s', (_label, signature) => {
    const raw = bodyAt(Date.now());
    expect(verifyLinearSignature({ rawBody: raw, signature, env: ENV })).toEqual({
      ok: false,
      reason: 'missing-signature',
    });
  });

  it.each([
    ['a truncated digest', 'abc123'],
    ['non-hex characters', 'z'.repeat(64)],
    ['an over-long digest', `${'a'.repeat(64)}00`],
    ['a sha256= prefix', `sha256=${'a'.repeat(64)}`],
  ])('rejects %s without throwing', (_label, signature) => {
    const raw = bodyAt(Date.now());
    expect(verifyLinearSignature({ rawBody: raw, signature, env: ENV })).toEqual({
      ok: false,
      reason: 'malformed-signature',
    });
  });

  it('rejects everything when no secret is configured — including valid signatures', () => {
    const raw = bodyAt(Date.now());
    const empty = {} as unknown as NodeJS.ProcessEnv;
    expect(verifyLinearSignature({ rawBody: raw, signature: sign(raw), env: empty })).toEqual({
      ok: false,
      reason: 'secret-not-configured',
    });
    // A blank value is a misconfiguration, not a permission to skip the check.
    const blank = { LINEAR_WEBHOOK_SECRET: '  ' } as unknown as NodeJS.ProcessEnv;
    expect(verifyLinearSignature({ rawBody: raw, signature: sign(raw), env: blank })).toEqual({
      ok: false,
      reason: 'secret-not-configured',
    });
  });
});

describe('verifyWebhookTimestamp', () => {
  const now = 1_770_000_000_000;

  it('accepts a fresh delivery', () => {
    expect(verifyWebhookTimestamp(now - 500, now)).toEqual({ ok: true });
  });

  it('accepts one right at the edge of the window', () => {
    expect(verifyWebhookTimestamp(now - MAX_WEBHOOK_AGE_MS, now)).toEqual({ ok: true });
  });

  it('rejects a replayed delivery', () => {
    expect(verifyWebhookTimestamp(now - MAX_WEBHOOK_AGE_MS - 1, now)).toEqual({
      ok: false,
      reason: 'stale-timestamp',
    });
    expect(verifyWebhookTimestamp(now - 86_400_000, now)).toEqual({
      ok: false,
      reason: 'stale-timestamp',
    });
  });

  it('rejects a timestamp too far in the future', () => {
    expect(verifyWebhookTimestamp(now + 120_000, now)).toEqual({
      ok: false,
      reason: 'future-timestamp',
    });
  });

  it.each([
    ['absent', undefined],
    ['a string', '1770000000000'],
    ['NaN', Number.NaN],
  ])('rejects a timestamp that is %s', (_label, value) => {
    expect(verifyWebhookTimestamp(value, now)).toEqual({ ok: false, reason: 'missing-timestamp' });
  });
});

describe('verifyLinearRequest', () => {
  it('returns the parsed body for a fresh, correctly signed delivery', () => {
    const now = Date.now();
    const raw = bodyAt(now);
    const result = verifyLinearRequest({ rawBody: raw, signature: sign(raw), now, env: ENV });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body.type).toBe('Issue');
  });

  it('checks the signature BEFORE the timestamp, so a replay cannot be re-stamped', () => {
    const now = Date.now();
    const original = bodyAt(now - 10 * 60_000);
    const signature = sign(original);
    // Attacker refreshes the timestamp to get inside the window but cannot
    // re-sign: the signature must fail first.
    const rewritten = original.replace(String(now - 10 * 60_000), String(now));
    const result = verifyLinearRequest({ rawBody: rewritten, signature, now, env: ENV });
    expect(result).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects a correctly signed replay of an old delivery', () => {
    const now = Date.now();
    const raw = bodyAt(now - 10 * 60_000);
    expect(verifyLinearRequest({ rawBody: raw, signature: sign(raw), now, env: ENV })).toEqual({
      ok: false,
      reason: 'stale-timestamp',
    });
  });

  it('rejects a signed body that is not a JSON object', () => {
    for (const raw of ['[1,2]', '"hello"', 'not json']) {
      expect(verifyLinearRequest({ rawBody: raw, signature: sign(raw), env: ENV })).toEqual({
        ok: false,
        reason: 'invalid-json',
      });
    }
  });
});
