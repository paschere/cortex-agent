import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger, type UUID } from '@zipdev/core';

export type AuditStatus = 'ok' | 'error' | 'rate_limited' | 'confirmation_required';

export interface WriteAuditOpts {
  db: SupabaseClient;
  userId: UUID;
  agentId: UUID;
  conversationId?: UUID;
  toolId: string;
  input: unknown;
  status: AuditStatus;
  latencyMs: number;
  metadata?: Record<string, unknown>;
}

export function hashInput(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input ?? null)).digest('hex').slice(0, 32);
}

export async function writeAuditEvent(opts: WriteAuditOpts) {
  const { error } = await opts.db.from('audit_events').insert({
    user_id: opts.userId,
    agent_id: opts.agentId,
    conversation_id: opts.conversationId ?? null,
    tool_id: opts.toolId,
    input_hash: hashInput(opts.input),
    status: opts.status,
    latency_ms: opts.latencyMs,
    metadata: opts.metadata ?? {},
  });
  if (error) {
    // Never throw — audit failures must not break the user's call
    logger.error({ err: error }, 'audit_events insert failed');
  }
}
