import 'server-only';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getEnv } from '@zipdev/core';
import { getSupabaseServiceClient } from './supabase/service';

/**
 * OAuth 2.1 authorization-server helpers for the claude.ai MCP connector.
 *
 * This app is BOTH the authorization server and the MCP resource server. All
 * persistence goes through the service-role Supabase client (RLS deny-all).
 *
 * Secret discipline: opaque tokens / codes are generated here and returned to
 * the caller exactly once; only their SHA-256 hash is stored. Lookups hash the
 * presented value and compare.
 */

// ----------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------

/** The single OAuth scope this MCP server understands. */
export const MCP_SCOPE = 'mcp';

/** Auth-code lifetime: 60 seconds (single use). */
export const AUTH_CODE_TTL_MS = 60_000;
/** Access-token lifetime: 1 hour. */
export const ACCESS_TOKEN_TTL_MS = 60 * 60_000;
/** Refresh-token lifetime: 30 days. */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;

/**
 * claude.ai redirect URIs — accepted in addition to anything a client
 * registers via DCR. Both claude.ai and the future claude.com host are
 * whitelisted per the connector spec.
 */
export const CLAUDE_REDIRECT_URIS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
] as const;

// ----------------------------------------------------------------------
// URL helpers
// ----------------------------------------------------------------------

/** The OAuth issuer / app base URL, no trailing slash. */
export function issuer(): string {
  return getEnv().APP_BASE_URL.replace(/\/+$/, '');
}

/** Canonical MCP resource identifier (token audience). */
export function mcpResource(): string {
  return `${issuer()}/mcp`;
}

