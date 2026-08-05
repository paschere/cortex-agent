import {
  type ExternalServerRow,
  type ToolContext,
  type AnyTool,
  callExternalTool,
  createIntegrationsClient,
  createOrgScopedClient,
  customToolDef,
  fetchEnabledCustomTools,
  fetchEnabledExternalTools,
  getTool,
  runTool,
  toolIdAllowed,
} from '@cortex/agent-tools';
import { getAgentTools, loadAgent } from '@cortex/agents';
import { ConfirmationRequiredError, logger } from '@cortex/core';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
// Side-effect import: register all built-in tools
import '@cortex/agent-tools';
import type { Env } from './index';

export interface BridgeContext {
  env: Env;
  /** The workspace the bearer token belongs to. Set by bearerAuth. */
  organizationId: string;
  userId: string;
  agentId: string | null;
}

export async function listToolsForAuth(ctx: BridgeContext) {
  // Set env vars on process.env so getEnv()/integrations refresh works
  hydrateProcessEnv(ctx.env);
  const sb = makeServiceClient(ctx.env, ctx.organizationId);
  const slug = await resolveAgentSlug(sb, ctx.agentId);
  const agent = await loadAgent(sb, slug);
  const [customs, externals] = await Promise.all([
    workspaceCustomTools(sb, agent.allowedTools),
    fetchEnabledExternalTools(sb, ctx.userId),
  ]);
  // Custom tools travel WITH the built-ins rather than beside them: by this
  // point a `custom_tools` row is an ordinary ToolDef, and every consumer of
  // this list (tools/list, /mcp/tools) only reads id, description and
  // inputSchema. Keeping them in one list is also what keeps `callTool` below
  // from needing a third branch.
  return { builtins: [...getAgentTools(agent), ...customs], externals };
}

/**
 * The workspace's own tools, gated by the agent's grant exactly as the registry
 * ones are.
 *
 * A note on where these can actually run: the request they issue goes out
 * through `node:http` so the connection can be pinned to the address the SSRF
 * guard approved (see custom-tools/http.ts). Under the Workers runtime that
 * this app deploys to, that may be unavailable — in which case the call returns
 * a plain sentence saying so, rather than throwing. Advertising them here is
 * still right: the tool exists, and a person asking through Claude should be
 * told where to ask instead, not told the capability does not exist.
 */
async function workspaceCustomTools(sb: SupabaseClient, allowedTools: string[]): Promise<AnyTool[]> {
  try {
    const rows = await fetchEnabledCustomTools(sb);
    return rows
      .map((row) => customToolDef(row) as unknown as AnyTool)
      .filter((t) => toolIdAllowed(allowedTools, t.id));
  } catch {
    // Never let a workspace's own tools break the whole tool list.
    return [];
  }
}

/**
 * MCP-safe name for an external (dynamic) MCP tool. Must be byte-identical
 * everywhere (advertised in tools/list AND looked up in tools/call) or calls
 * silently fail with "Unknown tool". Capped at 64 chars.
 */
export function externalSdkName(serverId: string, toolName: string): string {
  return ('mcp_' + serverId.replace(/-/g, '').slice(0, 16) + '_' + toolName).slice(0, 64);
}

export async function callTool(
  ctx: BridgeContext,
  toolName: string,
  input: unknown,
  opts: { confirmed?: boolean } = {},
): Promise<
  | { ok: true; result: unknown }
  | { ok: false; confirmationRequired: { toolId: string; input: unknown } }
  | { ok: false; error: string }
