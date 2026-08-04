import { MCP_SCOPE, issuer, mcpResource } from '@/lib/oauth';
import { corsJson, corsPreflight } from '@/lib/oauth-cors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * RFC 9728 path-inserted variant for the MCP endpoint at `/mcp`. claude.ai
 * probes `/.well-known/oauth-protected-resource/mcp` when the MCP URL has a
 * path. Identical document to the root variant.
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
