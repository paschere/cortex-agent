/**
 * The enforcement glue between `runTool` and the risk model.
 *
 * Everything the choke point needs is here so registry.ts stays readable:
 * evaluate (classify + policy + frequency), turn the verdict into audit
 * columns, and record incidents in `security_events`.
 *
 * Latency budget: `evaluate()` issues AT MOST one round-trip of latency —
 * the policy load and the frequency count are fired in parallel, both are
 * memoised for 60s, and the frequency count is skipped outright for
 * non-sensitive tools. A low-risk call with warm caches costs zero queries.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { type UUID, logger } from '@cortex/core';
import { hashInput } from '../audit.js';
import { isHighFrequency, noteSensitiveCall, sensitiveCallCount } from './frequency.js';
import {
  type Classification,
  DEFAULT_POLICY,
  type Decision,
  type RiskSignal,
  type SecurityPolicy,
  type Surface,
  classify,
  decide,
  explainBlock,
  explainFlag,
  isSensitiveFamily,
} from './policy.js';
import { loadPolicy } from './store.js';

/** What lands in `audit_events.decision` — see migration 0042. */
export type AuditDecision = 'allowed' | 'flagged' | 'blocked' | 'confirmed';

export interface SecurityEvaluation {
  classification: Classification;
  decision: Decision;
  policy: SecurityPolicy;
  surface: Surface;
}

export interface RiskAuditFields {
  surface: Surface;
  riskLevel: string;
  decision: AuditDecision;
  riskReason: string;
  riskSignals: RiskSignal[];
}

export interface EvaluateArgs {
  tool: { id: string; requiresConfirmation?: boolean };
  input: unknown;
  db: SupabaseClient;
  userId: string;
  surface?: Surface;
  confirmed?: boolean;
  now?: Date;
}

/**
 * Classify a call and decide what to do with it. Never throws — a failure
 * anywhere in here degrades to "classify with default policy and no frequency
 * signal", which can only ever be more permissive, never less correct.
 */
export async function evaluate(args: EvaluateArgs): Promise<SecurityEvaluation> {
  const surface: Surface = args.surface ?? 'web';
  let policy = DEFAULT_POLICY;
  const extraSignals: RiskSignal[] = [];

  try {
    // Only sensitive-family tools pay for the frequency count; both lookups
    // are cached and run concurrently, so this is one round-trip of latency.
    const needFrequency = isSensitiveFamily(args.tool.id);
    const [loaded, count] = await Promise.all([
      loadPolicy(args.db),
      needFrequency ? sensitiveCallCount(args.db, args.userId) : Promise.resolve(null),
    ]);
    policy = loaded;
    if (needFrequency) {
      if (isHighFrequency(count, policy.sensitiveReadsPerHour)) extraSignals.push('high-frequency');
      noteSensitiveCall(args.userId);
    }
  } catch (err) {
    // Fail open on the I/O half; the deterministic half below still runs.
    logger.warn(
      { err, toolId: args.tool.id },
      'security: policy/frequency lookup failed, using defaults',
    );
  }

  const classification = classify({
    tool: args.tool,
    input: args.input,
    ctx: { confirmed: args.confirmed, now: args.now, extraSignals },
    surface,
  });

  return { classification, decision: decide(classification, policy), policy, surface };
}

/**
 * Audit columns for a given evaluation. `override` lets the caller record what
 * actually happened (e.g. 'confirmed' once the user approved a gated call).
 */
export function riskAuditFields(
  ev: SecurityEvaluation | null,
  override?: AuditDecision,
): Partial<RiskAuditFields> {
  if (!ev) return override ? { decision: override } : {};
  const natural: AuditDecision =
    ev.decision === 'block'
      ? 'blocked'
      : ev.decision === 'confirm'
        ? 'flagged'
        : ev.classification.riskLevel === 'low'
          ? 'allowed'
          : 'flagged';
  return {
    surface: ev.surface,
    riskLevel: ev.classification.riskLevel,
    decision: override ?? natural,
    riskReason: ev.classification.reason,
    riskSignals: ev.classification.signals,
  };
}

/** True when the call should leave a standalone incident row. */
export function isIncident(ev: SecurityEvaluation): boolean {
  return ev.decision !== 'allow' || ev.classification.riskLevel !== 'low';
}

export interface SecurityEventOpts {
  db: SupabaseClient;
  userId: UUID;
  agentId: UUID;
  toolId: string;
  input: unknown;
  evaluation: SecurityEvaluation;
  /** 'blocked' | 'confirm_required' | 'flagged' */
  decision: string;
}

/**
 * One row per blocked / gated / flagged attempt. Survives audit pruning; this
 * is what a security review reads. Never throws.
 */
export async function writeSecurityEvent(opts: SecurityEventOpts): Promise<void> {
  const { classification } = opts.evaluation;
  try {
    const { error } = await opts.db.from('security_events').insert({
      user_id: opts.userId,
      agent_id: opts.agentId,
      tool_id: opts.toolId,
      surface: opts.evaluation.surface,
      risk_level: classification.riskLevel,
      decision: opts.decision,
      reason: classification.reason,
      signals: classification.signals,
      input_digest: hashInput(opts.input),
    });
    if (error) logger.error({ err: error }, 'security_events insert failed');
  } catch (err) {
    logger.error({ err }, 'security_events insert threw');
  }
}

export { explainBlock, explainFlag };
