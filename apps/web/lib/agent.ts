import 'server-only';
import { createIntegrationsClient } from '@cortex/agent-tools';
import type { ToolContext } from '@cortex/agent-tools';
import { type UUID, logger } from '@cortex/core';
import { getSupabaseServiceClient } from './supabase/service';

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