> {
  hydrateProcessEnv(ctx.env);
  const sb = makeServiceClient(ctx.env, ctx.organizationId);
  const integrations = createIntegrationsClient(sb, ctx.userId, logger);
  const slug = await resolveAgentSlug(sb, ctx.agentId);
  const agent = await loadAgent(sb, slug);

  // Map MCP-safe built-in names back to dotted tool IDs. Tool IDs are
  // "namespace.verb_noun"; the MCP name replaces every dot with an underscore.
  const customs = await workspaceCustomTools(sb, agent.allowedTools);
  const builtins = [...getAgentTools(agent), ...customs];
  const byMcpName = new Map(builtins.map((t) => [t.id.replaceAll('.', '_'), t]));

  const resolved = byMcpName.get(toolName);
  if (resolved) {
    // A custom tool is not in the global registry — it belongs to one
    // workspace and was constructed a few lines ago — so the ToolDef we already
    // hold IS the tool. Registry ids are still looked up by id so a stale
    // agent grant naming a removed family fails loudly.
    const tool = resolved.id.startsWith('custom.') ? resolved : getTool(resolved.id);
    if (!tool) return { ok: false, error: `Tool ${resolved.id} not registered` };

    const toolCtx: ToolContext = {
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      surface: 'mcp',
      agentId: agent.id,
      db: sb,
      integrations,
      logger,
    };

    try {
      const result = await runTool(tool, input, toolCtx, opts);
      return { ok: true, result };
    } catch (err) {
      if (err instanceof ConfirmationRequiredError) {
        return {
          ok: false,
          confirmationRequired: { toolId: err.toolId, input: err.input },
        };
      }
      return { ok: false, error: (err as Error).message };
    }
  }

  if (toolName.startsWith('mcp_')) {
    // External (dynamic) MCP tool. Rebuild the sdkName→{server, originalName}
    // map fresh (stateless — no ordering dependency on a prior tools/list).
    const externals = await fetchEnabledExternalTools(sb, ctx.userId);
    for (const { server, tools } of externals) {
      for (const t of tools) {
        if (externalSdkName(server.id, t.tool_name) !== toolName) continue;

        // Confirmation gate: untrusted servers require explicit confirmation,
        // mirroring the built-in ConfirmationRequiredError sentinel path.
        const trusted = (server as Record<string, unknown>).trusted === true;
        if (!trusted && !opts.confirmed) {
          return { ok: false, confirmationRequired: { toolId: toolName, input } };
        }

        try {
          const result = await callExternalTool(
            server as unknown as ExternalServerRow,
            t.tool_name,
            input,
            { userId: ctx.userId, db: sb },
          );
          return { ok: true, result };
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }
      }
    }
    return { ok: false, error: `Unknown tool: ${toolName}` };
  }

  return { ok: false, error: `Unknown tool: ${toolName}` };
}

/**
 * The workspace-scoped handle every MCP call runs against. Cast to the
 * unparameterised SupabaseClient expected by @cortex/agent-tools / @cortex/agents.
 *
 * MCP is the surface with no session and no browser — a long-lived bearer token
 * is the whole context — so pinning the workspace here, once, is what keeps a
 * token issued at one company from reading another's rows.
 */
function makeServiceClient(env: Env, organizationId: string): SupabaseClient {
  const raw = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as SupabaseClient;
  return createOrgScopedClient(raw, organizationId);
}

async function resolveAgentSlug(sb: SupabaseClient, agentId: string | null): Promise<string> {
  if (!agentId) return 'sales';
  const { data } = await sb.from('agents').select('slug').eq('id', agentId).maybeSingle();
  return (data?.slug as string) ?? 'sales';
}

function hydrateProcessEnv(env: Env) {
  // Cloudflare doesn't have a real process.env. Workers polyfill via nodejs_compat
  // provides a stub. Make sure the env vars getEnv() expects are present.
  const target = (globalThis as unknown as { process?: { env?: Record<string, string> } }).process
    ?.env;
  if (!target) return;
  target.NEXT_PUBLIC_SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
  target.SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
  target.TOKEN_ENCRYPTION_KEY = env.TOKEN_ENCRYPTION_KEY;
  target.GOOGLE_CLIENT_ID = env.GOOGLE_CLIENT_ID;
  target.GOOGLE_CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET;
  target.HUBSPOT_CLIENT_ID = env.HUBSPOT_CLIENT_ID;
  target.HUBSPOT_CLIENT_SECRET = env.HUBSPOT_CLIENT_SECRET;
  if (env.VOYAGE_API_KEY) target.VOYAGE_API_KEY = env.VOYAGE_API_KEY;
  if (env.PAYROLL_API_URL) target.PAYROLL_API_URL = env.PAYROLL_API_URL;
  if (env.PAYROLL_API_TOKEN) target.PAYROLL_API_TOKEN = env.PAYROLL_API_TOKEN;
}
