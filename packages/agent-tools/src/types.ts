import type { SupabaseClient } from '@supabase/supabase-js';
import type { IntegrationProvider, Logger, UUID } from '@cortex/core';
import type { z } from 'zod';

export interface IntegrationsClient {
  getAccessToken(provider: IntegrationProvider): Promise<{ token: string; scopes: string[] }>;
  hasScopes(provider: IntegrationProvider, scopes: string[]): Promise<boolean>;
}

/**
 * Where the tool call came from. Drives the security layer's `unattended`
 * signal: a 'schedule' call has no human in the loop, so nothing can be
 * confirmed interactively. Defaults to 'web' when absent.
 */
export type ToolSurface = 'web' | 'mcp' | 'schedule';

export interface ToolContext {
  /**
   * The workspace this call acts in. Required, and never derived inside a tool:
   * an interactive turn takes it from the session, an unattended one takes it
   * from the row of the job it is running. `db` is already pinned to it (see
   * packages/agent-tools/src/tenancy/scoped-client.ts) so a tool never has to
   * filter by it by hand; it is on the context for the few places that must
   * STAMP it — audit rows, security events, and anything that hands work to
   * another surface.
   */
  organizationId: string;
  userId: UUID;
  agentId: UUID;
  conversationId?: UUID;
  surface?: ToolSurface;
  /**
   * Workspace-scoped. Reads are filtered and writes are stamped with
   * `organization_id` automatically; a raw service-role client must never be
   * put here.
   */
  db: SupabaseClient;
  integrations: IntegrationsClient;
  logger: Logger;
  signal?: AbortSignal;
  withSpan?: <T>(name: string, attrs: Record<string, string | number>, fn: () => Promise<T>) => Promise<T>;
}

export interface ToolDef<I, O> {
  id: string;
  description: string;
  inputSchema: z.ZodType<I>;
  outputSchema: z.ZodType<O>;
  requiresConfirmation?: boolean;
  requiredScopes?: { provider: IntegrationProvider; scopes: string[] }[];
  rateLimit?: { perMinute: number };
  handler: (input: I, ctx: ToolContext) => Promise<O>;
}

export type AnyTool = ToolDef<unknown, unknown>;
