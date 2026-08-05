import 'server-only';
import { buildToolContext } from '@/lib/agent';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { deniedToolPatterns, isToolDenied } from '@/lib/tool-access';
import { getTool, runTool } from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import {
  type ApprovalChannel,
  type ApprovalDecision,
  type ClaimOutcome,
  type ClaimedApproval,
  claimApproval,
  supabaseApprovalStore,
} from './claim';

/**
 * Deciding an approval, for every surface that can decide one.
 *
 * /approvals, Claude over MCP and the buttons in a Google Chat card all come
 * through here, which is the whole point: the moment two surfaces have their
 * own copy of "is this still open?", one of them starts offering a second,
 * conflicting decision on something already answered.
 *
 * The order is fixed and matters:
 *
 *   1. CLAIM — one atomic conditional update (see ./claim.ts). Nothing runs
 *      before the row is ours.
 *   2. AUDIT — the decision is recorded against the real person who made it,
 *      including declines, which execute nothing and would otherwise leave no
 *      trace beyond the row itself.
 *   3. EXECUTE — with that person's context, so `runTool` audits and rate-limits
 *      the call as theirs, exactly as the web path always has.
 *
 * If step 3 throws, the approval STAYS decided. Marking it open again would
 * turn a half-executed write into a button that can be pressed a second time,
 * and "it may or may not have gone out" is a far worse failure than "it didn't,
 * ask me again".
 */

/** The audit row every decision leaves, on every surface. */
const DECISION_AUDIT_TOOL_ID = '__approval_decision';

export interface DecideInput {
  organizationId: string;
  approvalId: string;
  userId: string;
  decision: ApprovalDecision;
  via: ApprovalChannel;
  now?: Date;
}

export async function decideApproval(input: DecideInput): Promise<ClaimOutcome> {
  const db = getOrgScopedClient(input.organizationId);
  const now = input.now ?? new Date();

  const outcome = await claimApproval(supabaseApprovalStore(db), {
    id: input.approvalId,
    userId: input.userId,
    decision: input.decision,
    via: input.via,
    now,
  });

  if (outcome.status === 'claimed') {
    await db
      .from('audit_events')
      .insert({
        user_id: input.userId,
        agent_id: outcome.action.agentId,
        tool_id: DECISION_AUDIT_TOOL_ID,
        // Not a digest: the approval id already points at the exact stored
        // payload the decision was made about, which is what the column is for.
        input_hash: outcome.action.id,
        status: 'ok',
        latency_ms: 0,
        metadata: {
          decision: input.decision,
          via: input.via,
          gatedTool: outcome.action.toolId,
        },
      })
      .then(undefined, () => undefined);
  } else if (outcome.status === 'not_yours') {
    // Somebody pressed a button on an approval that is not theirs. In practice
    // the card only exists in the owner's 1:1 with the app, so this is either a
    // forwarded message or someone probing the endpoint — either way it is
    // worth a row, not just a log line.
    await db
      .from('security_events')
      .insert({
        user_id: input.userId,
        tool_id: 'approval.decide',
        surface: input.via === 'google_chat' ? 'google-chat' : input.via,
        risk_level: 'medium',
        decision: 'blocked',
        reason: 'approval decided by someone other than its owner',
        signals: { approvalId: input.approvalId, attempted: input.decision },
      })
      .then(undefined, () => undefined);
  }

  return outcome;
}

export type ExecutionResult =
  | { ok: true; result: unknown }
  | { ok: false; message: string; reason: 'unknown_tool' | 'denied' | 'failed' };

/**
 * Run what was approved, as the person who approved it.
 *
 * The deny-list is re-checked here rather than trusted from staging time: a
 * team can revoke a tool in the fifteen minutes an approval is open, and a
 * revoked tool must not run just because the button was already on screen.
 */
export async function runApprovedAction(action: ClaimedApproval): Promise<ExecutionResult> {
  const tool = getTool(action.toolId);
  if (!tool) {
    return {
      ok: false,
      reason: 'unknown_tool',
      message: "I can't run that any more — it isn't something I know how to do.",
    };
  }

  const db = getOrgScopedClient(action.organizationId);
  const denied = await deniedToolPatterns(db, action.userId);
  if (isToolDenied(action.toolId, denied)) {
    return {
      ok: false,
      reason: 'denied',
      message: "You don't have access to that any more, so I didn't run it.",
    };
  }

  try {
    const ctx = buildToolContext({
      organizationId: action.organizationId,
      userId: action.userId,
      agentId: action.agentId,
    });
    const result = await runTool(tool, action.input, ctx, { confirmed: true });
    return { ok: true, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Tool execution failed';
    logger.error(`approvals: approved action failed — ${action.toolId}: ${message}`);
    return { ok: false, reason: 'failed', message };
  }
}

/**
 * The timezone the person reads clocks in. Without it "approved at 14:32" is
 * a UTC timestamp wearing a local time's clothes.
 */
export async function approvalTimeZone(organizationId: string, userId: string): Promise<string> {
  try {
    const { data } = await getOrgScopedClient(organizationId)
      .from('user_preferences')
      .select('timezone')
      .eq('user_id', userId)
      .maybeSingle();
    return (data?.timezone as string | null) || 'America/Bogota';
  } catch {
    return 'America/Bogota';
  }
}
