import { issuer, MCP_SCOPE } from '@/lib/oauth';
import { corsJson, corsPreflight } from '@/lib/oauth-cors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * RFC 8414 — OAuth 2.0 Authorization Server Metadata.
 *
 * `issuer` MUST be byte-identical to the issuer string claude.ai used to build
 * this well-known URL, else it rejects the document.
 */
export function GET() {
  const iss = issuer();
  return corsJson({
    issuer: iss,
    authorization_endpoint: `${iss}/api/oauth/authorize`,
    token_endpoint: `${iss}/api/oauth/token`,
    registration_endpoint: `${iss}/api/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    scopes_supported: [MCP_SCOPE],
    authorization_response_iss_parameter_supported: true,
  });
}

export function OPTIONS() {
  return corsPreflight();
}
