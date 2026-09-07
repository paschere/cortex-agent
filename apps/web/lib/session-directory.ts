import 'server-only';
import type { Role } from '@cortex/core';
import { pool } from './auth';

/** One database statement: no cached HTTP read and no first-visit insert race. */
export async function resolveSessionDirectory(accountId: string, organizationId: string) {
  const { rows } = await pool.query<{ id: string; email: string; name: string | null; role: Role }>(
    `insert into public.users (organization_id, email, name, role)
     select m."organizationId", b.email, b.name,
       case when m.role in ('owner', 'admin') then 'org_admin' else 'member' end::public.user_role
     from public.ba_member m join public.ba_user b on b.id=m."userId"
     where m."userId"=$1 and m."organizationId"=$2
     on conflict (organization_id, lower(email)) do update set role=case
       when excluded.role='member' and public.users.role='team_admin' then public.users.role
       else excluded.role end
     returning id, email, name, role`,
    [accountId, organizationId],
  );
  // Only an absent current membership is an authorization failure. Database
  // failures propagate as operational errors instead of pretending access was revoked.
  return rows[0] ?? null;
}
