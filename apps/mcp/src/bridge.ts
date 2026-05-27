import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { ConfirmationRequiredError, logger } from '@zipdev/core';
import {
  runTool,
  getTool,
  createIntegrationsClient,
  type ToolContext,
} from '@zipdev/agent-tools';
import { loadAgent, getAgentTools } from '@zipdev/agents';
// Side-effect import: register all built-in tools
import '@zipdev/agent-tools';
import type { Env } from './index';

export interface BridgeContext {
  env: Env;
  userId: string;
  agentId: string | null;
}

export async function listToolsForAuth(ctx: BridgeContext) {
  // Set env vars on process.env so getEnv()/integrations refresh works
  hydrateProcessEnv(ctx.env);
  const sb = makeServiceClient(ctx.env);
  const slug = await resolveAgentSlug(sb, ctx.agentId);
  const agent = await loadAgent(sb, slug);
  return getAgentTools(agent);
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
  const sb = makeServiceClient(ctx.env);
  const integrations = createIntegrationsClient(sb, ctx.userId, logger);
  const slug = await resolveAgentSlug(sb, ctx.agentId);
  const agent = await loadAgent(sb, slug);
  const allowed = new Set(getAgentTools(agent).map((t) => t.id));

  // Convert from MCP-safe name back to dotted ID.
  // Tool IDs are "namespace.verb_noun" (exactly one dot). MCP names replace that
  // dot with an underscore: "namespace_verb_noun". So we reverse by replacing only
  // the FIRST underscore back to a dot.
  const toolId = toolName.replace('_', '.');
  if (!allowed.has(toolId)) return { ok: false, error: `Tool ${toolId} not allowed for this agent` };

  const tool = getTool(toolId);
  if (!tool) return { ok: false, error: `Tool ${toolId} not registered` };

  const toolCtx: ToolContext = {
    userId: ctx.userId,
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

// Cast to the unparameterised SupabaseClient expected by @zipdev/agent-tools / @zipdev/agents.
function makeServiceClient(env: Env): SupabaseClient {
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as SupabaseClient;
}

async function resolveAgentSlug(sb: SupabaseClient, agentId: string | null): Promise<string> {
  if (!agentId) return 'sales';
  const { data } = await sb.from('agents').select('slug').eq('id', agentId).maybeSingle();
  return (data?.slug as string) ?? 'sales';
}

function hydrateProcessEnv(env: Env) {
  // Cloudflare doesn't have a real process.env. Workers polyfill via nodejs_compat
  // provides a stub. Make sure the env vars getEnv() expects are present.
  const target = (
    globalThis as unknown as { process?: { env?: Record<string, string> } }
  ).process?.env;
  if (!target) return;
  target.NEXT_PUBLIC_SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
  target.SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
  target.TOKEN_ENCRYPTION_KEY = env.TOKEN_ENCRYPTION_KEY;
  target.GOOGLE_CLIENT_ID = env.GOOGLE_CLIENT_ID;
  target.GOOGLE_CLIENT_SECRET = env.GOOGLE_CLIENT_SECRET;
  target.HUBSPOT_CLIENT_ID = env.HUBSPOT_CLIENT_ID;
  target.HUBSPOT_CLIENT_SECRET = env.HUBSPOT_CLIENT_SECRET;
  target.GOOGLE_GENERATIVE_AI_API_KEY = env.GOOGLE_GENERATIVE_AI_API_KEY;
  target.RATE_ESTIMATOR_URL = env.RATE_ESTIMATOR_URL;
  target.RATE_ESTIMATOR_SERVICE_TOKEN = env.RATE_ESTIMATOR_SERVICE_TOKEN;
}
