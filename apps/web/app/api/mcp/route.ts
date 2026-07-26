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
 * Tool surface: the UNION of every agent's allowed tools (sales, recruiting,
 * zippy, …) loaded from the `agents` table, executed through the exact same
 * path as the chat route — filterTools -> runTool with a ToolContext from
 * buildToolContext(). Each tool is attributed to the first agent that allows
 * it so audit events keep a real agent_id.
 *
 * Confirmation-gated tools (requiresConfirmation) cannot pop a UI over MCP.
 * Instead, an unconfirmed call returns a signed confirmation token (see
 * lib/mcp-confirm.ts) plus instructions; after the user explicitly approves,
 * Claude calls the virtual `zipdev_confirm_action` tool with that token and
 * the action executes with { confirmed: true } — same contract as
 * /api/chat/confirm on the web.
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
import { mintConfirmationToken, verifyConfirmationToken } from '@/lib/mcp-confirm';
import { deniedToolPatterns, isToolDenied } from '@/lib/tool-access';
import { filterTools, getTool, runTool, type AnyTool } from '@zipdev/agent-tools';
import { ConfirmationRequiredError } from '@zipdev/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** The MCP protocol version we implement / advertise. */
const PROTOCOL_VERSION = '2025-03-26';
const SERVER_NAME = 'zipdev-agent';
const SERVER_VERSION = '0.2.0';

/**
 * Served on `initialize` — this is the closest MCP gets to a system prompt,
 * and it is what makes Claude behave like a Zipdev agent instead of a generic
 * assistant with tools.
 */
const INSTRUCTIONS = `While these tools are active you take on the role of **Zippy** ⚡ — Zipdev's super-agent and newest teammate. Zipdev is a nearshore developer-talent company; this server is Zippy's brain and hands: its Knowledge Base, CRM, ATS, talent pool, rates engine, pipelines, and routines.

YOUR PERSONA (in effect whenever you do Zipdev work in this conversation):
- You are Zippy, a teammate — not a generic assistant. When greeting or starting Zipdev work, introduce yourself as Zippy. Speak in first person about the work: "ya busqué en el talent pool", "te preparo el borrador".
- Personality: sharp, warm, direct. Numbers over adjectives. Lead with the answer, then the support. A touch of energy (an occasional ⚡ is fine, never more than one per message).
- Match the user's language — Spanish in, Spanish out. Client-facing drafts go in the client's language.
- If someone asks what you literally are, be honest (Claude acting as Zippy, Zipdev's agent) — never deceptive, but don't volunteer the machinery.

HOW ZIPPY SPEAKS (users are often non-technical):
- Never mention tool names, function calls, ids/UUIDs, or jargon ("fire-and-forget", "sync status"). Describe actions in plain human terms and refer to things by name.
- For slow operations, set expectations and drive the follow-up yourself ("dame dos minutos — ¿quieres que revise ya?"). Never tell the user to run something; running tools is your job.
- One question at a time. Short sentences. The mechanics stay invisible.

HOW ZIPPY WORKS:
1. **Orient first.** Call \`zipdev_overview\` early to see connected integrations, agents, and Knowledge Base collections.
2. **The KB is Zipdev's memory.** Before answering anything that could be covered by internal knowledge — clients, playbooks, rates, candidates, past proposals — search it with \`kb_search\` and ground your answer in the hits. Persist durable work products back with \`kb_create_document\`.
3. **Ground every claim in tool data.** Never invent a deal, contact, candidate, rate, or statistic. Fetch it this turn; cite human-verifiable references (deal names, \`ENG-45\`, \`owner/repo#123\`).
4. **Writes are confirmation-gated.** Create/update/send/post tools do NOT execute on first call — they return a confirmation_id, the exact payload, and WHY the action is gated. Explain that in the user's language, show what will happen, get an explicit yes, then call \`zipdev_confirm_action\`. If the user declines, do nothing.
5. **Offload heavy reading.** For large documents, delegate with \`zippy_process\` instead of pulling the content into the conversation.`;

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
// Agent catalog — union of every agent's allowed tools.
// ---------------------------------------------------------------------------
interface AgentRow {
  id: string;
  slug: string;
  name: string;
  system_prompt: string;
  allowed_tool_ids: string[];
}

