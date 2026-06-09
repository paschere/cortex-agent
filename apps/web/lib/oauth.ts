/**
 * Shared OAuth 2.1 helpers for the remote MCP connector.
 *
 * This module is Node-only (uses `node:crypto`). It centralizes the
 * primitives used by the authorization/token/registration endpoints and the
 * resource-server token validation:
 *
 *   - token generation (url-safe random strings)
 *   - SHA-256 hashing for storing token_hash / code_hash (we never persist
 *     plaintext codes or tokens)
 *   - PKCE S256 verification
 *   - the canonical issuer URL
 *   - TTL constants
 *
 * See infra/supabase/migrations/0025_oauth_mcp.sql for the storage model.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** TTL for access tokens, in seconds (1 hour). */
export const ACCESS_TOKEN_TTL_SECONDS = 3600;

/** TTL for refresh tokens, in seconds (30 days). */
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

/** TTL for authorization codes, in seconds (60 seconds — single use, short). */
export const AUTH_CODE_TTL_SECONDS = 60;

/**
 * Generate a cryptographically random, url-safe token string.
 *
 * @param bytes number of random bytes (default 32 → ~43 base64url chars).
 */
export function generateToken(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

/** SHA-256 hex digest of the input — used to store token_hash / code_hash. */
export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Verify a PKCE code_verifier against a stored code_challenge.
 *
 * Only S256 is supported (the spec requires it; `plain` is rejected). Returns
 * true iff method === "S256" and BASE64URL(SHA256(codeVerifier)) === codeChallenge.
 */
export function verifyPkce(
  codeVerifier: string,
  codeChallenge: string,
  method: string,
): boolean {
  if (method !== "S256") return false;
  if (!codeVerifier || !codeChallenge) return false;
  const computed = base64url(createHash("sha256").update(codeVerifier).digest());
  return safeEqual(computed, codeChallenge);
}

/**
 * The canonical issuer URL for this authorization server, with no trailing
 * slash. Must be byte-identical to the value advertised in AS metadata so
 * clients (Claude) accept the metadata (RFC 8414 issuer mix-up defense).
 */
export function issuer(): string {
  const raw =
    process.env.BETTER_AUTH_URL ??
    process.env.APP_BASE_URL ??
    "http://localhost:3000";
  return raw.replace(/\/+$/, "");
}

/** Base64url-encode a Buffer (no padding). */
function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Constant-time string comparison that tolerates differing lengths. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
