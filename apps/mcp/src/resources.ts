import { createClient } from '@supabase/supabase-js';
import { listVisibleSpaces } from '@cortex/agent-tools';
import { loadAgent } from '@cortex/agents';
import type { BridgeContext } from './bridge';

export const RESOURCES = [
  {
    uri: 'zipdev://agent/system-prompt',
    name: 'Current agent system prompt',
    mimeType: 'text/markdown',
  },
  {
    uri: 'zipdev://kb/spaces',
    name: 'Knowledge Base spaces you can see',
    mimeType: 'application/json',
  },
];

export async function readResource(ctx: BridgeContext, uri: string) {
  const sb = createClient(ctx.env.NEXT_PUBLIC_SUPABASE_URL, ctx.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  if (uri === 'zipdev://agent/system-prompt') {
    const agent = await loadAgent(sb, 'sales');
    return {
      contents: [{ uri, mimeType: 'text/markdown', text: agent.systemPrompt }],
    };
  }

  if (uri === 'zipdev://kb/spaces') {
    // Same helper the tools use, so this surface cannot drift into showing a
    // space that retrieval would refuse to search.
    const spaces = await listVisibleSpaces(sb, ctx.userId);
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

  throw new Error(`Unknown resource: ${uri}`);
}
