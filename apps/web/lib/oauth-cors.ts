import 'server-only';
import { NextResponse } from 'next/server';

/**
 * CORS headers for the OAuth discovery / DCR / token endpoints, which claude.ai
 * fetches cross-origin from the browser. We allow all origins because these
 * endpoints carry no cookies/credentials of their own (bearer-only) and the
 * discovery documents are public.
 */
export const OAUTH_CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, MCP-Protocol-Version, Mcp-Session-Id',
  'Access-Control-Max-Age': '86400',
};

/** A 204 preflight response for OPTIONS. */
export function corsPreflight(): NextResponse {
  return new NextResponse(null, { status: 204, headers: OAUTH_CORS_HEADERS });
}

/** Wrap a JSON body in a NextResponse with CORS headers applied. */
export function corsJson(
  body: unknown,
  init?: { status?: number; headers?: Record<string, string> },
): NextResponse {
  return NextResponse.json(body, {
    status: init?.status ?? 200,
    headers: { ...OAUTH_CORS_HEADERS, ...(init?.headers ?? {}) },
  });
}
