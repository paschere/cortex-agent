import type { SupabaseClient } from '@supabase/supabase-js';
import type { Flow } from './types';

/**
 * Who may run a flow that carries the company's login.
 *
 * ---------------------------------------------------------------------------
 * THE QUESTION
 * ---------------------------------------------------------------------------
 * Running a flow with a credential attached means acting as the company inside
 * somebody else's system, and the person doing it never sees the password --
 * which is exactly why "anyone who knows the flow's name" is the wrong answer.
 * The credential's protection would otherwise be perfect at rest and worthless
 * in use: nobody needs to steal a password they can simply spend.
 *
 * ---------------------------------------------------------------------------
 * THE RULE
 * ---------------------------------------------------------------------------
 *   no credential          anyone in the workspace. The flow does what any of
 *                          them could do by opening the site themselves, so
 *                          gating it would be theatre that teaches people to
 *                          route around the gate.
 *
 *   credential, no grants  ORG ADMINS ONLY. This is the deliberate part: an
 *                          empty grant list is not "everybody", it is
 *                          "nobody has decided yet". Somebody attached a
 *                          company password to an errand and went home; the
 *                          safe reading of that is that they had not thought
 *                          about who else should spend it. Defaulting open
 *                          would make the decision by accident, once, for
 *                          every flow anybody ever creates.
 *
 *   credential + grants    admins, plus the people and roles named.
 *
 * Admins are always in, and that is a considered position rather than
 * laziness: an administrator can read `browser_credentials` through the admin
 * screens and can grant themselves anything in one click, so excluding them
 * would add a step to a bypass rather than a boundary. What the audit trail is
 * for is knowing that they did.
 */

export type AccessVerdict = { allowed: true } | { allowed: false; reason: string };

export interface Actor {
  id: string;
  role: string;
}

/**
 * `org_admin` is the role `requireSession` puts on a workspace owner or admin
 * (lib/session.ts); `owner` and `admin` are the raw better-auth membership
 * values, accepted so a caller that has one rather than the other is not
 * silently treated as an ordinary member. `team_admin` is deliberately absent:
 * a team lead administers a team, not the company's credentials.
 */
const ADMIN_ROLES = new Set(['org_admin', 'owner', 'admin']);

export function isAdmin(actor: Actor): boolean {
  return ADMIN_ROLES.has(actor.role.toLowerCase());
}

export async function canRunFlow(
  db: SupabaseClient,
  actor: Actor,
  flow: Pick<Flow, 'id' | 'name' | 'credentialId'>,
): Promise<AccessVerdict> {
  if (!flow.credentialId) return { allowed: true };
  if (isAdmin(actor)) return { allowed: true };

  const { data } = await db
    .from('browser_flow_grants')
    .select('subject_type, user_id, role')
    .eq('flow_id', flow.id);

  const grants =
    (data as { subject_type: string; user_id: string | null; role: string | null }[]) ?? [];
  if (grants.length === 0) {
    return {
      allowed: false,
      reason: `«${flow.name}» usa una credencial de la empresa y todavía nadie ha dicho quién puede ejecutarlo. Pídele a un administrador que te dé acceso.`,
    };
  }

  const named = grants.some(
    (g) =>
      (g.subject_type === 'user' && g.user_id === actor.id) ||
      (g.subject_type === 'role' && (g.role ?? '').toLowerCase() === actor.role.toLowerCase()),
  );
  if (named) return { allowed: true };

  return {
    allowed: false,
    reason: `«${flow.name}» usa una credencial de la empresa y tu usuario no está en la lista de quienes pueden ejecutarlo.`,
  };
}

/** The people and roles named on a flow, for the screen. */
export async function listGrants(
  db: SupabaseClient,
  flowId: string,
): Promise<{ subjectType: 'user' | 'role'; userId: string | null; role: string | null }[]> {
  const { data } = await db
    .from('browser_flow_grants')
    .select('subject_type, user_id, role')
    .eq('flow_id', flowId);
  return ((data as Record<string, unknown>[]) ?? []).map((row) => ({
    subjectType: row.subject_type as 'user' | 'role',
    userId: (row.user_id as string | null) ?? null,
    role: (row.role as string | null) ?? null,
  }));
}

export async function grantAccess(
  db: SupabaseClient,
  flowId: string,
  subject: { type: 'user'; userId: string } | { type: 'role'; role: string },
  grantedBy: string,
): Promise<void> {
  await db.from('browser_flow_grants').insert({
    flow_id: flowId,
    subject_type: subject.type,
    user_id: subject.type === 'user' ? subject.userId : null,
    role: subject.type === 'role' ? subject.role : null,
    granted_by: grantedBy,
  });
}

export async function revokeAccess(
  db: SupabaseClient,
  flowId: string,
  subject: { type: 'user'; userId: string } | { type: 'role'; role: string },
): Promise<void> {
  const query = db.from('browser_flow_grants').delete().eq('flow_id', flowId);
  if (subject.type === 'user') await query.eq('user_id', subject.userId);
  else await query.eq('role', subject.role);
}
