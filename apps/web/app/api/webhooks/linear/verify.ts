import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Authenticating Linear's calls to our webhook.
 *
 * Linear signs every delivery with HMAC-SHA256 over the RAW request body, using
 * the secret shown once when the webhook is created, and sends the digest as
 * lowercase hex in the `Linear-Signature` header. The body also carries a
 * `webhookTimestamp` (milliseconds since the epoch) which Linear's own docs tell
 * you to check, because a signature stays valid forever — capture one delivery
 * and you can replay it a year later unless somebody looks at the clock.
 *
 * Two properties this file is responsible for:
 *
 *   1. NOTHING UNSIGNED IS EVER PARSED. The signature is checked against the
 *      exact bytes we received, before the body is treated as JSON. If
 *      `LINEAR_WEBHOOK_SECRET` is unset we reject everything, in every
 *      environment — unlike the Google Chat endpoint there is no local-dev
 *      bypass here, because this webhook's whole job is to start unattended
 *      code execution against real repositories. A tunnel plus a copied secret
 *      is a two-minute setup; an open door is not worth saving it.
 *
 *   2. THE TIMESTAMP IS ONLY TRUSTED AFTER THE SIGNATURE. It lives inside the
 *      signed body, so checking it second means an attacker cannot rewrite it.
 *
 * The digest comparison is constant-time. A byte-by-byte early exit leaks how
 * much of a forged signature was right, which is enough to reconstruct one.
 */

/** How old a delivery may be. Linear signs and sends immediately. */
export const MAX_WEBHOOK_AGE_MS = 60_000;
/** Tolerated forward clock skew between Linear and us. */
export const MAX_WEBHOOK_SKEW_MS = 60_000;

export type LinearVerifyFailure =
  | 'secret-not-configured'
  | 'missing-signature'
  | 'malformed-signature'
  | 'bad-signature'
  | 'missing-timestamp'
  | 'stale-timestamp'
  | 'future-timestamp';

export type LinearSignatureResult = { ok: true } | { ok: false; reason: LinearVerifyFailure };

/** Lowercase hex, 64 chars — the shape of a SHA-256 digest. */
const HEX_DIGEST_RE = /^[0-9a-f]{64}$/;

function readSecret(env: NodeJS.ProcessEnv): string | null {
  const secret = env.LINEAR_WEBHOOK_SECRET?.trim();
  return secret ? secret : null;
}

/**
 * Verify `Linear-Signature` against the raw body.
 *
 * `rawBody` MUST be the untouched request text. Re-serialising the parsed JSON
 * changes key order and whitespace, and the digest with it — that is the
 * classic way this check silently starts rejecting everything.
 */
export function verifyLinearSignature(opts: {
  rawBody: string;
  signature: string | null | undefined;
  env?: NodeJS.ProcessEnv;
}): LinearSignatureResult {
  const secret = readSecret(opts.env ?? process.env);
  if (!secret) return { ok: false, reason: 'secret-not-configured' };

  const provided = opts.signature?.trim().toLowerCase();
  if (!provided) return { ok: false, reason: 'missing-signature' };
  // Length and alphabet are checked before timingSafeEqual, which throws on a
  // length mismatch. Rejecting on shape leaks nothing a forger did not already
  // know: the digest length is public.
  if (!HEX_DIGEST_RE.test(provided)) return { ok: false, reason: 'malformed-signature' };

  const expected = createHmac('sha256', secret).update(opts.rawBody, 'utf8').digest('hex');
  const match = timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'));
  return match ? { ok: true } : { ok: false, reason: 'bad-signature' };
}

/**
 * Refuse replays. Called only once the signature has been verified, so the
 * timestamp it reads is one Linear actually signed.
 */
export function verifyWebhookTimestamp(
  webhookTimestamp: unknown,
  now: number = Date.now(),
): LinearSignatureResult {
  if (typeof webhookTimestamp !== 'number' || !Number.isFinite(webhookTimestamp)) {
    return { ok: false, reason: 'missing-timestamp' };
  }
  const age = now - webhookTimestamp;
  if (age > MAX_WEBHOOK_AGE_MS) return { ok: false, reason: 'stale-timestamp' };
  if (age < -MAX_WEBHOOK_SKEW_MS) return { ok: false, reason: 'future-timestamp' };
  return { ok: true };
}

/**
 * Signature, then parse, then timestamp — in that order, which is the whole
 * point. Returns the parsed body so the caller never re-parses (and never has
 * a chance to parse the unverified one).
 */
export function verifyLinearRequest(opts: {
  rawBody: string;
  signature: string | null | undefined;
  now?: number;
  env?: NodeJS.ProcessEnv;
}):
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; reason: LinearVerifyFailure | 'invalid-json' } {
  const sig = verifyLinearSignature({
    rawBody: opts.rawBody,
    signature: opts.signature,
    ...(opts.env ? { env: opts.env } : {}),
  });
  if (!sig.ok) return sig;

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(opts.rawBody);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'invalid-json' };
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }

  const ts = verifyWebhookTimestamp(body.webhookTimestamp, opts.now ?? Date.now());
  if (!ts.ok) return ts;

  return { ok: true, body };
}
