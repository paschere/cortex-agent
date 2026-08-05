import 'server-only';
import { createIntegrationsClient } from '@cortex/agent-tools';
import type { ToolContext, ToolSurface } from '@cortex/agent-tools';
import { type UUID, logger } from '@cortex/core';
import { getOrgScopedClient } from './supabase/service';

/**
 * The context every tool runs with.
 *
 * `organizationId` is required and there is no default. That is the whole
 * design: a caller that cannot say which workspace it is acting for has no
 * business running a tool, and an interactive route always knows
 * (`user.organization.id`) while an unattended one must read it off the row it
 * was handed (the routine, the document, the sync state). Making it optional
 * would mean picking a fallback, and every fallback here is somebody else's
 * data.
 *
 * `db` is the scoped handle, so tools keep writing plain queries and get the
 * workspace filter for free.
 */
export function buildToolContext(opts: {
  organizationId: string;
  userId: UUID;
  agentId: UUID;
  conversationId?: UUID;
  surface?: ToolSurface;
  signal?: AbortSignal;
}): ToolContext {
  const db = getOrgScopedClient(opts.organizationId);
  return {
    organizationId: opts.organizationId,
    userId: opts.userId,
    agentId: opts.agentId,
    conversationId: opts.conversationId,
    surface: opts.surface,
    db,
    integrations: createIntegrationsClient(db, opts.userId, logger),
    logger,
    signal: opts.signal,
  };
}