// ----------------------------------------------------------------------
// Crypto helpers
// ----------------------------------------------------------------------

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Base64url SHA-256 (PKCE / token-comparison form). */
function sha256b64url(input: string): string {
  return createHash('sha256').update(input).digest('base64url');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Constant-time string compare. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Verify a PKCE code_verifier against a stored S256 challenge.
 * Returns false for any non-S256 method.
 */
export function verifyPkce(
  codeVerifier: string,
  codeChallenge: string,
  method: string,
): boolean {
  if (method !== 'S256') return false;
  if (!codeVerifier) return false;
  return safeEqual(sha256b64url(codeVerifier), codeChallenge);
}

// ----------------------------------------------------------------------
// Client registration (DCR)
// ----------------------------------------------------------------------

export interface OAuthClient {
  id: string;
  client_secret: string | null;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  scope: string | null;
  created_at: string;
}

export interface RegisterClientInput {
  client_name: string;
  redirect_uris: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
  scope?: string;
}

export async function registerClient(
  input: RegisterClientInput,
): Promise<OAuthClient> {
  const sb = getSupabaseServiceClient();
  const id = `client_${randomToken(16)}`;
  const authMethod = input.token_endpoint_auth_method ?? 'none';
  const secret = authMethod === 'none' ? null : randomToken(32);

  const row = {
    id,
    client_secret: secret,
    client_name: input.client_name,
    redirect_uris: input.redirect_uris,
    grant_types: input.grant_types ?? ['authorization_code', 'refresh_token'],
    response_types: input.response_types ?? ['code'],
    token_endpoint_auth_method: authMethod,
    scope: input.scope ?? MCP_SCOPE,
  };

  const { data, error } = await sb
    .from('oauth_clients')
    .insert(row)
    .select('*')
    .single();
  if (error || !data) {
    throw new Error(`Failed to register client: ${error?.message ?? 'no row'}`);
  }
  return data as unknown as OAuthClient;
}

export async function getClient(clientId: string): Promise<OAuthClient | null> {
  const sb = getSupabaseServiceClient();
  const { data, error } = await sb
    .from('oauth_clients')
    .select('*')
    .eq('id', clientId)
    .maybeSingle();
  if (error || !data) return null;
  return data as unknown as OAuthClient;
}

/** Whether a redirect_uri is allowed for this client (registered or claude.ai). */
export function isAllowedRedirectUri(
  client: OAuthClient,
  redirectUri: string,
): boolean {
  if (client.redirect_uris.includes(redirectUri)) return true;
  return (CLAUDE_REDIRECT_URIS as readonly string[]).includes(redirectUri);
}

// ----------------------------------------------------------------------
// Authorization codes
// ----------------------------------------------------------------------

export interface CreateAuthCodeInput {
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  resource: string | null;
}

/** Mint + store a single-use authorization code. Returns the plaintext code. */
export async function createAuthCode(input: CreateAuthCodeInput): Promise<string> {
  const sb = getSupabaseServiceClient();
  const code = randomToken(32);
  const { error } = await sb.from('oauth_authorization_codes').insert({
    code_hash: sha256(code),
    client_id: input.clientId,
    user_id: input.userId,
    redirect_uri: input.redirectUri,
    code_challenge: input.codeChallenge,
    code_challenge_method: input.codeChallengeMethod,
    scope: input.scope,
    resource: input.resource,
    expires_at: new Date(Date.now() + AUTH_CODE_TTL_MS).toISOString(),
  });
  if (error) throw new Error(`Failed to store auth code: ${error.message}`);
  return code;
}

export interface StoredAuthCode {
  code_hash: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  scope: string | null;
  resource: string | null;
  expires_at: string;
}

/**
 * Consume (look up + delete) an authorization code. Returns null if missing or
 * expired. Deletion makes the code single-use even if expired.
 */
export async function consumeAuthCode(
  code: string,
): Promise<StoredAuthCode | null> {
  const sb = getSupabaseServiceClient();
  const hash = sha256(code);
  const { data, error } = await sb
    .from('oauth_authorization_codes')
    .delete()
    .eq('code_hash', hash)
    .select('*')
    .maybeSingle();
  if (error || !data) return null;
  const row = data as unknown as StoredAuthCode;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

// ----------------------------------------------------------------------
// Access + refresh tokens
// ----------------------------------------------------------------------

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  scope: string;
  expiresIn: number;
}

export interface IssueTokensInput {
  clientId: string;
  userId: string;
  scope: string;
  resource: string | null;
}

/** Mint + store an access token and a refresh token. */
export async function issueTokens(
  input: IssueTokensInput,
): Promise<IssuedTokens> {
  const sb = getSupabaseServiceClient();
  const accessToken = randomToken(32);
  const refreshToken = randomToken(32);

  const accessRow = {
    token_hash: sha256(accessToken),
    client_id: input.clientId,
    user_id: input.userId,
    scope: input.scope,
    resource: input.resource,
    expires_at: new Date(Date.now() + ACCESS_TOKEN_TTL_MS).toISOString(),
  };
  const refreshRow = {
    token_hash: sha256(refreshToken),
    client_id: input.clientId,
    user_id: input.userId,
    scope: input.scope,
    resource: input.resource,
    expires_at: new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toISOString(),
  };

  const { error: aErr } = await sb.from('oauth_access_tokens').insert(accessRow);
  if (aErr) throw new Error(`Failed to store access token: ${aErr.message}`);
  const { error: rErr } = await sb
    .from('oauth_refresh_tokens')
    .insert(refreshRow);
  if (rErr) throw new Error(`Failed to store refresh token: ${rErr.message}`);

  return {
    accessToken,
    refreshToken,
    scope: input.scope,
    expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
  };
}

export interface StoredRefreshToken {
  token_hash: string;
  client_id: string;
  user_id: string;
  scope: string | null;
  resource: string | null;
  expires_at: string;
}

/**
 * Consume (look up + delete) a refresh token — used for rotation. Returns null
 * if missing or expired.
 */
export async function consumeRefreshToken(
  token: string,
): Promise<StoredRefreshToken | null> {
  const sb = getSupabaseServiceClient();
  const hash = sha256(token);
  const { data, error } = await sb
    .from('oauth_refresh_tokens')
    .delete()
    .eq('token_hash', hash)
    .select('*')
    .maybeSingle();
  if (error || !data) return null;
  const row = data as unknown as StoredRefreshToken;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

export interface StoredAccessToken {
  token_hash: string;
  client_id: string;
  user_id: string;
  scope: string | null;
  resource: string | null;
  expires_at: string;
}

/**
 * Validate a bearer access token. Returns the row if valid (exists, not
 * expired, and — when `expectedResource` is given — bound to that audience).
 */
export async function validateAccessToken(
  token: string,
  expectedResource?: string,
): Promise<StoredAccessToken | null> {
  const sb = getSupabaseServiceClient();
  const { data, error } = await sb
    .from('oauth_access_tokens')
    .select('*')
    .eq('token_hash', sha256(token))
    .maybeSingle();
  if (error || !data) return null;
  const row = data as unknown as StoredAccessToken;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  if (expectedResource && row.resource && row.resource !== expectedResource) {
    return null;
  }
  return row;
}
