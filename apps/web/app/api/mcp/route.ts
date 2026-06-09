/**
 * Remote MCP endpoint — Streamable HTTP transport (MCP 2025-03-26).
 *
 * This is the single MCP endpoint Claude (claude.ai connector) talks to. It
 * speaks the Streamable HTTP transport over ONE path that handles POST (the
 * primary JSON-RPC channel), GET (optional server->client SSE — we 405 it since
 * we have no server-initiated streams), DELETE (session teardown), and OPTIONS
 * (CORS preflight).
 *
 * Auth: this route is an OAuth 2.1 RESOURCE SERVER. Every request must carry
 * `Authorization: Bearer <token>`. We sha256() the token and look it up in
 * `oauth_access_tokens` (rejecting expired rows). An unauthenticated/expired
 * request gets a 401 whose `WWW-Authenticate` header points Claude at our
 * Protected Resource Metadata (RFC 9728) document so it can begin the OAuth
 * flow. See infra/supabase/migrations/0025_oauth_mcp.sql + apps/web/lib/oauth.ts.
 *
 * Tool execution is NOT reinvented here: we reuse the exact same path as the
 * chat route — loadAgent -> filterTools(agent.allowedTools) -> runTool with a
 * ToolContext from buildToolContext(). The only MCP-specific glue is JSON-RPC
 * framing and the dot<->underscore tool-name mapping Claude requires.
 *
 * We hand-roll JSON-RPC rather than use the MCP SDK server transport (that
 * transport is Node-stream based and awkward inside a Next.js route handler).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { randomUUID } from 'node:crypto';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { buildToolContext } from '@/lib/agent';
import { sha256, issuer } from '@/lib/oauth';
import { loadAgent } from '@zipdev/agents';
import { filterTools, runTool, type AnyTool } from '@zipdev/agent-tools';
import { ConfirmationRequiredError } from '@zipdev/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** The MCP protocol version we implement / advertise. */
const PROTOCOL_VERSION = '2025-03-26';
const SERVER_NAME = 'zipdev-agent';
const SERVER_VERSION = '0.1.0';
/** Which agent's allowed-tools we expose over MCP. */
const AGENT_SLUG = 'sales';

// ---------------------------------------------------------------------------
// CORS — claude.ai (web/desktop/mobile) calls this cross-origin.
// ---------------------------------------------------------------------------
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, WWW-Authenticate',
  'Access-Control-Max-Age': '86400',
};

// ---------------------------------------------------------------------------
// JSON-RPC types
// ---------------------------------------------------------------------------
type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// JSON-RPC standard error codes.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

function rpcOk(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function rpcErr(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

/** A message is a "request" (needs a response) iff it has a method AND an id. */
function isRequest(msg: unknown): msg is JsonRpcRequest {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    typeof (msg as JsonRpcRequest).method === 'string' &&
    'id' in (msg as object) &&
    (msg as JsonRpcRequest).id !== undefined
  );
}

/** A notification has a method but no id (fire-and-forget). */
function isNotification(msg: unknown): boolean {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    typeof (msg as JsonRpcRequest).method === 'string' &&
    (!('id' in (msg as object)) || (msg as JsonRpcRequest).id === undefined)
  );
}

// ---------------------------------------------------------------------------
// Auth: validate the bearer token against oauth_access_tokens.
// ---------------------------------------------------------------------------
interface AuthResult {
  userId: string;
  scope: string | null;
}

async function authenticate(req: NextRequest): Promise<AuthResult | null> {
  const header = req.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const token = (match[1] ?? '').trim();
  if (!token) return null;

  const db = getSupabaseServiceClient();
  const { data, error } = await db
    .from('oauth_access_tokens')
    .select('user_id, scope, expires_at')
    .eq('token_hash', sha256(token))
    .maybeSingle();

  if (error || !data) return null;
  const expiresAt = data.expires_at as string | null;
  if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) return null;
  if (!data.user_id) return null;

  return { userId: data.user_id as string, scope: (data.scope as string | null) ?? null };
}