interface CatalogEntry {
  tool: AnyTool;
  /** First agent (by slug order) that allows this tool — used for audit attribution. */
  agentId: string;
  agentSlug: string;
}

// Module-level cache: agents change via migrations, not at runtime, so 60s
// staleness is fine and saves a DB round-trip per JSON-RPC message.
const AGENTS_CACHE_TTL_MS = 60_000;
let agentsCache: { at: number; agents: AgentRow[] } | null = null;

async function loadAllAgents(): Promise<AgentRow[]> {
  if (agentsCache && Date.now() - agentsCache.at < AGENTS_CACHE_TTL_MS) {
    return agentsCache.agents;
  }
  const db = getSupabaseServiceClient();
  const { data, error } = await db
    .from('agents')
    .select('id, slug, name, system_prompt, allowed_tool_ids')
    .eq('archived', false)
    .order('slug');
  if (error || !data || data.length === 0) {
    throw new Error(`Failed to load agents: ${error?.message ?? 'no rows'}`);
  }
  const agents = data as unknown as AgentRow[];
  agentsCache = { at: Date.now(), agents };
  return agents;
}

// MCP tool name == tool id with dots replaced by underscores (Claude rejects dots).
function toMcpName(id: string): string {
  return id.replaceAll('.', '_');
}

/**
 * The catalog is per-user: team tool permissions are a deny-list layered on
 * top of the agents' allowed tools, so a blocked tool is neither advertised in
 * tools/list nor resolvable in tools/call (it falls through to "Unknown tool").
 */
async function buildCatalog(userId?: string): Promise<Map<string, CatalogEntry>> {
  const agents = await loadAllAgents();
  const denied = userId ? await deniedToolPatterns(getSupabaseServiceClient(), userId) : [];
  // Zippy first: shared tools attribute to the super-agent (audit trail and
  // MCP conversations read as Zippy's work, matching the product story).
  const ordered = [...agents].sort((a, b) =>
    a.slug === 'zippy' ? -1 : b.slug === 'zippy' ? 1 : a.slug.localeCompare(b.slug),
  );
  const catalog = new Map<string, CatalogEntry>();
  for (const agent of ordered) {
    for (const tool of filterTools(agent.allowed_tool_ids ?? [])) {
      if (denied.length > 0 && isToolDenied(tool.id, denied)) continue;
      const name = toMcpName(tool.id);
      if (!catalog.has(name)) {
        catalog.set(name, { tool, agentId: agent.id, agentSlug: agent.slug });
      }
    }
  }
  return catalog;
}

// ---------------------------------------------------------------------------
// Tool definitions (tools/list payload)
// ---------------------------------------------------------------------------

const FAMILY_TITLES: Record<string, string> = {
  hubspot: 'HubSpot',
  kb: 'Knowledge Base',
  gmail: 'Gmail',
  gcal: 'Google Calendar',
  gsheets: 'Google Sheets',
  gdrive: 'Google Drive',
  github: 'GitHub',
  linear: 'Linear',
  web: 'Web',
  rate: 'Rates',
  recruit: 'Recruiting',
  slack: 'Slack',
  people: 'People',
  payroll: 'Payroll',
  sales: 'Sales',
  format: 'Formatting',
};

/** 'hubspot.search_companies' -> 'HubSpot · Search Companies' */
function toolTitle(id: string): string {
  const [family = '', ...rest] = id.split('.');
  const action = rest
    .join('.')
    .split('_')
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
  const familyTitle = FAMILY_TITLES[family] ?? family;
  return action ? `${familyTitle} · ${action}` : familyTitle;
}

function toInputSchema(tool: AnyTool): Record<string, unknown> {
  const schema = zodToJsonSchema(tool.inputSchema, { $refStrategy: 'none' }) as Record<
    string,
    unknown
  >;
  delete schema.$schema;
  if (schema.type !== 'object') return { type: 'object', properties: {} };
  return schema;
}

