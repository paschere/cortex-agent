import 'server-only';
import { claimApproval } from '@/lib/approvals/claim';
import { runApprovedAction } from '@/lib/approvals/decide';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  type ActionRow,
  ActionIntegrityError,
  assertExecutable,
  getAction,
  recordExecution,
} from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { explainStaleContent, supabaseActionStore } from './claim';

/**
 * Deciding a proposed action, and running what was decided.
 *
 * The order is fixed and it is the same order `lib/approvals/decide.ts` uses,
 * because it is the same problem:
 *
 *   1. CLAIM — one atomic conditional update. Nothing runs before the row is
 *      ours, and the fingerprint of the approved text is one of its conditions.
 *   2. CHECK — `assertExecutable`, on the row the claim RETURNED. Belt to the
 *      claim's braces: it re-derives the fingerprint from the payload in hand
 *      and refuses if it is not the one that was approved.
 *   3. EXECUTE — through `runApprovedAction`, which re-checks the team
 *      deny-list and calls `runTool(..., {confirmed:true})`. That is the same
 *      executor the /approvals page uses; there is no second way to send mail
 *      from this feature, and therefore no unaudited one.
 *   4. RECORD — what happened, on the row, including a failure.
 *
 * If step 3 throws, the action STAYS approved and is marked failed. Returning
 * it to 'proposed' would put a button back on screen for something that may
 * already have half-happened, and "it may or may not have gone out" is a far
 * worse thing to hand somebody than "it didn't — ask me again".
 */

export type DecideActionOutcome =
  | { status: 'claimed'; action: ActionRow }
  | { status: 'unknown' }
  | { status: 'not_yours' }
  | { status: 'expired' }
  | { status: 'already_decided'; decision: 'approved' | 'declined'; decidedAt: string | null }
  /** The draft was edited between being rendered and being approved. */
  | { status: 'content_changed' };

export interface DecideActionInput {
  organizationId: string;
  actionId: string;
  userId: string;
  decision: 'approve' | 'dismiss';
  /** The fingerprint of the text the person was looking at. Approvals only. */
  contentHash?: string;
  reason?: string;
  via?: 'web' | 'chat' | 'mcp';
  now?: Date;
}

export async function decideAction(input: DecideActionInput): Promise<DecideActionOutcome> {
  const db = getOrgScopedClient(input.organizationId);
  const now = input.now ?? new Date();

  const outcome = await claimApproval(
    supabaseActionStore(db, {
      organizationId: input.organizationId,
      contentHash: input.contentHash,
      reason: input.reason,
    }),
    {
      id: input.actionId,
      userId: input.userId,
      decision: input.decision === 'approve' ? 'approved' : 'declined',
      via: input.via === 'chat' ? 'google_chat' : (input.via ?? 'web'),
      now,
    },
  );

  switch (outcome.status) {
    case 'claimed': {
      // The claim returns the approvals-shaped projection; the screen and the
      // executor both want the whole row, and it is now immutable — the trigger
      // in migration 0077 freezes the content of a decided action — so reading
      // it back cannot see something different from what was claimed.
      const row = await getAction(db, input.actionId);
      if (!row) return { status: 'unknown' };
      return { status: 'claimed', action: row };
    }
    case 'not_yours':
      return { status: 'not_yours' };
    case 'expired':
      return { status: 'expired' };
    case 'already_decided':
      return {
        status: 'already_decided',
        decision: outcome.decision,
        decidedAt: outcome.decidedAt,
      };
    case 'unknown': {
      // The shared logic could not explain it: open, theirs, unexpired, and the
      // update still matched nothing. For an action there is one remaining
      // reason, and it is the one the person most needs to hear.
      if (await explainStaleContent(db, input.actionId, input.contentHash)) {
        return { status: 'content_changed' };
      }
      return { status: 'unknown' };
    }
  }
}

export type RunActionResult =
  | { ok: true; result: unknown; threadId: string | null }
  | { ok: false; message: string; reason: 'integrity' | 'no_agent' | 'failed' };

/**
 * Send exactly what was approved.
 *
 * `approvedHash` is the fingerprint the person clicked against. It was already
 * a condition of the claim; asserting it again here, against the payload
 * actually in hand, is what makes the guarantee independent of every layer
 * between the button and this line.
 */
export async function runApprovedActionRow(
  organizationId: string,
  action: ActionRow,
  approvedHash: string,
): Promise<RunActionResult> {
  const db = getOrgScopedClient(organizationId);

  try {
    assertExecutable(action, approvedHash);
  } catch (err) {
    if (err instanceof ActionIntegrityError) {
      logger.error(`actions: refused to execute ${action.id} — ${err.message}`);
      await recordExecution(db, {
        id: action.id,
        status: 'blocked',
        error: err.message,
      }).catch(() => undefined);
      return { ok: false, reason: 'integrity', message: err.spanish };
    }
    throw err;
  }

  if (!action.agent_id) {
    return {
      ok: false,
      reason: 'no_agent',
      message: 'Esa acción no quedó ligada a un agente, así que no puedo ejecutarla.',
    };
  }

  const run = await runApprovedAction({
    id: action.id,
    organizationId,
    userId: action.user_id,
    agentId: action.agent_id,
    toolId: action.tool_id,
    // The payload the claim returned. Never re-read, never rebuilt from parts,
    // never taken from the request that approved it.
    input: action.tool_input,
  });

  if (!run.ok) {
    await recordExecution(db, {
      id: action.id,
      status: 'failed',
      error: run.message,
    }).catch(() => undefined);
    return { ok: false, reason: 'failed', message: run.message };
  }

  const threadId =
    run.result && typeof run.result === 'object'
      ? ((run.result as { threadId?: string | null }).threadId ?? null)
      : null;

  await recordExecution(db, {
    id: action.id,
    status: 'ok',
    result: run.result,
    threadId,
  });

  return { ok: true, result: run.result, threadId };
}
