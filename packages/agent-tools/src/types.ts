import type { SupabaseClient } from '@supabase/supabase-js';
import type { IntegrationProvider, Logger, UUID } from '@zipdev/core';
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
  userId: UUID;
  agentId: UUID;
  conversationId?: UUID;
  surface?: ToolSurface;
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
