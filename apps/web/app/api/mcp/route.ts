import { randomUUID } from 'node:crypto';
import { buildToolContext } from '@/lib/agent';
import { sendApprovalRequestEmail } from '@/lib/approval-email';
import { decideApproval } from '@/lib/approvals/decide';
import { mintConfirmationToken, verifyConfirmationToken } from '@/lib/mcp-confirm';
import { issuer, sha256 } from '@/lib/oauth';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { buildSystemPrompt } from '@/lib/system-prompt';
import { deniedToolPatterns, isToolDenied } from '@/lib/tool-access';
import {
  type AnyTool,
  filterTools,
  getTool,
  listVisibleSpaces,
  runTool,
} from '@cortex/agent-tools';
import { ConfirmationRequiredError } from '@cortex/core';
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
 * Tool surface: the UNION of every non-archived agent's allowed tools (in
 * practice just `cortex`) loaded from the `agents` table, executed through the exact same
 * path as the chat route — filterTools -> runTool with a ToolContext from
 * buildToolContext(). Each tool is attributed to the first agent that allows
 * it so audit events keep a real agent_id.
 *
 * Confirmation-gated tools (requiresConfirmation) cannot pop a UI over MCP.
 * Instead, an unconfirmed call returns a signed confirmation token (see
 * lib/mcp-confirm.ts) plus instructions; after the user explicitly approves,
 * Claude calls the virtual `cortex_confirm_action` tool with that token and
 * the action executes with { confirmed: true } — same contract as
 * /api/chat/confirm on the web.
 *
 * We hand-roll JSON-RPC rather than use the MCP SDK server transport (that
 * transport is Node-stream based and awkward inside a Next.js route handler).
 */
import { type NextRequest, NextResponse } from 'next/server';
import { zodToJsonSchema } from 'zod-to-json-schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** The MCP protocol version we implement / advertise. */
const PROTOCOL_VERSION = '2025-03-26';
const SERVER_NAME = 'cortex-agent';
const SERVER_VERSION = '0.2.0';

/**
 * Served on `initialize` — this is the closest MCP gets to a system prompt,
 * and it is what makes Claude behave like the workspace's own agent instead of
 * a generic assistant with tools.
 */
