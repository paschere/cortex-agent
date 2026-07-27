import { X509Certificate, createVerify } from 'node:crypto';
import { logger } from '@zipdev/core';

/**
 * Authenticating Google Chat's calls to our webhook.
 *
 * Every request Google Chat makes to an HTTP-endpoint Chat app carries
 * `Authorization: Bearer <JWT>`. That JWT is:
 *
 *   - signed RS256 by the Google-owned service account
 *     `chat@system.gserviceaccount.com`,
 *   - `iss` = that same service account,
 *   - `aud` = the Chat app's Google Cloud PROJECT NUMBER (or, if the app was
 *     configured with a custom audience, the endpoint URL),
 *   - short-lived (`exp` a few minutes out).
 *
 * The public keys are X.509 certificates published at a well-known URL, keyed
 * by the JWT's `kid`. They rotate, so we cache for an hour and force ONE
 * refetch when an unknown `kid` shows up (that is exactly what a rotation looks
 * like from here).
 *
 * We verify the signature ourselves with node:crypto rather than adding a JWT
 * dependency: `jose` is only present in this workspace as a transitive
 * dependency of better-auth, it is not hoisted into apps/web, and importing a
 * package we do not declare is how builds break at the worst moment.
 *
 * There is NO unauthenticated path in production. If `GOOGLE_CHAT_AUDIENCE` is
 * unset we reject everything, because with no expected audience the signature
 * check alone would accept a token minted for somebody else's Chat app.
 */

const CHAT_ISSUER = 'chat@system.gserviceaccount.com';
const CERTS_URL =
  'https://www.googleapis.com/service_accounts/v1/metadata/x509/chat@system.gserviceaccount.com';
const CERT_TTL_MS = 60 * 60_000;
/** Tolerated clock skew between Google and us, in seconds. */
const CLOCK_SKEW_S = 60;

export interface ChatJwtClaims {
  iss: string;
  aud: string;
  exp: number;
  iat?: number;
}

export type ChatAuthResult =
  | { ok: true; claims: ChatJwtClaims | null; bypassed: boolean }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Certificate cache
// ---------------------------------------------------------------------------

let certCache: { at: number; certs: Record<string, string> } | null = null;
let inFlight: Promise<Record<string, string>> | null = null;

async function fetchCerts(): Promise<Record<string, string>> {
  const res = await fetch(CERTS_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`certs ${res.status}`);
  const body = (await res.json()) as Record<string, string>;
  if (!body || typeof body !== 'object') throw new Error('certs payload malformed');
  return body;
}

async function getCerts(force = false): Promise<Record<string, string>> {
  if (!force && certCache && Date.now() - certCache.at < CERT_TTL_MS) return certCache.certs;
  // Collapse concurrent refreshes — a burst of Chat events must not fan out
  // into a burst of cert fetches.
  if (!inFlight) {
    inFlight = fetchCerts()
      .then((certs) => {
        certCache = { at: Date.now(), certs };
        return certs;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  try {
    return await inFlight;
  } catch (err) {
    logger.error('google-chat: could not fetch signing certificates', {
      error: (err as Error).message,
    });
    // A stale cache beats rejecting every request during a transient outage —
    // the certificates are long-lived and the signature check is unchanged.
    if (certCache) return certCache.certs;
    throw err;
  }
}

/** Exposed for tests / warm-up; never required by the request path. */
export function resetChatCertCache(): void {
  certCache = null;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

function decodeSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

/** Comma-separated so an app can accept both a project number and a URL. */
function expectedAudiences(): string[] {
  return (process.env.GOOGLE_CHAT_AUDIENCE ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
}

/**
 * Verify the Bearer JWT on an inbound Google Chat request.
 *
 * Checks, in order: audience configured → header shape → RS256 → known `kid`
 * (with one rotation refetch) → RSA signature over `header.payload` → issuer →
 * audience → expiry/issued-at with 60s of skew.
 */
export async function verifyGoogleChatRequest(
  authorization: string | null,
): Promise<ChatAuthResult> {
  const audiences = expectedAudiences();

  if (audiences.length === 0) {
    // Documented escape hatch for local development ONLY (ngrok/tunnel testing
    // before the app has a project number). Production always rejects.
    if (process.env.NODE_ENV !== 'production') {
      logger.warn(
        'google-chat: GOOGLE_CHAT_AUDIENCE is unset — accepting an UNVERIFIED Chat request. ' +
          'This bypass exists only outside production.',
      );
      return { ok: true, claims: null, bypassed: true };
    }
    logger.error('google-chat: GOOGLE_CHAT_AUDIENCE is unset — rejecting all Chat requests');
    return { ok: false, reason: 'audience not configured' };
  }

  const match = /^Bearer\s+(.+)$/i.exec((authorization ?? '').trim());
  const token = match?.[1]?.trim();
  if (!token) return { ok: false, reason: 'missing bearer token' };

  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed token' };
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  let header: { alg?: string; kid?: string };
  let claims: ChatJwtClaims;
  try {
    header = decodeSegment(headerB64) as { alg?: string; kid?: string };
    claims = decodeSegment(payloadB64) as ChatJwtClaims;
  } catch {
    return { ok: false, reason: 'undecodable token' };
  }

  if (header.alg !== 'RS256') return { ok: false, reason: `unsupported alg ${header.alg ?? '?'}` };
  const kid = header.kid;
  if (!kid) return { ok: false, reason: 'token has no kid' };

  let certs: Record<string, string>;
  try {
    certs = await getCerts();
  } catch {
    return { ok: false, reason: 'certificates unavailable' };
  }
  let pem = certs[kid];
  if (!pem) {
    // Unknown kid == key rotation. Refetch once before giving up.
    try {
      certs = await getCerts(true);
    } catch {
      return { ok: false, reason: 'certificates unavailable' };
    }
    pem = certs[kid];
  }
  if (!pem) return { ok: false, reason: `unknown signing key ${kid}` };

  let signatureValid = false;
  try {
    const publicKey = new X509Certificate(pem).publicKey;
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${headerB64}.${payloadB64}`);
    verifier.end();
    signatureValid = verifier.verify(publicKey, Buffer.from(signatureB64, 'base64url'));
  } catch (err) {
    logger.error('google-chat: signature verification threw', { error: (err as Error).message });
    return { ok: false, reason: 'signature check failed' };
  }
  if (!signatureValid) return { ok: false, reason: 'bad signature' };

  if (claims.iss !== CHAT_ISSUER) return { ok: false, reason: `unexpected issuer ${claims.iss}` };
  if (!audiences.includes(claims.aud)) {
    return { ok: false, reason: 'audience mismatch' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < now) {
    return { ok: false, reason: 'token expired' };
  }
  if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_S > now) {
    return { ok: false, reason: 'token issued in the future' };
  }

  return { ok: true, claims, bypassed: false };
}
