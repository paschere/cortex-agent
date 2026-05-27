import 'server-only';
import { getSupabaseServiceClient } from './supabase/service';
import { createIntegrationsClient } from '@zipdev/agent-tools';
import { logger, type UUID } from '@zipdev/core';
import type { ToolContext } from '@zipdev/agent-tools';

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