const INSTRUCTIONS = `While these tools are active you take on the role of **Cortex** ⚡ — the workspace super-agent and newest teammate on the team. This server is Cortex's brain and hands: the company's Brain Knowledge, CRM, mailbox and calendar, payroll figures, pipelines, and routines. It does NOT reach a rate estimator, an applicant tracking system, a talent pool, or the HR system of record — if someone asks for a rate, a shortlist, a headcount or a bill rate, say plainly that it is not something you can look up rather than improvising one.

YOUR PERSONA (in effect whenever you do work for the company in this conversation):
- You are Cortex, a teammate — not a generic assistant. When greeting or starting work, introduce yourself as Cortex. Speak in first person about the work: "ya revisé el CRM", "te preparo el borrador".
- Personality: sharp, warm, direct. Numbers over adjectives. Lead with the answer, then the support. A touch of energy (an occasional ⚡ is fine, never more than one per message).
- Match the user's language — Spanish in, Spanish out. Client-facing drafts go in the client's language.
- If someone asks what you literally are, be honest (Claude acting as Cortex, the workspace's agent) — never deceptive, but don't volunteer the machinery.

HOW CORTEX SPEAKS (users are often non-technical):
- Never mention tool names, function calls, ids/UUIDs, or jargon ("fire-and-forget", "sync status"). Describe actions in plain human terms and refer to things by name.
- For slow operations, set expectations and drive the follow-up yourself ("dame dos minutos — ¿quieres que revise ya?"). Never tell the user to run something; running tools is your job.
- One question at a time. Short sentences. The mechanics stay invisible.

HOW CORTEX WORKS:
1. **Orient first.** Call \`cortex_overview\` early to see connected integrations, agents, and Brain Knowledge spaces.
2. **Brain Knowledge is the company's memory.** Before answering anything that could be covered by internal knowledge — clients, playbooks, pricing, past proposals — search it with \`kb_search\` and ground your answer in the hits. It is also the only place a rate can come from now, and quoting one means quoting the document it came from. Persist durable work products back with \`kb_create_document\`.
3. **Ground every claim in tool data.** Never invent a deal, contact, rate, or statistic. Fetch it this turn; cite human-verifiable references (deal names, \`ENG-45\`, \`owner/repo#123\`).
4. **Writes are confirmation-gated.** Create/update/send/post tools do NOT execute on first call — they return a confirmation_id, the exact payload, and WHY the action is gated. Explain that in the user's language, show what will happen, get an explicit yes, then call \`cortex_confirm_action\`. If the user declines, do nothing.
5. **Offload heavy reading.** For large documents, delegate with \`cortex_process\` instead of pulling the content into the conversation.`;

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
  return new NextResponse(JSON.stringify(rpcErr(null, INVALID_REQUEST, 'Unauthorized')), {
    status: 401,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
      'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl()}", scope="read write"`,
    },
  });
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
  // Cortex first: shared tools attribute to the super-agent (audit trail and
  // MCP conversations read as Cortex's work, matching the product story).
  const ordered = [...agents].sort((a, b) =>
    a.slug === 'cortex' ? -1 : b.slug === 'cortex' ? 1 : a.slug.localeCompare(b.slug),
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
  kb: 'Brain Knowledge',
  gmail: 'Gmail',
  gcal: 'Google Calendar',
  gsheets: 'Google Sheets',
  gdrive: 'Google Drive',
  github: 'GitHub',
  linear: 'Linear',
  web: 'Web',
  slack: 'Slack',
  people: 'People',
  presentations: 'Presentations',
  growth: 'Growth Signals',
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
      name: 'cortex_overview',
      description:
        "Orient yourself in the user's workspace: which agents exist and what they can do, which integrations the user has connected (HubSpot, Google, GitHub, Linear, Slack, …), and which Brain Knowledge spaces are visible. Call this early in a session.",
      inputSchema: { type: 'object', properties: {} },
      annotations: {
        title: 'Cortex · Workspace Overview',
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    {
      name: 'cortex_confirm_action',
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
        title: 'Cortex · Confirm Action',
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
// done from claude.ai shows up in Cortex like any other conversation.
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

  const [integrationsRes, spaces] = await Promise.all([
    db.from('integrations').select('provider, scopes').eq('user_id', auth.userId),
    // Shared helper rather than an inline filter: the overview must describe
    // exactly the spaces kb_search would actually reach.
    listVisibleSpaces(db, auth.userId),
  ]);

  return {
    workspace: 'Cortex',
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
      spaces: spaces.map((s) => ({ id: s.id, name: s.name, kind: s.kind })),
      searchTool: 'kb_search',
    },
    confirmationProtocol:
      'Write tools return a confirmation_id instead of executing. Show the payload to the user, get explicit approval, then call cortex_confirm_action with that id.',
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
    // The SAME claim the /approvals page and the Google Chat buttons use — one
    // atomic conditional update, so an id already answered in Chat cannot be
    // spent again here, and a retry cannot execute the action twice.
    const claim = await decideApproval({
      approvalId: confirmationId,
      userId: auth.userId,
      decision: 'approved',
      via: 'mcp',
    });
    if (claim.status === 'claimed') {
      payload = {
        toolId: claim.action.toolId,
        agentId: claim.action.agentId,
        input: claim.action.input,
      };
    } else if (claim.status === 'already_decided') {
      // Worth being specific: the model must not "try again", it must tell the
      // person the decision was already made somewhere else.
      return {
        content: [
          {
            type: 'text',
            text: `That request was already ${claim.decision} by the user${
              claim.decidedVia === 'google_chat' ? ' in Google Chat' : ''
            }. Do NOT re-stage or retry it — tell them it is already handled.`,
          },
        ],
        isError: true,
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
  const expiresAt = new Date(Date.now() + PENDING_ACTION_TTL_MS);
  const { data: pending, error } = await db
    .from('mcp_pending_actions')
    .insert({
      user_id: auth.userId,
      agent_id: agentId,
      tool_id: err.toolId,
      input: err.input,
      expires_at: expiresAt.toISOString(),
    })
    .select('id')
    .single();
  if (error || !pending) {
    return {
      content: [
        {
          type: 'text',
          text: `Could not stage the action for confirmation: ${error?.message ?? 'unknown error'}`,
        },
      ],
    };
  }
  const confirmationId = pending.id as string;

  // The request may land while nobody is watching this conversation, so it also
  // goes out by email and — carrying this id — as an Approve/Decline card in
  // Google Chat. Fire-and-forget: the tool response must not wait on (or fail
  // because of) either delivery.
  void sendApprovalRequestEmail({
    userId: auth.userId,
    toolId: err.toolId,
    input: err.input,
    surface: 'mcp',
    pendingActionId: confirmationId,
    expiresAt,
  });

  const text = [
    `⏸️ CONFIRMATION REQUIRED — \`${toolTitle(err.toolId)}\` (\`${err.toolId}\`) was NOT executed.`,
    '',
    `WHY THIS IS GATED: ${confirmationReason(err.toolId)} Company policy: nothing important happens without the user's explicit approval, and every action is audited.`,
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
    'If (and only if) the user explicitly approves, call `cortex_confirm_action` with:',
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
    description: 'Draft a complete client proposal for a candidate role.',
    arguments: [
      { name: 'role', description: 'e.g., "frontend", "fullstack"', required: true },
      { name: 'seniority', description: 'junior | mid | senior | lead', required: true },
      {
        name: 'companyId',
        description: 'Optional HubSpot company ID for context',
        required: false,
      },
    ],
    render: (a) =>
      `Draft a complete client proposal for a ${a.seniority ?? ''} ${a.role ?? ''} role.` +
      (a.companyId ? ` Pull company context from HubSpot company ${a.companyId} first.` : '') +
      ' Search Brain Knowledge (kb_search) for prior proposals and rate guidance, and structure the proposal with scope, profile, rate and next steps. There is no rate estimator: take the numbers from a comparable past proposal and say which one, or leave them for the user to fill in.',
  },
  {
    name: 'qualify-lead',
    description: 'Walk through qualifying a sales lead from HubSpot data.',
    arguments: [{ name: 'dealId', description: 'HubSpot deal ID', required: true }],
    render: (a) =>
      `Qualify HubSpot deal ${a.dealId ?? ''}: fetch the deal, its company and recent activities, check Brain Knowledge for prior interactions, and give a BANT-style assessment with a clear go/no-go recommendation.`,
  },
  {
    name: 'document-repo',
    description: 'Read a GitHub repository and persist Markdown docs to Brain Knowledge.',
    arguments: [{ name: 'repo', description: 'owner/name of the repository', required: true }],
    render: (a) =>
      `Document the GitHub repository ${a.repo ?? ''}: check kb_search for existing docs first, read the repo structure and key files with the github tools, synthesize concise Markdown documentation (purpose, architecture, setup, key modules), and save it with kb_create_document.`,
  },
  {
    name: 'project-status',
    description: 'Summarize the current status of a Linear project with real metrics.',
    arguments: [{ name: 'project', description: 'Linear project name or ID', required: true }],
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
      uri: `cortex://agents/${a.slug}/system-prompt`,
      name: `${a.name} — system prompt`,
      mimeType: 'text/markdown',
    })),
    // Back-compat alias for the original single-agent resource.
    {
      uri: 'cortex://agent/system-prompt',
      name: 'Sales agent system prompt',
      mimeType: 'text/markdown',
    },
    {
      uri: 'cortex://kb/spaces',
      name: 'Brain Knowledge spaces you can see',
      mimeType: 'application/json',
    },
    {
      uri: 'cortex://integrations/status',
      name: 'Connected integrations',
      mimeType: 'application/json',
    },
  ];
}

async function readResource(
  uri: string,
  auth: AuthResult,
): Promise<JsonRpcResponse['result'] | null> {
  const db = getSupabaseServiceClient();

  const agentMatch = /^cortex:\/\/agents\/([a-z0-9-]+)\/system-prompt$/.exec(uri);
  if (agentMatch || uri === 'cortex://agent/system-prompt') {
    const slug = agentMatch ? agentMatch[1]! : 'sales';
    const agents = await loadAllAgents();
    const agent = agents.find((a) => a.slug === slug);
    if (!agent) return null;
    return { contents: [{ uri, mimeType: 'text/markdown', text: agent.system_prompt }] };
  }

  if (uri === 'cortex://kb/spaces') {
    const spaces = await listVisibleSpaces(db, auth.userId);
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(spaces.map((s) => ({ id: s.id, name: s.name, kind: s.kind }))),
        },
      ],
    };
  }

  if (uri === 'cortex://integrations/status') {
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
      // Instructions = hardcoded persona/mechanics + the LIVE Cortex system
      // prompt from the DB: the team tunes Claude's behavior by editing the
      // agent in Cortex — no deploy needed. Best-effort: initialize must
      // never fail because of this.
      let playbook = '';
      try {
        const agents = await loadAllAgents();
        const cortex = agents.find((a) => a.slug === 'cortex');
        if (cortex?.system_prompt) {
          playbook = `\n\nCORTEX'S TEAM PLAYBOOK (live from Cortex — follow it):\n${cortex.system_prompt}`;
        }
      } catch {
        // DB hiccup: serve the static instructions alone.
      }

      // `instructions` is as close as MCP gets to a system prompt, so it is
      // where this surface's memories go — through the same builder the web
      // chat and Google Chat use. Unlike those two it is composed once per
      // session rather than per turn, which is a staleness the person controls:
      // a memory added mid-session takes effect on the next reconnect.
      // Audience is 'private': an MCP session is one person's client.
      let instructions = INSTRUCTIONS + playbook;
      try {
        instructions = (
          await buildSystemPrompt({
            userId: auth.userId,
            basePrompt: instructions,
          })
        ).system;
      } catch {
        // Same posture as the playbook above: never fail initialize over this.
      }

      return rpcOk(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {}, prompts: {}, resources: {} },
        instructions,
        serverInfo: {
          name: SERVER_NAME,
          title: 'Cortex',
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
        if (mcpName === 'cortex_overview') {
          const overview = await handleOverview(auth);
          return rpcOk(id, {
            content: [{ type: 'text', text: JSON.stringify(overview, null, 2) }],
          });
        }
        if (mcpName === 'cortex_confirm_action') {
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
        const ctx = buildToolContext({
          userId: auth.userId,
          agentId: entry.agentId,
          conversationId,
        });
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
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
      Allow: 'POST, DELETE, OPTIONS',
    },
  });
}

// DELETE: session teardown. We keep no server-side session state (the
// Mcp-Session-Id is informational), so we simply acknowledge.
export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const auth = await authenticate(req);
  if (!auth) return unauthorized();
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
