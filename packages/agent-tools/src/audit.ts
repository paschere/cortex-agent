import { createHash } from 'node:crypto';
import { type UUID, logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';

export type AuditStatus = 'ok' | 'error' | 'rate_limited' | 'confirmation_required';

/**
 * See migration 0042 — why a call was allowed, gated, flagged or refused —
 * and 0099 for `delegated`: iba a preguntar y no preguntó, porque un mandato
 * concedido por un administrador lo cubría.
 */
export type AuditDecision = 'allowed' | 'flagged' | 'blocked' | 'confirmed' | 'delegated';

export interface WriteAuditOpts {
  db: SupabaseClient;
  userId: UUID;
  /**
   * The agent that made the call. Optional because not every auditable act is
   * a model's: an administrator deleting something from a screen is a person
   * acting directly, and inventing an agent id for that would put a lie in the
   * one table that exists to be believed. The column has always been nullable.
   */
  agentId?: UUID;
  conversationId?: UUID;
  toolId: string;
  input: unknown;
  status: AuditStatus;
  latencyMs: number;
  metadata?: Record<string, unknown>;
  // --- security layer (migration 0042). All optional: every existing caller
  // keeps working unchanged and simply writes NULL risk columns.
  /** where the call came from: 'web' | 'mcp' | 'schedule' */
  surface?: string;
  /** 'low' | 'medium' | 'high' | 'critical' */
  riskLevel?: string;
  decision?: AuditDecision;
  /** short human sentence for the audit UI */
  riskReason?: string;
  riskSignals?: string[];
  /**
   * La concesión que autorizó la llamada sin preguntar (migración 0099). Va
   * junto al `risk_level` real y NO en su lugar: la fila tiene que decir a la
   * vez qué era la llamada y por qué no se preguntó.
   */
  mandateId?: string;
}

export function hashInput(input: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(input ?? null))
    .digest('hex')
    .slice(0, 32);
}

export async function writeAuditEvent(opts: WriteAuditOpts) {
  try {
    await insertAuditEvent(opts);
  } catch (err) {
    // The db client itself can throw (network down, mocked client). Same
    // contract as a returned error: never break the user's call.
    logger.error({ err }, 'audit_events insert threw');
  }
}

async function insertAuditEvent(opts: WriteAuditOpts) {
  const { error } = await opts.db.from('audit_events').insert({
    user_id: opts.userId,
    agent_id: opts.agentId ?? null,
    conversation_id: opts.conversationId ?? null,
    tool_id: opts.toolId,
    input_hash: hashInput(opts.input),
    status: opts.status,
    latency_ms: opts.latencyMs,
    metadata: opts.metadata ?? {},
    surface: opts.surface ?? null,
    risk_level: opts.riskLevel ?? null,
    decision: opts.decision ?? null,
    risk_reason: opts.riskReason ?? null,
    risk_signals: opts.riskSignals ?? [],
    mandate_id: opts.mandateId ?? null,
  });
  if (error) {
    // Never throw — audit failures must not break the user's call
    logger.error({ err: error }, 'audit_events insert failed');
  }
}