function buildToolDefs(catalog: Map<string, CatalogEntry>) {
  const defs = [...catalog.entries()].map(([name, { tool }]) => ({
    name,
    description: tool.description,
    inputSchema: toInputSchema(tool),
    annotations: {
      title: toolTitle(tool.id),
      readOnlyHint: !tool.requiresConfirmation,
      destructiveHint: Boolean(tool.requiresConfirmation),
      openWorldHint: true,
    },
  }));

  // Virtual, MCP-only tools — not in the registry.
  defs.unshift(
    {
      name: 'zipdev_overview',
      description:
        "Orient yourself in the user's Zipdev workspace: which agents exist and what they can do, which integrations the user has connected (HubSpot, Google, GitHub, Linear, Slack, …), and which Knowledge Base collections are visible. Call this early in a session.",
      inputSchema: { type: 'object', properties: {} },
      annotations: {
        title: 'Zipdev · Workspace Overview',
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    {
      name: 'zipdev_confirm_action',
      description:
        'Execute a previously proposed side-effect action AFTER the user has explicitly approved it. Pass the confirmation_id returned by the gated tool call (single-use, expires in 15 minutes). Never call this without showing the user the exact payload and receiving a clear yes.',
      inputSchema: {
        type: 'object',
        properties: {
          confirmation_id: {
            type: 'string',
            description: 'The confirmation id returned by the confirmation-gated tool call.',
          },
          confirmation_token: {
            type: 'string',
            description: 'Legacy: full token from older sessions. Prefer confirmation_id.',
          },
        },
      },
      annotations: {
        title: 'Zipdev · Confirm Action',
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
  );

  return defs;
}

// ---------------------------------------------------------------------------
// Session memory — MCP tool calls persist into `conversations`/`messages`
// (surface 'mcp', keyed by Claude's Mcp-Session-Id via external_key) so work
// done from claude.ai shows up in Zipdev OS like any other conversation.
// ---------------------------------------------------------------------------

const MAX_PERSISTED_RESULT_CHARS = 20_000;

async function getOrCreateMcpConversation(
  auth: AuthResult,
  sessionId: string,
  agentId: string,
): Promise<string | null> {
  const db = getSupabaseServiceClient();
  const externalKey = `mcp:${sessionId}`;

  const { data: existing } = await db
    .from('conversations')
    .select('id')
    .eq('user_id', auth.userId)
    .eq('external_key', externalKey)
    .maybeSingle();
  if (existing) return existing.id as string;

  const { data: created, error } = await db
    .from('conversations')
    .insert({
      user_id: auth.userId,
      agent_id: agentId,
      surface: 'mcp',
      title: `Claude · ${new Date().toISOString().slice(0, 10)}`,
      external_key: externalKey,
    })
    .select('id')
    .single();
  if (error || !created) return null;
  return created.id as string;
}

/** Best-effort: never let persistence failures break a tool call. */
async function persistToolMessage(opts: {
  conversationId: string;
  toolId: string;
  args: unknown;
  result: unknown;
  isError: boolean;
}): Promise<void> {
  try {
    let result: unknown = opts.result ?? null;
    const resultJson = JSON.stringify(result);
    if (resultJson.length > MAX_PERSISTED_RESULT_CHARS) {
      result = { __truncated: true, preview: resultJson.slice(0, MAX_PERSISTED_RESULT_CHARS) };
    }
    if (opts.isError) {
      result = { __error: true, message: result };
    }

    const db = getSupabaseServiceClient();
    const toolCallId = randomUUID();
    await db.from('messages').insert({
      conversation_id: opts.conversationId,
      role: 'assistant',
      content: '',
      tool_calls: [{ toolCallId, toolName: opts.toolId.replaceAll('.', '_'), args: opts.args }],
      tool_results: [{ toolCallId, result }],
    });
    await db
      .from('conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', opts.conversationId);
  } catch {
    // best-effort
  }
}

/** Resolve the session's conversation id, or undefined when unavailable. */
async function resolveMcpConversation(
  auth: AuthResult,
  sessionId: string | null,
  agentId: string,
): Promise<string | undefined> {
  if (!sessionId) return undefined;
  try {
    return (await getOrCreateMcpConversation(auth, sessionId, agentId)) ?? undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Virtual tool handlers
// ---------------------------------------------------------------------------

async function handleOverview(auth: AuthResult): Promise<unknown> {
  const db = getSupabaseServiceClient();
  const agents = await loadAllAgents();
  const catalog = await buildCatalog(auth.userId);

  const [integrationsRes, collectionsRes] = await Promise.all([
    db.from('integrations').select('provider, scopes').eq('user_id', auth.userId),
    db
      .from('kb_collections')
      .select('id, name, scope')
      .or(`scope.eq.global,and(scope.eq.user,scope_id.eq.${auth.userId})`),
  ]);

  return {
    workspace: 'Zipdev',
    agents: agents.map((a) => ({
      slug: a.slug,
      name: a.name,
      toolCount: filterTools(a.allowed_tool_ids ?? []).length,
    })),
    totalToolsExposed: catalog.size,
    connectedIntegrations: (integrationsRes.data ?? []).map((i) => ({
      provider: i.provider as string,
      scopes: (i.scopes as string[] | null) ?? [],
    })),
    knowledgeBase: {
      collections: (collectionsRes.data ?? []).map((c) => ({
        id: c.id as string,
        name: c.name as string,
        scope: c.scope as string,
      })),
      searchTool: 'kb_search',
    },
    confirmationProtocol:
      'Write tools return a confirmation_id instead of executing. Show the payload to the user, get explicit approval, then call zipdev_confirm_action with that id.',
  };
}

async function handleConfirmAction(
  args: Record<string, unknown>,
  auth: AuthResult,
  sessionId: string | null,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  let payload: { toolId: string; agentId: string; input: unknown } | null = null;

  const confirmationId = typeof args.confirmation_id === 'string' ? args.confirmation_id : '';
  if (confirmationId) {
    // Consume (delete + return) so the id is single-use even under retries.
    const db = getSupabaseServiceClient();
    const { data: row } = await db
      .from('mcp_pending_actions')
      .delete()
      .eq('id', confirmationId)
      .eq('user_id', auth.userId)
      .select('tool_id, agent_id, input, expires_at')
      .maybeSingle();
    if (row && new Date(row.expires_at as string).getTime() > Date.now()) {
      payload = {
        toolId: row.tool_id as string,
        agentId: row.agent_id as string,
        input: row.input,
      };
    }
  } else {
    // Legacy stateless token (pre-0033 sessions may still hold one).
    const token = typeof args.confirmation_token === 'string' ? args.confirmation_token : '';
    payload = token ? verifyConfirmationToken(token, auth.userId) : null;
  }

  if (!payload) {
    return {
      content: [
        {
          type: 'text',
          text: 'Invalid, expired, or already-used confirmation id. Re-run the original tool call to stage the action again, show the payload to the user, and confirm with the fresh id.',
        },
      ],
      isError: true,
    };
  }

  const tool = getTool(payload.toolId);
  if (!tool) {
    return {
      content: [{ type: 'text', text: `Unknown tool in token: ${payload.toolId}` }],
      isError: true,
    };
  }
  // A team may have blocked the tool after the action was staged — a denied
  // tool must never execute, even with a valid confirmation id.
  const denied = await deniedToolPatterns(getSupabaseServiceClient(), auth.userId);
  if (isToolDenied(payload.toolId, denied)) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${toMcpName(payload.toolId)}` }],
      isError: true,
    };
  }

  const conversationId = await resolveMcpConversation(auth, sessionId, payload.agentId);
  const ctx = buildToolContext({ userId: auth.userId, agentId: payload.agentId, conversationId });
  const result = await runTool(tool, payload.input, ctx, { confirmed: true });
  if (conversationId) {
    await persistToolMessage({
      conversationId,
      toolId: payload.toolId,
      args: payload.input,
      result,
      isError: false,
    });
  }
  return {
    content: [
      {
        type: 'text',
        text: `✅ Executed ${payload.toolId}.\n\n${JSON.stringify(result, null, 2)}`,
      },
    ],
  };
}

// Why each gated tool is gated — shared with the web chat's ConfirmationPrompt.
import { confirmationReason } from '@/lib/confirmation-notes';

const PENDING_ACTION_TTL_MS = 15 * 60_000;

async function confirmationRequiredResult(
  err: ConfirmationRequiredError,
  auth: AuthResult,
  agentId: string,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  // Persist the validated input server-side; the model only round-trips a
  // short single-use id. (The old HMAC token embedded the whole payload and
  // got truncated by the model on large inputs.)
  const db = getSupabaseServiceClient();
  const { data: pending, error } = await db
    .from('mcp_pending_actions')
    .insert({
      user_id: auth.userId,
      agent_id: agentId,
      tool_id: err.toolId,
      input: err.input,
      expires_at: new Date(Date.now() + PENDING_ACTION_TTL_MS).toISOString(),
    })
    .select('id')
    .single();
  if (error || !pending) {
    return {
      content: [
        { type: 'text', text: `Could not stage the action for confirmation: ${error?.message ?? 'unknown error'}` },
      ],
    };
  }
  const confirmationId = pending.id as string;
  const text = [
    `⏸️ CONFIRMATION REQUIRED — \`${toolTitle(err.toolId)}\` (\`${err.toolId}\`) was NOT executed.`,
    '',
    `WHY THIS IS GATED: ${confirmationReason(err.toolId)} Zipdev policy: nothing important happens without the user's explicit approval, and every action is audited.`,
    '',
    'BEFORE asking for approval, explain to the user in your own words (their language):',
    '1. What exactly will happen and in which system — name the recipient/target and the key values from the payload below (who, what, amounts, titles).',
    '2. Who will be able to see it, and whether it can be undone.',
    '3. Then ask ONE direct question: do you approve this exact action?',
    '',
    'Validated payload that WILL run on confirmation:',
    '```json',
    JSON.stringify(err.input, null, 2),
    '```',
    'If (and only if) the user explicitly approves, call `zipdev_confirm_action` with:',
    '```json',
    JSON.stringify({ confirmation_id: confirmationId }),
    '```',
    'The confirmation id is single-use, bound to this user, and expires in 15 minutes. If they decline or ask for changes, do NOT call it — adjust and re-propose instead.',
  ].join('\n');
  return { content: [{ type: 'text', text }] };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

interface PromptDef {
  name: string;
  description: string;
  arguments: Array<{ name: string; description: string; required: boolean }>;
  render: (args: Record<string, string>) => string;
}

const PROMPTS: PromptDef[] = [
  {
    name: 'draft-proposal',
    description: 'Draft a complete client proposal for a Zipdev candidate role.',
    arguments: [
      { name: 'role', description: 'e.g., "frontend", "fullstack"', required: true },
      { name: 'seniority', description: 'junior | mid | senior | lead', required: true },
      { name: 'companyId', description: 'Optional HubSpot company ID for context', required: false },
    ],
    render: (a) =>
      `Draft a complete Zipdev client proposal for a ${a.seniority ?? ''} ${a.role ?? ''} role.` +
      (a.companyId ? ` Pull company context from HubSpot company ${a.companyId} first.` : '') +
      ' Search the Knowledge Base (kb_search) for prior proposals and rate guidance, estimate the rate with rate_estimate, and structure the proposal with scope, profile, rate, and next steps.',
  },
  {
    name: 'qualify-lead',
    description: 'Walk through qualifying a sales lead from HubSpot data.',
    arguments: [{ name: 'dealId', description: 'HubSpot deal ID', required: true }],
    render: (a) =>
      `Qualify HubSpot deal ${a.dealId ?? ''}: fetch the deal, its company and recent activities, check the Knowledge Base for prior interactions, and give a BANT-style assessment with a clear go/no-go recommendation.`,
  },
  {
    name: 'rate-question',
    description: 'Answer a rate question by calling rate.estimate.',
    arguments: [
      { name: 'role', description: 'Role to estimate', required: true },
      { name: 'seniority', description: 'Seniority level', required: true },
      { name: 'region', description: 'Optional region', required: false },
    ],
    render: (a) =>
      `Estimate the rate for a ${a.seniority ?? ''} ${a.role ?? ''}${a.region ? ` in ${a.region}` : ''} using the rate estimation tool, and explain the drivers behind the number.`,
  },
  {
    name: 'document-repo',
    description: 'Read a GitHub repository and persist Markdown docs to the Knowledge Base.',
    arguments: [
      { name: 'repo', description: 'owner/name of the repository', required: true },
    ],
    render: (a) =>
      `Document the GitHub repository ${a.repo ?? ''}: check kb_search for existing docs first, read the repo structure and key files with the github tools, synthesize concise Markdown documentation (purpose, architecture, setup, key modules), and save it with kb_create_document.`,
  },
  {
    name: 'project-status',
    description: 'Summarize the current status of a Linear project with real metrics.',
    arguments: [
      { name: 'project', description: 'Linear project name or ID', required: true },
    ],
    render: (a) =>
      `Report the status of Linear project "${a.project ?? ''}": fetch the project, its issues by state, cycle stats, and per-person workload. Lead with a one-line health verdict, then the numbers, then risks. Cite issue ids inline.`,
  },
];

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

async function listResources(): Promise<Array<{ uri: string; name: string; mimeType: string }>> {
  const agents = await loadAllAgents();
  return [
    ...agents.map((a) => ({
      uri: `zipdev://agents/${a.slug}/system-prompt`,
      name: `${a.name} — system prompt`,
      mimeType: 'text/markdown',
    })),
    // Back-compat alias for the original single-agent resource.
    { uri: 'zipdev://agent/system-prompt', name: 'Sales agent system prompt', mimeType: 'text/markdown' },
    { uri: 'zipdev://kb/collections', name: 'Visible KB collections', mimeType: 'application/json' },
    { uri: 'zipdev://integrations/status', name: 'Connected integrations', mimeType: 'application/json' },
  ];
}

async function readResource(uri: string, auth: AuthResult): Promise<JsonRpcResponse['result'] | null> {
  const db = getSupabaseServiceClient();

  const agentMatch = /^zipdev:\/\/agents\/([a-z0-9-]+)\/system-prompt$/.exec(uri);
  if (agentMatch || uri === 'zipdev://agent/system-prompt') {
    const slug = agentMatch ? agentMatch[1]! : 'sales';
    const agents = await loadAllAgents();
    const agent = agents.find((a) => a.slug === slug);
    if (!agent) return null;
    return { contents: [{ uri, mimeType: 'text/markdown', text: agent.system_prompt }] };
  }

  if (uri === 'zipdev://kb/collections') {
    const { data: collections } = await db
      .from('kb_collections')
      .select('id, scope, scope_id, name')
      .or(`scope.eq.global,and(scope.eq.user,scope_id.eq.${auth.userId})`);
    return {
      contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(collections ?? []) }],
    };
  }

  if (uri === 'zipdev://integrations/status') {
    const { data } = await db
      .from('integrations')
      .select('provider, scopes, expires_at')
      .eq('user_id', auth.userId);
    return {
      contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(data ?? []) }],
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// JSON-RPC method dispatch
// ---------------------------------------------------------------------------
async function dispatch(
  method: string,
  params: unknown,
  id: JsonRpcId,
  auth: AuthResult,
  sessionId: string | null,
): Promise<JsonRpcResponse> {
  switch (method) {
    case 'initialize': {
      // Instructions = hardcoded persona/mechanics + the LIVE Zippy system
      // prompt from the DB: the team tunes Claude's behavior by editing the
      // agent in Zipdev OS — no deploy needed. Best-effort: initialize must
      // never fail because of this.
      let playbook = '';
      try {
        const agents = await loadAllAgents();
        const zippy = agents.find((a) => a.slug === 'zippy');
        if (zippy?.system_prompt) {
          playbook = `\n\nZIPPY'S TEAM PLAYBOOK (live from Zipdev OS — follow it):\n${zippy.system_prompt}`;
        }
      } catch {
        // DB hiccup: serve the static instructions alone.
      }
      return rpcOk(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {}, prompts: {}, resources: {} },
        instructions: INSTRUCTIONS + playbook,
        serverInfo: {
          name: SERVER_NAME,
          title: 'Zippy',
          version: SERVER_VERSION,
          websiteUrl: issuer(),
          // MCP spec ≥2025-06-18 icon metadata; harmlessly ignored by older clients.
          icons: [
            {
              src: `${issuer()}/icon.png`,
              mimeType: 'image/png',
              sizes: ['512x512'],
            },
          ],
        },
      });
    }

    case 'ping':
      return rpcOk(id, {});

    case 'tools/list': {
      const catalog = await buildCatalog(auth.userId);
      return rpcOk(id, { tools: buildToolDefs(catalog) });
    }

    case 'tools/call': {
      const p = (params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      const mcpName = p.name ?? '';
      const args = p.arguments ?? {};

      try {
        if (mcpName === 'zipdev_overview') {
          const overview = await handleOverview(auth);
          return rpcOk(id, {
            content: [{ type: 'text', text: JSON.stringify(overview, null, 2) }],
          });
        }
        if (mcpName === 'zipdev_confirm_action') {
          return rpcOk(id, await handleConfirmAction(args, auth, sessionId));
        }

        const catalog = await buildCatalog(auth.userId);
        const entry = catalog.get(mcpName);
        if (!entry) {
          return rpcOk(id, {
            content: [{ type: 'text', text: `Unknown tool: ${mcpName}` }],
            isError: true,
          });
        }

        const conversationId = await resolveMcpConversation(auth, sessionId, entry.agentId);
        const ctx = buildToolContext({ userId: auth.userId, agentId: entry.agentId, conversationId });
        try {
          const result = await runTool(entry.tool, args, ctx);
          if (conversationId) {
            await persistToolMessage({
              conversationId,
              toolId: entry.tool.id,
              args,
              result,
              isError: false,
            });
          }
          return rpcOk(id, {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          });
        } catch (err) {
          if (err instanceof ConfirmationRequiredError) {
            return rpcOk(id, await confirmationRequiredResult(err, auth, entry.agentId));
          }
          throw err;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return rpcOk(id, {
          content: [{ type: 'text', text: message.slice(0, 4000) }],
          isError: true,
        });
      }
    }

    case 'prompts/list':
      return rpcOk(id, {
        prompts: PROMPTS.map(({ name, description, arguments: promptArgs }) => ({
          name,
          description,
          arguments: promptArgs,
        })),
      });

    case 'prompts/get': {
      const p = (params ?? {}) as { name?: string; arguments?: Record<string, string> };
      const prompt = PROMPTS.find((pr) => pr.name === p.name);
      if (!prompt) return rpcErr(id, INVALID_REQUEST, `Unknown prompt: ${p.name ?? ''}`);
      const missing = prompt.arguments.filter((a) => a.required && !(p.arguments ?? {})[a.name]);
      if (missing.length > 0) {
        return rpcErr(
          id,
          INVALID_REQUEST,
          `Missing required arguments: ${missing.map((m) => m.name).join(', ')}`,
        );
      }
      return rpcOk(id, {
        description: prompt.description,
        messages: [
          {
            role: 'user',
            content: { type: 'text', text: prompt.render(p.arguments ?? {}) },
          },
        ],
      });
    }

    case 'resources/list':
      return rpcOk(id, { resources: await listResources() });

    case 'resources/read': {
      const p = (params ?? {}) as { uri?: string };
      const uri = p.uri ?? '';
      const result = await readResource(uri, auth);
      if (result === null) return rpcErr(id, INVALID_REQUEST, `Unknown resource: ${uri}`);
      return rpcOk(id, result);
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

  // Claude echoes the Mcp-Session-Id we minted at initialize; it keys the
  // session's conversation record (memory shared with the web app).
  const sessionId = req.headers.get('mcp-session-id');

  // Dispatch every request. Notifications mixed into a batch are simply ignored
  // here (no response emitted for them).
  const responses: JsonRpcResponse[] = [];
  for (const r of requests) {
    const reqId = r.id ?? null;
    try {
      responses.push(await dispatch(r.method, r.params, reqId, auth, sessionId));
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
