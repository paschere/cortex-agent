import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getEnv } from '@cortex/core';

/**
 * Stateless confirmation tokens for the MCP surface.
 *
 * The web chat confirms side-effect tools interactively (UI prompt ->
 * /api/chat/confirm). Over MCP there is no UI channel, so instead: when a
 * gated tool is called unconfirmed, the server returns a signed token binding
 * (user, agent, tool, validated input, expiry). Claude shows the payload to
 * the user, and on explicit approval calls `zipdev_confirm_action` with the
 * token — which we verify and execute with { confirmed: true }.
 *
 * Tokens are HMAC-SHA256 signed with a key derived from TOKEN_ENCRYPTION_KEY
 * (domain-separated so a confirmation token can never be confused with any
 * other use of that key). Nothing is persisted; replay within the TTL is
 * acceptable because the token is only ever handed to the same authenticated
 * user who triggered the call, and verification re-checks the user binding.
 */

const TOKEN_VERSION = 'v1';
const TOKEN_TTL_MS = 15 * 60_000;
const HMAC_DOMAIN = 'zipdev-mcp-confirm';

export interface ConfirmationPayload {
  userId: string;
  agentId: string;
  toolId: string;
  input: unknown;
  expiresAt: number;
}

function signingKey(): Buffer {
  const master = Buffer.from(getEnv().TOKEN_ENCRYPTION_KEY, 'base64');
  return createHmac('sha256', master).update(HMAC_DOMAIN).digest();
}

function sign(payloadB64: string): string {
  return createHmac('sha256', signingKey())
    .update(`${TOKEN_VERSION}.${payloadB64}`)
    .digest('base64url');
}

export function mintConfirmationToken(input: {
  userId: string;
  agentId: string;
  toolId: string;
  input: unknown;
}): string {
  const payload: ConfirmationPayload = {
    userId: input.userId,
    agentId: input.agentId,
    toolId: input.toolId,
    input: input.input,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${TOKEN_VERSION}.${payloadB64}.${sign(payloadB64)}`;
}

/**
 * Verify a confirmation token. Returns the payload only if the signature is
 * valid, the token is unexpired, and it was minted for `expectedUserId`.
 */
export function verifyConfirmationToken(
  token: string,
  expectedUserId: string,
): ConfirmationPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return null;
  const [, payloadB64, sig] = parts as [string, string, string];

  const expected = Buffer.from(sign(payloadB64));
  const presented = Buffer.from(sig);
  if (expected.length !== presented.length) return null;
  if (!timingSafeEqual(expected, presented)) return null;

  let payload: ConfirmationPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload.expiresAt !== 'number' || payload.expiresAt <= Date.now()) return null;
  if (payload.userId !== expectedUserId) return null;
  return payload;
}
