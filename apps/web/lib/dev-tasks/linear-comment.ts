import { buildToolContext } from '@/lib/agent';
import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import { getTool, runTool } from '@cortex/agent-tools';
import { logger } from '@cortex/core';

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
  organizationId: string;
  userId: string;
  agentId: string;
}

const cachedActors = new Map<string, Actor>();

/**
 * Whose Cortex account posts the comment, and in which workspace.
 *
 * `organizationId` is null only on the rejection path, where the issue never
 * resolved to a repository and therefore never resolved to a workspace. Rather
 * than pick one — the whole point of the rejection is that we refuse to guess
 * whose codebase this is — it is accepted only when the install has exactly one
 * workspace with Linear connected. Two candidates and the comment is skipped:
 * the human still sees the issue unassigned, which is a worse experience than a
 * comment and a far better one than a comment posted by another company's
 * Linear token.
 */
async function resolveActor(organizationId: string | null): Promise<Actor | null> {
  const resolved = organizationId ?? (await soleLinearWorkspace());
  if (!resolved) return null;

  const hit = cachedActors.get(resolved);
  if (hit) return hit;
  const db = getOrgScopedClient(resolved);

  const { data: agent } = await db.from('agents').select('id').eq('slug', 'cortex').maybeSingle();
  const agentId = agent?.id as string | undefined;
  if (!agentId) {
    logger.error('dev-tasks: no "cortex" agent row — cannot post to Linear');
    return null;
  }

  const configured = process.env.CORTEX_LINEAR_ACTOR_EMAIL?.trim().toLowerCase();
  if (configured) {
    const { data: user } = await db
      .from('users')
      .select('id')
      .ilike(
        'email',
        configured.replace(/[%_]/g, (m) => `\\${m}`),
      )
      .maybeSingle();
    if (user?.id) {
      const actor = { organizationId: resolved, userId: user.id as string, agentId };
      cachedActors.set(resolved, actor);
      return actor;
    }
    logger.warn(`dev-tasks: CORTEX_LINEAR_ACTOR_EMAIL "${configured}" matches no Cortex user`);
  }

  const { data: integration } = await db
    .from('integrations')
    .select('user_id')
    .eq('provider', 'linear')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!integration?.user_id) {
    logger.error('dev-tasks: nobody has connected Linear — cannot post to Linear');
    return null;
  }
  const actor = { organizationId: resolved, userId: integration.user_id as string, agentId };
  cachedActors.set(resolved, actor);
  return actor;
}

/**
 * The one workspace that has Linear connected, or null when zero or several do.
 * Unscoped by necessity: the question is precisely "is there exactly one
 * candidate", which no single-workspace query could answer.
 */
async function soleLinearWorkspace(): Promise<string | null> {
  const { data } = await getSupabaseServiceClient()
    .from('integrations')
    .select('organization_id')
    .eq('provider', 'linear')
    .limit(50);
  const workspaces = new Set(
    ((data ?? []) as Array<{ organization_id: string }>).map((r) => r.organization_id),
  );
  if (workspaces.size !== 1) {
    logger.warn(
      `dev-tasks: ${workspaces.size} workspaces have Linear connected — refusing to guess whose issue this is`,
    );
    return null;
  }
  return [...workspaces][0] ?? null;
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
  organizationId: string | null = null,
): Promise<boolean> {
  try {
    const actor = await resolveActor(organizationId);
    if (!actor) return false;
    const tool = getTool('linear.create_comment');
    if (!tool) {
      logger.error('dev-tasks: linear.create_comment is not registered');
      return false;
    }
    const ctx = buildToolContext({
      organizationId: actor.organizationId,
      userId: actor.userId,
      agentId: actor.agentId,
    });
    await runTool(tool, { issueId, body }, ctx, { confirmed: true });
    return true;
  } catch (err) {
    logger.error('dev-tasks: could not comment on the Linear issue', {
      issueId,
      error: (err as Error).message,
    });
    return false;
  }
}

/** Exposed for tests and for the rare case where the actor changes at runtime. */
export function resetLinearActorCache(): void {
  cachedActors.clear();
}
