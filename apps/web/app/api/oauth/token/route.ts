import { type NextRequest } from 'next/server';
import {
  getClient,
  consumeAuthCode,
  consumeRefreshToken,
  issueTokens,
  verifyPkce,
  mcpResource,
  MCP_SCOPE,
} from '@/lib/oauth';
import { corsJson, corsPreflight } from '@/lib/oauth-cors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * OAuth 2.1 token endpoint. Accepts application/x-www-form-urlencoded.
 * Supports the authorization_code and refresh_token grants. Refresh tokens are
 * rotated on use (public clients).
 */

function oauthError(
  error: string,
  description: string,
  status = 400,
): ReturnType<typeof corsJson> {
  return corsJson(
    { error, error_description: description },
    {
      status,
      headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
    },
  );
}

function tokenResponse(body: Record<string, unknown>): ReturnType<typeof corsJson> {
  return corsJson(body, {
    headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
  });
}

export async function POST(req: NextRequest) {
  let form: URLSearchParams;
  try {
    const text = await req.text();
    form = new URLSearchParams(text);
  } catch {
    return oauthError('invalid_request', 'Malformed request body');
  }

  const grantType = form.get('grant_type');

  if (grantType === 'authorization_code') {
    return handleAuthorizationCode(form);
  }
  if (grantType === 'refresh_token') {
    return handleRefreshToken(form);
  }
  return oauthError(
    'unsupported_grant_type',
    'grant_type must be authorization_code or refresh_token',
  );
}

async function handleAuthorizationCode(
  form: URLSearchParams,
): Promise<ReturnType<typeof corsJson>> {
  const code = form.get('code') ?? '';
  const redirectUri = form.get('redirect_uri') ?? '';
  const clientId = form.get('client_id') ?? '';
  const codeVerifier = form.get('code_verifier') ?? '';
  const clientSecret = form.get('client_secret');

  if (!code) return oauthError('invalid_request', 'missing code');
  if (!clientId) return oauthError('invalid_request', 'missing client_id');
  if (!codeVerifier)
    return oauthError('invalid_request', 'missing code_verifier (PKCE required)');

  const client = await getClient(clientId);
  if (!client) return oauthError('invalid_client', 'unknown client_id', 401);

  // Confidential client: verify secret.
  if (client.token_endpoint_auth_method !== 'none') {
    if (!clientSecret || clientSecret !== client.client_secret) {
      return oauthError('invalid_client', 'client authentication failed', 401);
    }
  }

  // Single-use consume; null => not found, expired, or already used.
  const stored = await consumeAuthCode(code);
  if (!stored) {
    return oauthError('invalid_grant', 'authorization code invalid or expired');
  }
  if (stored.client_id !== clientId) {
    return oauthError('invalid_grant', 'code was issued to a different client');
  }
  if (stored.redirect_uri !== redirectUri) {
    return oauthError('invalid_grant', 'redirect_uri mismatch');
  }
  if (
    !verifyPkce(codeVerifier, stored.code_challenge, stored.code_challenge_method)
  ) {
    return oauthError('invalid_grant', 'PKCE verification failed');
  }

  const tokens = await issueTokens({
    clientId,
    userId: stored.user_id,
    scope: stored.scope ?? MCP_SCOPE,
    resource: stored.resource ?? mcpResource(),
  });

  return tokenResponse({
    access_token: tokens.accessToken,
    token_type: 'Bearer',
    expires_in: tokens.expiresIn,
    refresh_token: tokens.refreshToken,
    scope: tokens.scope,
  });
}

async function handleRefreshToken(
  form: URLSearchParams,
): Promise<ReturnType<typeof corsJson>> {
  const refreshToken = form.get('refresh_token') ?? '';
  const clientId = form.get('client_id') ?? '';
  const clientSecret = form.get('client_secret');
  const requestedScope = form.get('scope');

  if (!refreshToken)
    return oauthError('invalid_request', 'missing refresh_token');
  if (!clientId) return oauthError('invalid_request', 'missing client_id');

  const client = await getClient(clientId);
  if (!client) return oauthError('invalid_client', 'unknown client_id', 401);

  if (client.token_endpoint_auth_method !== 'none') {
    if (!clientSecret || clientSecret !== client.client_secret) {
      return oauthError('invalid_client', 'client authentication failed', 401);
    }
  }

  // Rotate: consume the presented refresh token, issue a fresh pair.
  const stored = await consumeRefreshToken(refreshToken);
  if (!stored) {
    return oauthError('invalid_grant', 'refresh token invalid or expired');
  }
  if (stored.client_id !== clientId) {
    return oauthError('invalid_grant', 'token was issued to a different client');
  }

  // Narrowing scope is allowed; never widen beyond the original grant.
  const scope = requestedScope ?? stored.scope ?? MCP_SCOPE;

  const tokens = await issueTokens({
    clientId,
    userId: stored.user_id,
    scope,
    resource: stored.resource ?? mcpResource(),
  });

  return tokenResponse({
    access_token: tokens.accessToken,
    token_type: 'Bearer',
    expires_in: tokens.expiresIn,
    refresh_token: tokens.refreshToken,
    scope: tokens.scope,
  });
}

export function OPTIONS() {
  return corsPreflight();
}
