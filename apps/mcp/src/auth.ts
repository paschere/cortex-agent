import type { MiddlewareHandler } from 'hono';
import { createClient } from '@supabase/supabase-js';
import type { Env } from './index';

interface McpAuthContext {
  /** The workspace the token was issued in; every query it makes is pinned to it. */
  organizationId: string;
  userId: string;
  agentId: string | null;
  tokenId: string;
}

declare module 'hono' {
  interface ContextVariableMap {
    mcp: McpAuthContext;
  }
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function bearerAuth(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const header = c.req.header('Authorization') ?? '';
    if (!header.startsWith('Bearer ')) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const token = header.slice(7).trim();
    if (!token) return c.json({ error: 'Unauthorized' }, 401);

    const tokenHash = await sha256Hex(token);
    const sb = createClient(c.env.NEXT_PUBLIC_SUPABASE_URL, c.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data, error } = await sb
      .from('mcp_tokens')
      .select('id, organization_id, user_id, agent_id, revoked_at, expires_at')
      .eq('token_hash', tokenHash)
      .maybeSingle();

    if (error || !data) return c.json({ error: 'Unauthorized' }, 401);
    if (data.revoked_at) return c.json({ error: 'Unauthorized' }, 401);
    if (data.expires_at && new Date(data.expires_at as string) < new Date()) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    // Fire-and-forget update of last_used_at
    void sb.from('mcp_tokens').update({ last_used_at: new Date().toISOString() }).eq('id', data.id as string);

    // The token names its workspace, and everything downstream is scoped to it
    // (see bridge.ts). The lookup itself has to be unscoped: it is what
    // determines the workspace, so it cannot already be inside one.
    c.set('mcp', {
      organizationId: data.organization_id as string,
      userId: data.user_id as string,
      agentId: (data.agent_id as string | null) ?? null,
      tokenId: data.id as string,
    });

    await next();
  };
}
