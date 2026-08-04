import 'server-only';
import { getSupabaseServiceClient } from './supabase/service';
import { createIntegrationsClient } from '@cortex/agent-tools';
import { logger, type UUID } from '@cortex/core';
import type { ToolContext } from '@cortex/agent-tools';

export function buildToolContext(opts: {
  userId: UUID;
  agentId: UUID;
  conversationId?: UUID;
  signal?: AbortSignal;
}): ToolContext {
  const db = getSupabaseServiceClient();
  return {
    userId: opts.userId,
    agentId: opts.agentId,
    conversationId: opts.conversationId,
    db,
    integrations: createIntegrationsClient(db, opts.userId, logger),
    logger,
    signal: opts.signal,
  };
}
