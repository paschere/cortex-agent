/**
 * external-mcp: proxy layer for per-user external (dynamic) MCP servers.
 *
 * Users register external MCP servers (rows in user_mcp_servers). This module:
 *   - fetches a server's tool manifest over the MCP SSE transport,
 *   - proxies individual tool calls,
 *   - caches manifests in user_mcp_tools and refreshes them lazily.
 *
 * Transport notes:
 *   The MCP SSE protocol works as: GET the server URL to open an
 *   `text/event-stream`; the server's first event is named `endpoint` and its
 *   data is the URL to POST JSON-RPC requests to. Responses to those POSTs are
 *   delivered back on the open SSE stream as `message` events. This is the same
 *   protocol implemented on the server side in apps/mcp/src/sse.ts.
 *
 *   We implement the client manually (raw fetch + stream reader) rather than
 *   using @modelcontextprotocol/sdk's SSEClientTransport because that depends on
 *   the EventSource global, which is unavailable in the Cloudflare Workers and
 *   edge runtimes this code must run in.
 *
 * SSRF: every outbound call is gated by isPrivateUrl(). The Node chat route
 * additionally performs DNS resolution checks (see the spec's
 * assertNotPrivateResolved) before invoking callExternalTool.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { decryptToken, logger } from '@cortex/core';
import { consumeToken } from './rate-limit';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExternalToolManifestEntry {
  tool_name: string;
  tool_description: string;
  input_schema_json: object;
}

export interface ExternalServerRow {
  id: string;
  url: string;
  auth_type: string;
  auth_value_encrypted: string | null;
}

export interface EnabledExternalServer {
  server: Record<string, unknown> & { id: string; url: string; auth_type: string };
  tools: Array<{
    tool_name: string;
    tool_description: string | null;
    input_schema_json: unknown;
  }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MANIFEST_GET_TIMEOUT_MS = 5_000;
const CALL_TIMEOUT_MS = 10_000;
const SYNC_TOTAL_TIMEOUT_MS = 5_000;
const MANIFEST_STALE_MS = 60 * 60 * 1_000; // 1 hour
const MAX_TOOLS_PER_USER = 50;

const TOOL_NAME_MAX = 64;
const TOOL_DESC_MAX = 1000;

const NULL_BYTE = String.fromCharCode(0);

/** Strip null bytes (U+0000) which break Postgres text columns and JSON parsing. */
function stripNullBytes(s: string): string {
  return s.split(NULL_BYTE).join('');
}

// ---------------------------------------------------------------------------
// 1. SSRF guard
// ---------------------------------------------------------------------------

const PRIVATE_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./, // AWS/GCP metadata
  /^::1$/,
  /^fd[0-9a-f]{2}:/i, // IPv6 ULA
  /^fe80:/i, // IPv6 link-local
];

/**
 * Returns true if the URL points at a private / loopback / link-local host or
 * uses a non-http(s) protocol, embeds credentials, or is malformed. Callers
 * should treat `true` as "block this request".
 */
export function isPrivateUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return true; // malformed = block
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return true;
  if (parsed.username || parsed.password) return true; // credentials in URL
  // hostname may be bracketed for IPv6 (e.g. [::1]); strip brackets for matching.
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  return PRIVATE_PATTERNS.some((p) => p.test(host));
}

/**
 * Stronger SSRF guard: the string check above blocks IP literals, but a
 * hostname like `evil.com` can resolve to 127.0.0.1 or 169.254.169.254
 * (DNS rebinding) and pass it. This additionally resolves the hostname and
 * rejects it if ANY resolved address is private.
 *
 * DNS resolution is Node-only; in the Cloudflare Worker runtime `node:dns` is
 * unavailable, so we fall back to the string check + the platform's own egress
 * filtering. Throws an Error starting with "Blocked" when the host is unsafe.
 */
export async function assertPublicHost(rawUrl: string): Promise<void> {
  if (isPrivateUrl(rawUrl)) {
    throw new Error(`Blocked: ${rawUrl} is a private, loopback, or malformed URL`);
  }
  const host = new URL(rawUrl).hostname.replace(/^\[|\]$/g, '');
  // If the host is already an IP literal, isPrivateUrl covered it.
  if (/^[0-9.]+$/.test(host) || host.includes(':')) return;
  try {
    const dns = await import('node:dns/promises');
    const records = await dns.lookup(host, { all: true });
    for (const r of records) {
      const probe = r.address.includes(':') ? `http://[${r.address}]` : `http://${r.address}`;
      if (isPrivateUrl(probe)) {
        throw new Error(`Blocked: ${host} resolves to private IP ${r.address}`);
      }
    }
  } catch (err) {
    // Re-throw our own block; swallow "dns unavailable" (Workers) and let the
    // real fetch surface genuine resolution failures (ENOTFOUND, etc.).
    if (err instanceof Error && err.message.startsWith('Blocked')) throw err;
  }
}