/** The RFC 9728 Protected Resource Metadata document URL we point Claude at. */
function resourceMetadataUrl(): string {
  return `${issuer()}/.well-known/oauth-protected-resource`;
}

/** 401 with a WWW-Authenticate header per the MCP OAuth spec. */
function unauthorized(): NextResponse {
  return new NextResponse(
    JSON.stringify(rpcErr(null, INVALID_REQUEST, 'Unauthorized')),
    {
      status: 401,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl()}", scope="read write"`,
      },
    },
  );
}

// ---------------------------------------------------------------------------
// MCP capability data
// ---------------------------------------------------------------------------

/** Static prompt list (data only — mirrors apps/mcp/src/prompts.ts). */
const PROMPTS = [
  {
    name: 'draft-proposal',
    description: 'Draft a complete client proposal for a Zipdev candidate role.',
    arguments: [
      { name: 'role', description: 'e.g., "frontend", "fullstack"', required: true },
      { name: 'seniority', description: 'junior | mid | senior | lead', required: true },
      { name: 'companyId', description: 'Optional HubSpot company ID for context', required: false },
    ],
  },
  {
    name: 'qualify-lead',
    description: 'Walk through qualifying a sales lead from HubSpot data.',
    arguments: [{ name: 'dealId', description: 'HubSpot deal ID', required: true }],
  },
  {
    name: 'rate-question',
    description: 'Answer a rate question by calling rate.estimate.',
    arguments: [
      { name: 'role', description: 'Role to estimate', required: true },
      { name: 'seniority', description: 'Seniority level', required: true },
      { name: 'region', description: 'Optional region', required: false },
    ],
  },
];

/** Static resource list. */
const RESOURCES = [
  { uri: 'zipdev://agent/system-prompt', name: 'Current agent system prompt', mimeType: 'text/markdown' },
  { uri: 'zipdev://kb/collections', name: 'Visible KB collections', mimeType: 'application/json' },
];

// MCP tool name == tool id with dots replaced by underscores (Claude rejects dots).
function toMcpName(id: string): string {
  return id.replaceAll('.', '_');
}

function buildToolDefs(tools: AnyTool[]) {
  return tools.map((t) => ({
    name: toMcpName(t.id),
    description: t.description,
    inputSchema: zodToJsonSchema(t.inputSchema, {
      name: 'schema',
      $refStrategy: 'none',
    }) as { type: 'object'; properties?: Record<string, unknown> },
  }));
}

