import 'server-only';
import { buildToolContext } from '@/lib/agent';
import { pool } from '@/lib/auth';
import { listMemberships } from '@/lib/organization';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { deniedToolPatterns, isToolDenied } from '@/lib/tool-access';
import { getTool, toolIdAllowed } from '@cortex/agent-tools';
import { loadAgent } from '@cortex/agents';
import { globalToolAllowed } from './scope';

export async function globalWorkspaceContext(accountId: string, organizationId: string) {
  const memberships = await listMemberships(accountId);
  const membership = memberships.find((m) => m.id === organizationId);
  if (!membership) throw new Error('Ya no tienes acceso a esta empresa.');
  // Lazy directory provision remains guarded by current membership in SQL, too.
  await pool.query(
    `insert into public.users(organization_id,email,name,role)
    select m."organizationId",b.email,b.name,case when m.role in ('owner','admin') then 'org_admin' else 'member' end::public.user_role
    from public.ba_member m join public.ba_user b on b.id=m."userId"
    where m."userId"=$1 and m."organizationId"=$2
    on conflict (organization_id, lower(email)) do update set role=case
      when excluded.role='member' and public.users.role='team_admin' then public.users.role
      else excluded.role end`,
    [accountId, organizationId],
  );
  const { rows } = await pool.query<{ id: string }>(
    `select u.id from public.users u
    join public.ba_user b on lower(b.email)=lower(u.email)
    join public.ba_member m on m."userId"=b.id and m."organizationId"=u.organization_id
    where b.id=$1 and u.organization_id=$2`,
    [accountId, organizationId],
  );
  if (!rows[0]) throw new Error('No se pudo resolver tu acceso a la empresa.');
  const db = getOrgScopedClient(membership.id);
  const agent = await loadAgent(db, 'cortex');
  const ctx = buildToolContext({
    organizationId: membership.id,
    userId: rows[0].id,
    agentId: agent.id,
  });
  return { membership, db, agent, ctx };
}

export async function authorizedGlobalTool(
  accountId: string,
  organizationId: string,
  toolId: string,
) {
  const context = await globalWorkspaceContext(accountId, organizationId);
  if (
    !globalToolAllowed(toolId, context.membership.role) ||
    !toolIdAllowed(context.agent.allowedTools, toolId)
  )
    throw new Error('Esta herramienta no está autorizada en este espacio.');
  const denied = await deniedToolPatterns(context.db, context.ctx.userId, { failClosed: true });
  if (isToolDenied(toolId, denied))
    throw new Error('Tu equipo no tiene acceso a esta herramienta.');
  const def = getTool(toolId);
  if (!def) throw new Error('Herramienta no disponible.');
  return { ...context, def };
}