// ---------------------------------------------------------------------------
// Low-level MCP SSE client
// ---------------------------------------------------------------------------

interface SseConnection {
  /** Absolute URL to POST JSON-RPC requests to (from the `endpoint` event). */
  messagesUrl: string;
  /** Pull the next decoded SSE event from the open stream. */
  next: () => Promise<{ event: string; data: string } | null>;
  /** Close the underlying reader. */
  close: () => Promise<void>;
}

function authHeaders(authType: string, authValue: string | null): Record<string, string> {
  if (!authValue) return {};
  if (authType === 'bearer') return { Authorization: `Bearer ${authValue}` };
  if (authType === 'api_key') return { 'X-API-Key': authValue };
  return {};
}

/**
 * Open the SSE stream and resolve the `endpoint` (messages) URL. Returns a
 * connection with an async iterator over subsequent events.
 */
async function openSseStream(
  serverUrl: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<SseConnection> {
  const res = await fetch(serverUrl, {
    method: 'GET',
    headers: { ...headers, Accept: 'text/event-stream' },
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`MCP SSE GET ${serverUrl} failed: ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  /** Parse one SSE frame (text between blank lines) into {event, data}. */
  function parseFrame(frame: string): { event: string; data: string } {
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) {
        event = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).replace(/^ /, ''));
      }
    }
    return { event, data: dataLines.join('\n') };
  }

  async function next(): Promise<{ event: string; data: string } | null> {
    // Emit any complete frame already buffered.
    for (;;) {
      const idx = buffer.indexOf('\n\n');
      if (idx !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (frame.trim()) return parseFrame(frame);
        continue;
      }
      const { value, done } = await reader.read();
      if (done) {
        const rest = buffer.trim();
        buffer = '';
        return rest ? parseFrame(rest) : null;
      }
      buffer += decoder.decode(value, { stream: true });
    }
  }

  async function close(): Promise<void> {
    try {
      await reader.cancel();
    } catch {
      // already closed
    }
  }

  // First event must be `endpoint` carrying the messages URL.
  const first = await next();
  if (!first || first.event !== 'endpoint' || !first.data) {
    await close();
    throw new Error(`MCP SSE handshake failed: expected 'endpoint' event, got '${first?.event}'`);
  }
  // The endpoint data may be a relative URL; resolve against the server URL.
  const messagesUrl = new URL(first.data, serverUrl).toString();

  return { messagesUrl, next, close };
}

/**
 * Post a JSON-RPC request to the messages URL and read its response off the SSE
 * stream (matching on the request id). Returns the JSON-RPC `result`.
 */
async function rpcOverSse(
  conn: SseConnection,
  messagesHeaders: Record<string, string>,
  method: string,
  params: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const id = crypto.randomUUID();
  const post = await fetch(conn.messagesUrl, {
    method: 'POST',
    headers: { ...messagesHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }),
    signal,
  });
  // 202 (async, reply on stream) and 200 (inline body) are both valid.
  if (!post.ok) {
    throw new Error(`MCP POST ${method} failed: ${post.status}`);
  }

  // Some servers return the JSON-RPC response inline in the POST body.
  const contentType = post.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const inline = (await post.json()) as { result?: unknown; error?: { message?: string } };
    if (inline && (inline.result !== undefined || inline.error !== undefined)) {
      if (inline.error) throw new Error(`MCP ${method} error: ${inline.error.message ?? 'unknown'}`);
      return inline.result;
    }
  }

  // Otherwise read events off the stream until we see our id.
  for (;;) {
    const evt = await conn.next();
    if (!evt) throw new Error(`MCP ${method}: stream closed before response`);
    if (evt.event !== 'message' || !evt.data) continue;
    let msg: { id?: string; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(evt.data);
    } catch {
      continue;
    }
    if (msg.id !== id) continue;
    if (msg.error) throw new Error(`MCP ${method} error: ${msg.error.message ?? 'unknown'}`);
    return msg.result;
  }
}

/**
 * Fire a JSON-RPC notification (no id, no response expected) to the messages
 * endpoint. Used for `notifications/initialized`.
 */
async function notifyOverSse(
  conn: SseConnection,
  messagesHeaders: Record<string, string>,
  method: string,
  signal: AbortSignal,
): Promise<void> {
  await fetch(conn.messagesUrl, {
    method: 'POST',
    headers: { ...messagesHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params: {} }),
    signal,
  }).catch(() => {
    // notifications are best-effort
  });
}

/**
 * Perform the mandatory MCP initialization handshake: `initialize` request
 * (request→result) followed by the `notifications/initialized` notification.
 * Spec-compliant servers (including the SDK `Server` used in apps/mcp) reject
 * `tools/list` / `tools/call` before this completes.
 */
async function mcpHandshake(
  conn: SseConnection,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<void> {
  await rpcOverSse(conn, headers, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'cortex-agent-external-mcp', version: '1.0.0' },
  }, signal);
  await notifyOverSse(conn, headers, 'notifications/initialized', signal);
}

// ---------------------------------------------------------------------------
// 2. fetchExternalToolManifest
// ---------------------------------------------------------------------------

/**
 * Connect to an external MCP server and return its sanitized tool list.
 * Tool names are capped at 64 chars, descriptions at 1000 chars, and null
 * bytes are stripped from both.
 */
export async function fetchExternalToolManifest(
  serverUrl: string,
  authType: string,
  authValueDecrypted: string | null,
): Promise<ExternalToolManifestEntry[]> {
  await assertPublicHost(serverUrl); // string + DNS-resolution SSRF guard

  const signal = AbortSignal.timeout(MANIFEST_GET_TIMEOUT_MS);
  const headers = authHeaders(authType, authValueDecrypted);

  const conn = await openSseStream(serverUrl, headers, signal);
  try {
    await mcpHandshake(conn, headers, signal);
    const result = (await rpcOverSse(conn, headers, 'tools/list', {}, signal)) as {
      tools?: Array<{ name?: unknown; description?: unknown; inputSchema?: unknown }>;
    };
    const tools = Array.isArray(result?.tools) ? result.tools : [];

    const out: ExternalToolManifestEntry[] = [];
    for (const t of tools) {
      const rawName = typeof t.name === 'string' ? t.name : '';
      if (!rawName) continue;
      const tool_name = stripNullBytes(rawName).slice(0, TOOL_NAME_MAX);
      const rawDesc = typeof t.description === 'string' ? t.description : '';
      const tool_description = stripNullBytes(rawDesc).slice(0, TOOL_DESC_MAX);
      const input_schema_json =
        t.inputSchema && typeof t.inputSchema === 'object'
          ? (t.inputSchema as object)
          : { type: 'object', properties: {} };
      out.push({ tool_name, tool_description, input_schema_json });
    }
    return out;
  } finally {
    await conn.close();
  }
}

// ---------------------------------------------------------------------------
// 3. callExternalTool
// ---------------------------------------------------------------------------

/**
 * Proxy a single tool call to an external MCP server. Decrypts the stored auth
 * value, re-checks the URL for SSRF, opens an SSE session, calls tools/call,
 * and returns the JSON-RPC result.
 */
export async function callExternalTool(
  server: ExternalServerRow,
  toolName: string,
  args: unknown,
  ctx: { userId: string; db: SupabaseClient; signal?: AbortSignal },
): Promise<unknown> {
  await assertPublicHost(server.url); // string + DNS-resolution SSRF guard

  // Rate limit external proxy calls per (user, server).
  await consumeToken(ctx.db, ctx.userId, `mcp_proxy:${server.id}`, 30);

  const authValue = server.auth_value_encrypted ? decryptToken(server.auth_value_encrypted) : null;
  const headers = authHeaders(server.auth_type, authValue);

  // Combine the caller's abort signal with our own 10s timeout.
  const timeoutSignal = AbortSignal.timeout(CALL_TIMEOUT_MS);
  const signal = ctx.signal ? anySignal([ctx.signal, timeoutSignal]) : timeoutSignal;

  const conn = await openSseStream(server.url, headers, signal);
  try {
    await mcpHandshake(conn, headers, signal);
    return await rpcOverSse(
      conn,
      headers,
      'tools/call',
      { name: toolName, arguments: args ?? {} },
      signal,
    );
  } finally {
    await conn.close();
  }
}

/** Merge multiple AbortSignals into one that aborts when any input aborts. */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}

// ---------------------------------------------------------------------------
// 4. fetchEnabledExternalTools
// ---------------------------------------------------------------------------

/**
 * Return all enabled external servers for a user together with their cached
 * tools. If a server's manifest is older than 1 hour, fire a non-blocking
 * background re-sync and return the cached data immediately.
 */
export async function fetchEnabledExternalTools(
  db: SupabaseClient,
  userId: string,
): Promise<EnabledExternalServer[]> {
  const { data, error } = await db
    .from('user_mcp_servers')
    .select('*, user_mcp_tools(tool_name, tool_description, input_schema_json)')
    .eq('user_id', userId)
    .eq('enabled', true);

  if (error) {
    logger.warn({ err: error, userId }, 'fetchEnabledExternalTools: query failed');
    return [];
  }

  const rows = (data ?? []) as Array<
    Record<string, unknown> & {
      id: string;
      url: string;
      auth_type: string;
      last_checked_at: string | null;
      user_mcp_tools?: EnabledExternalServer['tools'];
    }
  >;

  const now = Date.now();
  const out: EnabledExternalServer[] = [];

  for (const row of rows) {
    const { user_mcp_tools, ...server } = row;
    out.push({ server, tools: user_mcp_tools ?? [] });

    const lastChecked = row.last_checked_at ? new Date(row.last_checked_at).getTime() : 0;
    if (now - lastChecked > MANIFEST_STALE_MS) {
      // Fire-and-forget: never block the chat request on a manifest refresh.
      void syncExternalServerManifest(db, userId, row.id).catch((err) => {
        logger.warn({ err, serverId: row.id }, 'background manifest sync failed');
      });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// 5. syncExternalServerManifest
// ---------------------------------------------------------------------------

/**
 * Refresh one server's cached tool manifest. Hard 5s total budget. On success
 * replaces the cached tool rows and updates tool_count + last_checked_at. On
 * any failure writes last_error and never throws (it is called fire-and-forget).
 */
export async function syncExternalServerManifest(
  db: SupabaseClient,
  userId: string,
  serverId: string,
): Promise<void> {
  const deadline = Date.now() + SYNC_TOTAL_TIMEOUT_MS;
  try {
    const { data: server, error: serverErr } = await db
      .from('user_mcp_servers')
      .select('id, url, auth_type, auth_value_encrypted')
      .eq('id', serverId)
      .eq('user_id', userId)
      .single();

    if (serverErr || !server) {
      throw new Error(serverErr?.message ?? 'server not found');
    }

    const row = server as ExternalServerRow;
    const authValue = row.auth_value_encrypted ? decryptToken(row.auth_value_encrypted) : null;

    if (Date.now() >= deadline) throw new Error('sync timed out before fetch');

    let manifest = await fetchExternalToolManifest(row.url, row.auth_type, authValue);

    // Enforce the 50-tool cap across all of the user's servers: count tools
    // cached on OTHER servers, then allow this server only the remaining budget.
    const { data: serverIdRows } = await db
      .from('user_mcp_servers')
      .select('id')
      .eq('user_id', userId);
    const otherIds = (serverIdRows ?? [])
      .map((s: { id: string }) => s.id)
      .filter((id: string) => id !== serverId);

    let otherCount = 0;
    if (otherIds.length > 0) {
      const { count } = await db
        .from('user_mcp_tools')
        .select('tool_name', { count: 'exact', head: true })
        .in('server_id', otherIds);
      otherCount = count ?? 0;
    }

    const remaining = Math.max(0, MAX_TOOLS_PER_USER - otherCount);
    if (manifest.length > remaining) {
      manifest = manifest.slice(0, remaining);
    }

    // Replace cached tools: delete old rows, insert the fresh batch.
    await db.from('user_mcp_tools').delete().eq('server_id', serverId);

    if (manifest.length > 0) {
      const toolRows = manifest.map((t) => ({
        server_id: serverId,
        tool_name: t.tool_name,
        tool_description: t.tool_description || null,
        input_schema_json: t.input_schema_json,
      }));
      const { error: insertErr } = await db.from('user_mcp_tools').insert(toolRows);
      if (insertErr) throw new Error(insertErr.message);
    }

    await db
      .from('user_mcp_servers')
      .update({
        tool_count: manifest.length,
        last_checked_at: new Date().toISOString(),
        last_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', serverId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err, serverId, userId }, 'syncExternalServerManifest failed');
    try {
      await db
        .from('user_mcp_servers')
        .update({
          last_error: stripNullBytes(message).slice(0, 1000),
          last_checked_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', serverId);
    } catch {
      // swallow — never throw from a fire-and-forget sync
    }
  }
}
