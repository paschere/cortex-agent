import { buildToolContext } from "@/lib/agent";
import { getSupabaseServiceClient } from "@/lib/supabase/service";
import { getTool, runTool } from "@cortex/agent-tools";
import { logger } from "@cortex/core";

/**
 * Talking back to the human on the Linear issue.
 *
 * Everything goes through the existing `linear.create_comment` tool — no second
 * Linear client, no second place that knows the GraphQL shape or how the token
 * is decrypted, and every comment lands in `audit_events` like any other tool
 * call.
 *
 * ── Whose token ───────────────────────────────────────────────────────────
 * Linear access is per-user OAuth (packages/agent-tools/src/integrations.ts),
 * and a webhook has no signed-in user. So the comment is posted as a designated
 * ACTOR: the Cortex account named by `CORTEX_LINEAR_ACTOR_EMAIL`, falling back to
 * whichever account connected Linear first. That fallback keeps a fresh
 * environment working, but it is worth setting the variable — the audit trail
 * attributes these comments to whoever it picks.
 *
 * ── Failure policy ────────────────────────────────────────────────────────
 * Commenting is COURTESY, not correctness. A Linear outage, a revoked token or
 * a missing integration must never fail a task or block the queue, so every
 * path here returns false instead of throwing. The task row remains the record
 * of truth.
 */

interface Actor {
  userId: string;
  agentId: string;
}

let cachedActor: Actor | null = null;

async function resolveActor(): Promise<Actor | null> {
  if (cachedActor) return cachedActor;
  const db = getSupabaseServiceClient();

  const { data: agent } = await db
    .from("agents")
    .select("id")
    .eq("slug", "cortex")
    .maybeSingle();
  const agentId = agent?.id as string | undefined;
  if (!agentId) {
    logger.error('dev-tasks: no "cortex" agent row — cannot post to Linear');
    return null;
  }

  const configured =
    process.env.CORTEX_LINEAR_ACTOR_EMAIL?.trim().toLowerCase();
  if (configured) {
    const { data: user } = await db
      .from("users")
      .select("id")
      .ilike(
        "email",
        configured.replace(/[%_]/g, (m) => `\\${m}`),
      )
      .maybeSingle();
    if (user?.id) {
      cachedActor = { userId: user.id as string, agentId };
      return cachedActor;
    }
    logger.warn(
      `dev-tasks: CORTEX_LINEAR_ACTOR_EMAIL "${configured}" matches no Cortex user`,
    );
  }

  const { data: integration } = await db
    .from("integrations")
    .select("user_id")
    .eq("provider", "linear")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!integration?.user_id) {
    logger.error(
      "dev-tasks: nobody has connected Linear — cannot post to Linear",
    );
    return null;
  }
  cachedActor = { userId: integration.user_id as string, agentId };
  return cachedActor;
}

/**
 * Post a markdown comment on a Linear issue. Returns whether it landed.
 *
 * `confirmed: true` because there is no human in this loop to approve it, and
 * the body is composed entirely by us from the task row — not by a model, and
 * never containing a token or anything the requester did not already see on
 * their own issue.
 */
export async function commentOnIssue(
  issueId: string,
  body: string,
): Promise<boolean> {
  try {
    const actor = await resolveActor();
    if (!actor) return false;
    const tool = getTool("linear.create_comment");
    if (!tool) {
      logger.error("dev-tasks: linear.create_comment is not registered");
      return false;
    }
    const ctx = buildToolContext({
      userId: actor.userId,
      agentId: actor.agentId,
    });
    await runTool(tool, { issueId, body }, ctx, { confirmed: true });
    return true;
  } catch (err) {
    logger.error("dev-tasks: could not comment on the Linear issue", {
      issueId,
      error: (err as Error).message,
    });
    return false;
  }
}

/** Exposed for tests and for the rare case where the actor changes at runtime. */
export function resetLinearActorCache(): void {
  cachedActor = null;
}