// ---------------------------------------------------------------------------
// JSON-RPC method dispatch
// ---------------------------------------------------------------------------
async function dispatch(
  method: string,
  params: unknown,
  id: JsonRpcId,
  auth: AuthResult,
): Promise<JsonRpcResponse> {
  switch (method) {
    case 'initialize':
      return rpcOk(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {}, prompts: {}, resources: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });

    case 'ping':
      return rpcOk(id, {});

    case 'tools/list': {
      const db = getSupabaseServiceClient();
      const agent = await loadAgent(db, AGENT_SLUG);
      const tools = filterTools(agent.allowedTools);
      return rpcOk(id, { tools: buildToolDefs(tools) });
    }

    case 'tools/call': {
      const p = (params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      const mcpName = p.name ?? '';
      const args = p.arguments ?? {};

      const db = getSupabaseServiceClient();
      const agent = await loadAgent(db, AGENT_SLUG);
      const tools = filterTools(agent.allowedTools);
      const tool = tools.find((t) => toMcpName(t.id) === mcpName);
      if (!tool) {
        return rpcOk(id, {
          content: [{ type: 'text', text: `Unknown tool: ${mcpName}` }],
          isError: true,
        });
      }

      const ctx = buildToolContext({ userId: auth.userId, agentId: agent.id });
      try {
        const result = await runTool(tool, args, ctx);
        return rpcOk(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        });
      } catch (err) {
        if (err instanceof ConfirmationRequiredError) {
          return rpcOk(id, {
            content: [
              {
                type: 'text',
                text: `Confirmation required to run "${tool.id}". This action has side effects and must be confirmed before executing.`,
              },
            ],
            isError: true,
          });
        }
        const message = err instanceof Error ? err.message : String(err);
        return rpcOk(id, {
          content: [{ type: 'text', text: message.slice(0, 4000) }],
          isError: true,
        });
      }
    }

    case 'prompts/list':
      return rpcOk(id, { prompts: PROMPTS });

    case 'resources/list':
      return rpcOk(id, { resources: RESOURCES });

    case 'resources/read': {
      const p = (params ?? {}) as { uri?: string };
      const uri = p.uri ?? '';
      const db = getSupabaseServiceClient();

      if (uri === 'zipdev://agent/system-prompt') {
        const agent = await loadAgent(db, AGENT_SLUG);
        return rpcOk(id, {
          contents: [{ uri, mimeType: 'text/markdown', text: agent.systemPrompt }],
        });
      }
      if (uri === 'zipdev://kb/collections') {
        const { data: collections } = await db
          .from('kb_collections')
          .select('id, scope, scope_id, name')
          .or(`scope.eq.global,and(scope.eq.user,scope_id.eq.${auth.userId})`);
        return rpcOk(id, {
          contents: [
            { uri, mimeType: 'application/json', text: JSON.stringify(collections ?? []) },
          ],
        });
      }
      return rpcErr(id, INVALID_REQUEST, `Unknown resource: ${uri}`);
    }

    default:
      return rpcErr(id, METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new NextResponse(JSON.stringify(rpcErr(null, PARSE_ERROR, 'Parse error')), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const isBatch = Array.isArray(body);
  const messages: unknown[] = isBatch ? (body as unknown[]) : [body];

  if (messages.length === 0) {
    return new NextResponse(JSON.stringify(rpcErr(null, INVALID_REQUEST, 'Empty batch')), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const requests = messages.filter(isRequest);
  const hasOnlyNotificationsOrResponses = requests.length === 0;

  // Body with ONLY notifications and/or responses (no requests) -> 202, no body.
  if (hasOnlyNotificationsOrResponses) {
    // Validate that every message is at least a notification/response (has the
    // jsonrpc envelope). If a message is malformed, reject with 400.
    const allValid = messages.every(
      (m) => isNotification(m) || (typeof m === 'object' && m !== null && 'id' in (m as object)),
    );
    if (!allValid) {
      return new NextResponse(JSON.stringify(rpcErr(null, INVALID_REQUEST, 'Invalid Request')), {
        status: 400,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }
    return new NextResponse(null, { status: 202, headers: CORS_HEADERS });
  }

  // Determine if this POST carries an `initialize` request — only then do we
  // assign a session id on the response.
  const hasInitialize = requests.some((r) => r.method === 'initialize');

  // Dispatch every request. Notifications mixed into a batch are simply ignored
  // here (no response emitted for them).
  const responses: JsonRpcResponse[] = [];
  for (const r of requests) {
    const reqId = r.id ?? null;
    try {
      responses.push(await dispatch(r.method, r.params, reqId, auth));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      responses.push(rpcErr(reqId, INTERNAL_ERROR, message));
    }
  }

  const headers: Record<string, string> = {
    ...CORS_HEADERS,
    'Content-Type': 'application/json',
  };
  if (hasInitialize) {
    headers['Mcp-Session-Id'] = randomUUID();
  }

  // We always answer requests with a single application/json body (no SSE) —
  // permitted by the spec; we have no server-initiated messages to stream.
  // `requests` is non-empty here, so `responses[0]` is always defined.
  const payload = isBatch ? responses : (responses[0] as JsonRpcResponse);
  return new NextResponse(JSON.stringify(payload), { status: 200, headers });
}

// GET: we offer no standalone server->client SSE stream. 405 is fully
// spec-compliant for a server that does not implement GET streams.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();
  return new NextResponse(JSON.stringify(rpcErr(null, METHOD_NOT_FOUND, 'No SSE stream')), {
    status: 405,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', Allow: 'POST, DELETE, OPTIONS' },
  });
}

// DELETE: session teardown. We keep no server-side session state (the
// Mcp-Session-Id is informational), so we simply acknowledge.
export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
