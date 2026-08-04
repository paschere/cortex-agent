import type { SupabaseClient } from "@supabase/supabase-js";
import { filterTools, type AnyTool } from "@cortex/agent-tools";
import { logger } from "@cortex/core";
import type { AgentDefinition, ModelId } from "@cortex/core";

export async function loadAgent(
  db: SupabaseClient,
  slug: string,
): Promise<AgentDefinition> {
  const { data, error } = await db
    .from("agents")
    .select("*")
    .eq("slug", slug)
    .single();
  if (error || !data) throw new Error(`Agent ${slug} not found`);
  const agent: AgentDefinition = {
    id: data.id as string,
    name: data.name as string,
    team: "", // can be populated by joining teams table; not critical for MVP
    defaultModel: data.default_model as ModelId,
    systemPrompt: data.system_prompt as string,
    allowedTools: data.allowed_tool_ids as string[],
    greeting: "How can I help today?",
  };
  if (agent.systemPrompt.length < 200) {
    logger.warn("Agent system_prompt suspiciously short", {
      agentId: agent.id,
      length: agent.systemPrompt.length,
    });
  }
  return agent;
}

export function getAgentTools(agent: AgentDefinition): AnyTool[] {
  return filterTools(agent.allowedTools);
}
