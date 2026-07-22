import type { SupabaseClient } from '@supabase/supabase-js';
import type { IntegrationProvider, Logger, UUID } from '@zipdev/core';
import type { z } from 'zod';

export interface IntegrationsClient {
  getAccessToken(provider: IntegrationProvider): Promise<{ token: string; scopes: string[] }>;
  hasScopes(provider: IntegrationProvider, scopes: string[]): Promise<boolean>;
}

export interface ToolContext {
  userId: UUID;
  agentId: UUID;
  conversationId?: UUID;
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
