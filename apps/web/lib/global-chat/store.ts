import 'server-only';
import { randomUUID } from 'node:crypto';
import { pool } from '@/lib/auth';
import { listMemberships } from '@/lib/organization';
import { assertWorkspaceScope, normalizedWorkspaceIds, sameWorkspaceScope } from './scope';

export interface GlobalMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}
export interface GlobalConversation {
  id: string;
  account_id: string;
  workspace_ids: string[];
  title: string;
  messages: GlobalMessage[];
  updated_at: string;
}

export async function readGlobalConversation(accountId: string, id: string) {
  const { rows } = await pool.query<GlobalConversation>(
    'select id, account_id, workspace_ids, title, messages, updated_at from public.global_conversations where id=$1 and account_id=$2',
    [id, accountId],
  );
  if (!rows[0]) throw new Error('Conversación no disponible.');
  const memberships = await listMemberships(accountId);
  assertWorkspaceScope(
    rows[0].workspace_ids,
    memberships.map((m) => m.id),
  );
  return rows[0];
}

export async function listGlobalConversations(accountId: string) {
  // Do not even return titles of histories whose source access was removed.
  const { rows } = await pool.query(
    `select c.id, c.title, c.workspace_ids as "workspaceIds", c.updated_at as "updatedAt"
     from public.global_conversations c where c.account_id=$1
     and not exists (select 1 from unnest(c.workspace_ids) w(id) where not exists
       (select 1 from public.ba_member m where m."userId"=$1 and m."organizationId"=w.id))
     order by c.updated_at desc limit 50`,
    [accountId],
  );
  return rows;
}

export async function startGlobalTurn(
  accountId: string,
  workspaceIds: string[],
  message: string,
  id?: string,
) {
  const memberships = await listMemberships(accountId);
  const scope = normalizedWorkspaceIds(workspaceIds);
  assertWorkspaceScope(
    scope,
    memberships.map((m) => m.id),
  );
  const lease = randomUUID();
  const userMessage: GlobalMessage = { id: randomUUID(), role: 'user', content: message };
  if (!id) {
    const { rows } = await pool.query<GlobalConversation>(
      `insert into public.global_conversations(account_id,workspace_ids,title,messages,lease_id,lease_at)
       values($1,$2,$3,$4::jsonb,$5,now()) returning *`,
      [accountId, scope, message.slice(0, 100), JSON.stringify([userMessage]), lease],
    );
    if (!rows[0]) throw new Error('No se pudo crear la conversación.');
    return { conversation: rows[0], lease };
  }
  const current = await readGlobalConversation(accountId, id);
  if (!sameWorkspaceScope(current.workspace_ids, scope))
    throw new Error('Inicia otra conversación para cambiar los espacios consultados.');
  if (current.messages.length >= 100)
    throw new Error('Esta conversación llegó a su límite. Inicia otra para continuar.');
  const { rows } = await pool.query<GlobalConversation>(
    `update public.global_conversations set messages=messages || $3::jsonb, lease_id=$4, lease_at=now(), updated_at=now()
     where id=$1 and account_id=$2 and (lease_id is null or lease_at < now()-interval '6 minutes') returning *`,
    [id, accountId, JSON.stringify([userMessage]), lease],
  );
  if (!rows[0]) throw new Error('Cortex ya está respondiendo en esta conversación.');
  return { conversation: rows[0], lease };
}

export async function finishGlobalTurn(
  accountId: string,
  id: string,
  lease: string,
  text?: string,
) {
  if (text) await readGlobalConversation(accountId, id); // membership is rechecked before retaining new data
  const message: GlobalMessage[] = text
    ? [{ id: randomUUID(), role: 'assistant', content: text.slice(0, 60000) }]
    : [];
  const saved = await pool.query(
    `update public.global_conversations set messages=messages || $4::jsonb,
    lease_id=null,lease_at=null,updated_at=now() where id=$1 and account_id=$2 and lease_id=$3
    and ($5::boolean = false or not exists (select 1 from unnest(workspace_ids) w(id)
      where not exists(select 1 from public.ba_member m where m."userId"=$2 and m."organizationId"=w.id))) returning id`,
    [id, accountId, lease, JSON.stringify(message), Boolean(text)],
  );
  if (text && !saved.rows.length)
    throw new Error(
      'No se guardó la respuesta porque la sesión de ejecución o los permisos cambiaron.',
    );
}
