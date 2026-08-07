import type { ApprovalStore } from '@/lib/approvals/claim';
import { claimAction, peekAction } from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Proposed actions, decided through the approval mechanism this product
 * already has.
 *
 * `lib/approvals/claim.ts` is written as an INTERFACE plus a pure decision
 * function, and that is not an accident of style — it is the shape that lets a
 * second kind of approvable thing exist without a second set of rules about
 * what "already decided", "not yours" and "expired" mean. So this file is an
 * adapter, not an implementation: `claimApproval()` still decides the outcome,
 * still refuses a stranger before revealing anything, still explains a refusal
 * from a diagnostic read that authorises nothing. What changes is only which
 * table the conditional UPDATE runs against.
 *
 * ── The extra condition ───────────────────────────────────────────────────
 * An action's claim carries one guard `mcp_pending_actions` has no need for:
 * the fingerprint of the text the approver was shown. It is closed over by the
 * store rather than added to `ApprovalClaim`, so the shared contract stays
 * exactly as it was for the surfaces that do not have content to protect.
 *
 * Because the hash lives in the WHERE clause, a stale approval matches zero
 * rows and `claimApproval` reports `unknown` — true, but useless to a person
 * looking at a card that is plainly right there. `explainStaleContent` below is
 * how the route turns that into the sentence that actually happened: the text
 * moved, read it again. It runs only after a claim has already been refused, so
 * it can never widen what the claim allowed.
 */

/** Mapped from the actions vocabulary to the approvals one, and back. */
function stateToDecision(state: string): 'approved' | 'declined' | null {
  if (state === 'approved') return 'approved';
  if (state === 'dismissed') return 'declined';
  return null;
}

export interface ActionStoreOptions {
  /**
   * The workspace the claim is acting in. `db` is already pinned to it, so this
   * is not what scopes the query — it is here because the executor needs to
   * build a tool context in the same workspace, and deriving it from anywhere
   * else at that point is how a run ends up in the wrong tenant.
   */
  organizationId: string;
  /**
   * The fingerprint of the content the approver was looking at. Required to
   * approve; irrelevant to a dismissal, because discarding text you have not
   * read is always safe and refusing to let somebody clear a stale card would
   * be hostile for no gain.
   */
  contentHash?: string;
  /** Why it was discarded, when they said. */
  reason?: string;
}

export function supabaseActionStore(
  db: SupabaseClient,
  opts: ActionStoreOptions,
): ApprovalStore {
  return {
    async claim(input) {
      const row = await claimAction(db, {
        id: input.id,
        userId: input.userId,
        decision: input.decision === 'approved' ? 'approved' : 'dismissed',
        via: input.via === 'google_chat' ? 'chat' : input.via,
        contentHash: opts.contentHash,
        reason: opts.reason,
        now: input.now,
      });
      if (!row) return null;
      return {
        id: row.id,
        organizationId: opts.organizationId,
        userId: row.user_id,
        agentId: row.agent_id ?? '',
        toolId: row.tool_id,
        input: row.tool_input,
      };
    },
    async peek(id) {
      const row = await peekAction(db, id);
      if (!row) return null;
      return {
        id: row.id,
        userId: row.user_id,
        toolId: row.tool_id,
        expiresAt: row.expires_at,
        decision: stateToDecision(row.state),
        decidedAt: row.decided_at,
        decidedVia: row.decided_via,
      };
    },
  };
}

/**
 * Was the claim refused because the text moved under the approver?
 *
 * Called only on a refusal the shared logic could not explain — the row is
 * still open, still theirs, still unexpired, and the update matched nothing.
 * For an action there is exactly one remaining reason: its fingerprint is not
 * the one that was approved against.
 */
export async function explainStaleContent(
  db: SupabaseClient,
  id: string,
  approvedHash: string | undefined,
): Promise<boolean> {
  if (!approvedHash) return false;
  const row = await peekAction(db, id);
  return Boolean(row && row.state === 'proposed' && row.content_hash !== approvedHash);
}
