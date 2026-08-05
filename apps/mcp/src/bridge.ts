import {
  type ExternalServerRow,
  type ToolContext,
  callExternalTool,
  createIntegrationsClient,
  createOrgScopedClient,
  fetchEnabledExternalTools,
  getTool,
  runTool,
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
  const builtins = getAgentTools(agent);
  const externals = await fetchEnabledExternalTools(sb, ctx.userId);
  return { builtins, externals };
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
  const builtins = getAgentTools(agent);
  const builtinMap = new Map(builtins.map((t) => [t.id.replaceAll('.', '_'), t.id]));

  const builtinId = builtinMap.get(toolName);
  if (builtinId) {
    const tool = getTool(builtinId);
    if (!tool) return { ok: false, error: `Tool ${builtinId} not registered` };

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
