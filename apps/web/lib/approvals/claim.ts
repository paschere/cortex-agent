import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Deciding a pending approval — the one place all three surfaces go through.
 *
 * An approval can now be answered from the /approvals page, from Claude over
 * MCP, and from a button inside a Google Chat message. A button in a Chat
 * message is the awkward one: it is a URL somebody else's client could POST,
 * it can be clicked twice in a second, Chat retries deliveries it thinks timed
 * out, and it stays on screen long after the 15-minute window closed.
 *
 * So the decision is a CLAIM, and the claim is one SQL statement:
 *
 *   update mcp_pending_actions
 *      set decision = …, decided_at = …, decided_by = …, decided_via = …
 *    where id = … and user_id = … and decision is null and expires_at > now
 *   returning tool_id, agent_id, input
 *
 * All four guards live in that WHERE clause, which is the point. A
 * read-then-write would pass every test built on a Map and still execute twice
 * under two concurrent clicks, because both reads can see an undecided row.
 * Here the loser matches zero rows and gets told the truth instead.
 *
 * `peek` exists only to EXPLAIN a failed claim ("already approved", "that isn't
 * yours", "it expired"). It never authorises anything — by the time it runs the
 * claim has already been refused.
 */

export type ApprovalDecision = 'approved' | 'declined';

/** Which surface the person pressed the button on. */
export type ApprovalChannel = 'web' | 'google_chat' | 'mcp';

/** The staged action, as returned by a successful claim. */
export interface ClaimedApproval {
  id: string;
  userId: string;
  agentId: string;
  toolId: string;
  input: unknown;
}

/** What a diagnostic read can see. Ownership is NOT filtered here on purpose. */
export interface ApprovalSnapshot {
  id: string;
  userId: string;
  toolId: string;
  expiresAt: string;
  decision: ApprovalDecision | null;
  decidedAt: string | null;
  decidedVia: string | null;
}

export interface ApprovalClaim {
  id: string;
  userId: string;
  decision: ApprovalDecision;
  via: ApprovalChannel;
  /** Both the expiry cutoff and the recorded decision time. */
  now: Date;
}

export interface ApprovalStore {
  /**
   * The atomic conditional update. Implementations MUST match on id, user, an
   * unset decision AND an unexpired row in a single statement, and return the
   * row only when it changed it.
   */
  claim(input: ApprovalClaim): Promise<ClaimedApproval | null>;
  /** Read by id ALONE, for explaining a refusal. */
  peek(id: string): Promise<ApprovalSnapshot | null>;
}

export type ClaimOutcome =
  | { status: 'claimed'; action: ClaimedApproval }
  /** No such request — a button from a run that has since been cleaned up. */
  | { status: 'unknown' }
  /** Someone else's approval. Never say whose. */
  | { status: 'not_yours' }
  | { status: 'expired'; toolId: string }
  | {
      status: 'already_decided';
      toolId: string;
      decision: ApprovalDecision;
      decidedAt: string | null;
      decidedVia: string | null;
    };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isApprovalId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Try to take the decision. The return value is everything a caller needs to
 * say something true to a human — nothing else should re-derive it.
 */
export async function claimApproval(
  store: ApprovalStore,
  input: ApprovalClaim,
): Promise<ClaimOutcome> {
  // A malformed id is not worth a database round-trip, and Postgres would
  // reject the uuid cast anyway.
  if (!isApprovalId(input.id) || !isApprovalId(input.userId)) return { status: 'unknown' };

  const action = await store.claim(input);
  if (action) return { status: 'claimed', action };

  const row = await store.peek(input.id);
  if (!row) return { status: 'unknown' };

  // Ownership is checked BEFORE the decision is revealed: someone who does not
  // own the approval learns nothing about it, not even that it was approved.
  if (row.userId !== input.userId) return { status: 'not_yours' };

  if (row.decision) {
    return {
      status: 'already_decided',
      toolId: row.toolId,
      decision: row.decision,
      decidedAt: row.decidedAt,
      decidedVia: row.decidedVia,
    };
  }

  if (new Date(row.expiresAt).getTime() <= input.now.getTime()) {
    return { status: 'expired', toolId: row.toolId };
  }

  // Undecided, unexpired, owned by the caller — and the claim still failed.
  // Only reachable if it was claimed between the update and the peek, so treat
  // it as already handled rather than retrying and risking a double run.
  return { status: 'unknown' };
}

/** Supabase-backed store. The WHERE clause is the security boundary. */
export function supabaseApprovalStore(db: SupabaseClient): ApprovalStore {
  return {
    async claim(input) {
      const nowIso = input.now.toISOString();
      const { data, error } = await db
        .from('mcp_pending_actions')
        .update({
          decision: input.decision,
          decided_at: nowIso,
          decided_by: input.userId,
          decided_via: input.via,
        })
        .eq('id', input.id)
        .eq('user_id', input.userId)
        .is('decision', null)
        .gt('expires_at', nowIso)
        .select('id, user_id, agent_id, tool_id, input')
        .maybeSingle();
      if (error || !data) return null;
      return {
        id: data.id as string,
        userId: data.user_id as string,
        agentId: data.agent_id as string,
        toolId: data.tool_id as string,
        input: data.input,
      };
    },
    async peek(id) {
      const { data } = await db
        .from('mcp_pending_actions')
        .select('id, user_id, tool_id, expires_at, decision, decided_at, decided_via')
        .eq('id', id)
        .maybeSingle();
      if (!data) return null;
      return {
        id: data.id as string,
        userId: data.user_id as string,
        toolId: data.tool_id as string,
        expiresAt: data.expires_at as string,
        decision: (data.decision as ApprovalDecision | null) ?? null,
        decidedAt: (data.decided_at as string | null) ?? null,
        decidedVia: (data.decided_via as string | null) ?? null,
      };
    },
  };
}
