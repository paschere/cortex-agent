import { headers } from 'next/headers';

/**
 * Absolute URL of this deployment's MCP endpoint — the one an MCP client
 * registers as a connector. Env first, then the incoming request host, so it is
 * correct in local dev, previews and production without any hardcoding.
 *
 * Server-only: reads `headers()`.
 */
export async function getMcpUrl(): Promise<string> {
  const configured = process.env.APP_BASE_URL ?? process.env.BETTER_AUTH_URL ?? '';
  let origin = configured;
  if (!origin) {
    const h = await headers();
    const host = h.get('host');
    origin = host ? `https://${host}` : '';
  }
  return `${origin.replace(/\/+$/, '')}/mcp`;
}
