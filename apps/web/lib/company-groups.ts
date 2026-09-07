import 'server-only';

import { randomUUID } from 'node:crypto';
import { pool } from './auth';

export interface CompanyGroup {
  id: string;
  name: string;
  companies: Array<{ id: string; name: string }>;
}

export async function listCompanyGroups(accountId: string): Promise<CompanyGroup[]> {
  const { rows } = await pool.query<{
    id: string;
    name: string;
    organization_id: string | null;
    organization_name: string | null;
  }>(
    `select g.id, g.name, o.id as organization_id, o.name as organization_name
       from public.company_groups g
       join public.company_group_admins a on a.group_id=g.id and a.account_id=$1
       left join public.company_group_companies c on c.group_id=g.id
       left join public.ba_organization o on o.id=c.organization_id
       left join public.ba_member m on m."organizationId"=o.id and m."userId"=$1 and m.role='owner'
      where c.organization_id is null or m.id is not null
      order by g.name, o.name`,
    [accountId],
  );
  const groups = new Map<string, CompanyGroup>();
  for (const row of rows) {
    const group = groups.get(row.id) ?? { id: row.id, name: row.name, companies: [] };
    if (row.organization_id && row.organization_name)
      group.companies.push({ id: row.organization_id, name: row.organization_name });
    groups.set(row.id, group);
  }
  return [...groups.values()];
}

export async function listUngroupedOwnedCompanies(accountId: string) {
  const { rows } = await pool.query<{ id: string; name: string }>(
    `select o.id,o.name from public.ba_member m join public.ba_organization o on o.id=m."organizationId"
      left join public.company_group_companies c on c.organization_id=o.id
      where m."userId"=$1 and m.role='owner' and o.kind='company' and c.organization_id is null order by o.name`,
    [accountId],
  );
  return rows;
}

export async function createCompanyGroup(accountId: string, name: string) {
  const id = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      'insert into public.company_groups(id,name,created_by_account_id) values($1,$2,$3)',
      [id, name.trim(), accountId],
    );
    await client.query(
      'insert into public.company_group_admins(group_id,account_id) values($1,$2)',
      [id, accountId],
    );
    await client.query('commit');
    return id;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function addCompanyToGroup(
  accountId: string,
  groupId: string,
  organizationId: string,
) {
  const result = await pool.query(
    `insert into public.company_group_companies(group_id,organization_id,added_by_account_id)
     select $1,$2,$3 where exists(select 1 from public.company_group_admins where group_id=$1 and account_id=$3)
       and exists(select 1 from public.ba_member m join public.ba_organization o on o.id=m."organizationId" where o.id=$2 and o.kind='company' and m."userId"=$3 and m.role='owner')
     on conflict (organization_id) do nothing returning organization_id`,
    [groupId, organizationId, accountId],
  );
  return result.rowCount === 1;
}

export async function removeCompanyFromGroup(
  accountId: string,
  groupId: string,
  organizationId: string,
) {
  const result = await pool.query(
    `delete from public.company_group_companies c using public.company_group_admins a, public.ba_member m
      where c.group_id=$1 and c.organization_id=$2 and a.group_id=c.group_id and a.account_id=$3
        and m."organizationId"=c.organization_id and m."userId"=$3 and m.role='owner'`,
    [groupId, organizationId, accountId],
  );
  return result.rowCount === 1;
}
