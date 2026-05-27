import type { SupabaseClient } from '@supabase/supabase-js';
import { filterTools, type AnyTool } from '@zipdev/agent-tools';
import type { AgentDefinition } from '@zipdev/core';

export async function loadAgent(db: SupabaseClient, slug: string): Promise<AgentDefinition> {
  const { data, error } = await db.from('agents').select('*').eq('slug', slug).single();
  if (error || !data) throw new Error(`Agent ${slug} not found`);
  return {
    id: data.id as string,
    name: data.name as string,
    team: '', // can be populated by joining teams table; not critical for MVP
    defaultModel: data.default_model as 'gemini-2.5-flash' | 'gemini-2.5-pro',
    systemPrompt: data.system_prompt as string,
    allowedTools: data.allowed_tool_ids as string[],
    kbScopes: ['global', 'team:sales', 'user', 'conversation'],
    greeting: 'How can I help today?',
  };
}

export function getAgentTools(agent: AgentDefinition): AnyTool[] {
  return filterTools(agent.allowedTools);
}
