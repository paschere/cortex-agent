import { issuer, mcpResource, MCP_SCOPE } from '@/lib/oauth';
import { corsJson, corsPreflight } from '@/lib/oauth-cors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * RFC 9728 — OAuth 2.0 Protected Resource Metadata.
 *
 * Served by the MCP resource server. `resource` MUST equal the token audience
 * (the canonical MCP endpoint URI). `authorization_servers` points back at this
 * same app (it is also the AS).
 */
export function GET() {
  return corsJson({
    resource: mcpResource(),
    authorization_servers: [issuer()],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Cortex MCP',
  });
}

export function OPTIONS() {
  return corsPreflight();
}
