import type { IntegrationProvider, Logger, UUID } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
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
  /**
   * A CEILING on Brain Knowledge retrieval for this turn, when the surface has
   * one. Undefined — the normal case — means "whatever this person can see",
   * decided in Postgres from `userId` as it always has been.
   *
   * It can only ever NARROW: retrieval intersects it with the visible set, so a
   * space id in here that the caller cannot see contributes nothing. An EMPTY
   * ARRAY means "no space at all" and must never be read as "no restriction" —
   * that distinction is the whole point of the field.
   *
   * It exists for one situation: answering out loud in a room that contains
   * people who do not work here (a WhatsApp group — migration 0072). There, the
   * asker's own private notes are exactly what must not be quotable, and a rule
   * enforced at each call site would be a rule that eventually is not.
   */
  kbSpaceIds?: string[];
  signal?: AbortSignal;
  withSpan?: <T>(
    name: string,
    attrs: Record<string, string | number>,
    fn: () => Promise<T>,
  ) => Promise<T>;
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
