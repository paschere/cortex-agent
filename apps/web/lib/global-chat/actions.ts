import 'server-only';
import { pool } from '@/lib/auth';
import { globalWorkspaceContext } from '@/lib/global-chat/context';
import { readGlobalConversation } from '@/lib/global-chat/store';
import { listMemberships } from '@/lib/organization';
import { deniedToolPatterns, isToolDenied } from '@/lib/tool-access';
import { type AnyTool, getTool, runTool, toolIdAllowed } from '@cortex/agent-tools';
import { ConfirmationRequiredError, RateLimitError, SecurityBlockedError } from '@cortex/core';

const CURATED_GLOBAL_ACTION_TOOLS = new Set([
  'errands.start',
  'commitments.record',
  'goals.set',
  'payments.record',
  'clients.register',
]);

/** Explicit first-release boundary used by discovery and execution alike. */
export function isGlobalActionTool(def: AnyTool): boolean {
  return def.requiresConfirmation === true || CURATED_GLOBAL_ACTION_TOOLS.has(def.id);
}

export type GlobalActionState =
  | 'pending'
  | 'executing'
  | 'succeeded'
  | 'failed'
  | 'uncertain'
  | 'rejected';
export interface GlobalActionProposal {
  id: string;
  conversationId: string;
  workspaceId: string;
  workspaceName: string;
  toolId: string;
  input: unknown;
  state: GlobalActionState;
  sourceWorkspaceIds: string[];
  createdAt: string;
  decidedAt?: string | null;
  result?: unknown;
  error?: string | null;
}
interface Row {
  id: string;
  conversation_id: string;
  workspace_id: string;
  workspace_name: string;
  tool_id: string;
  input: unknown;
  state: GlobalActionState;
  source_workspace_ids: string[];
  created_at: Date | string;
  decided_at: Date | string | null;
  result: unknown;
  error: string | null;
}
const view = (r: Row): GlobalActionProposal => ({
  id: r.id,
  conversationId: r.conversation_id,
  workspaceId: r.workspace_id,
  workspaceName: r.workspace_name,
  toolId: r.tool_id,
  input: r.input,
  state: r.state,
  sourceWorkspaceIds: r.source_workspace_ids,
  createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
  decidedAt: r.decided_at instanceof Date ? r.decided_at.toISOString() : r.decided_at,
  result: r.result,
  error: r.error,
});

async function authorizedWrite(accountId: string, workspaceId: string, toolId: string) {
  const context = await globalWorkspaceContext(accountId, workspaceId);
  if (!['owner', 'admin'].includes(context.membership.role))
    throw new Error('Sólo propietarios y administradores pueden aprobar acciones globales.');
  if (!toolIdAllowed(context.agent.allowedTools, toolId))
    throw new Error('El agente de esta empresa no autoriza esa herramienta.');
  const denied = await deniedToolPatterns(context.db, context.ctx.userId, { failClosed: true });
  if (isToolDenied(toolId, denied)) throw new Error('Tu equipo bloqueó esta herramienta.');
  const def = getTool(toolId);
  if (!def || !isGlobalActionTool(def))
    throw new Error('Esta herramienta no está disponible como acción global.');
  return { ...context, def };
}

async function requireSourceOwners(accountId: string, sourceIds: string[]) {
  const memberships = await listMemberships(accountId);
  const byId = new Map(memberships.map((m) => [m.id, m]));
  if (sourceIds.some((id) => !byId.has(id)))
    throw new Error('Ya no tienes acceso a uno de los espacios fuente.');
  if (sourceIds.length > 1 && sourceIds.some((id) => byId.get(id)?.role !== 'owner'))
    throw new Error(
      'Para aprobar una acción con varias fuentes debes ser propietario actual de todos los espacios.',
    );
}

export async function prepareGlobalAction(input: {
  accountId: string;
  conversationId: string;
  workspaceId: string;
  toolId: string;
  input: unknown;
}): Promise<GlobalActionProposal> {
  const definition = getTool(input.toolId);
  if (!definition || !isGlobalActionTool(definition))
    throw new Error('Esta herramienta no está disponible como acción global.');
  const parsed = definition.inputSchema.safeParse(input.input);
  if (!parsed.success) throw new Error('La acción tiene campos inválidos o incompletos.');
  const serialized = JSON.stringify(parsed.data);
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > 14 * 1024)
    throw new Error('La acción supera el límite de 14 KB.');
  const conversation = await readGlobalConversation(input.accountId, input.conversationId);
  if (!conversation.workspace_ids.includes(input.workspaceId))
    throw new Error('La empresa destino no está seleccionada en esta conversación.');
  await requireSourceOwners(input.accountId, conversation.workspace_ids);
  const context = await authorizedWrite(input.accountId, input.workspaceId, input.toolId);
  const { rows } = await pool.query<Row>(
    `insert into public.global_action_proposals(account_id,conversation_id,workspace_id,workspace_name,source_workspace_ids,tool_id,input)
    values($1,$2,$3,$4,$5,$6,$7::jsonb) returning *`,
    [
      input.accountId,
      input.conversationId,
      input.workspaceId,
      context.membership.name,
      conversation.workspace_ids,
      input.toolId,
      serialized,
    ],
  );
  if (!rows[0]) throw new Error('No se pudo preparar la acción.');
  return view(rows[0]);
}

export async function listGlobalActions(
  accountId: string,
  conversationId: string,
): Promise<GlobalActionProposal[]> {
  const conversation = await readGlobalConversation(accountId, conversationId);
  await requireSourceOwners(accountId, conversation.workspace_ids);
  const { rows } = await pool.query<Row>(
    `select * from public.global_action_proposals where account_id=$1 and conversation_id=$2
    and not exists(select 1 from unnest(source_workspace_ids) s(id) where not exists(select 1 from public.ba_member m where m."userId"=$1 and m."organizationId"=s.id and (cardinality(source_workspace_ids)=1 or m.role='owner'))) order by created_at desc`,
    [accountId, conversationId],
  );
  return rows.map(view);
}

function limited(value: unknown): unknown {
  const text = JSON.stringify(value);
  if (text === undefined) return null;
  return Buffer.byteLength(text, 'utf8') <= 15000
    ? value
    : { truncated: true, excerpt: text.slice(0, 3000) };
}

function explicitToolFailure(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const result = value as Record<string, unknown>;
  if (result.ok !== false && result.__error !== true) return null;
  const detail = result.message ?? result.error ?? result.reason;
  return typeof detail === 'string'
    ? detail.slice(0, 1000)
    : 'La herramienta rechazó la acción sin realizarla.';
}
export async function decideGlobalAction(input: {
  accountId: string;
  proposalId: string;
  decision: 'approve' | 'reject';
}): Promise<GlobalActionProposal> {
  const { rows: currentRows } = await pool.query<Row>(
    'select * from public.global_action_proposals where id=$1 and account_id=$2',
    [input.proposalId, input.accountId],
  );
  const current = currentRows[0];
  if (!current) throw new Error('Propuesta no disponible.');
  await requireSourceOwners(input.accountId, current.source_workspace_ids);
  await authorizedWrite(input.accountId, current.workspace_id, current.tool_id);
  if (input.decision === 'reject') {
    const { rows } = await pool.query<Row>(
      `update public.global_action_proposals p set state='rejected',decided_at=now() where p.id=$1 and p.account_id=$2 and p.state='pending'
      and not exists(select 1 from unnest(p.source_workspace_ids) s(id) where not exists(select 1 from public.ba_member m where m."userId"=$2 and m."organizationId"=s.id and (cardinality(p.source_workspace_ids)=1 or m.role='owner'))) returning p.*`,
      [input.proposalId, input.accountId],
    );
    if (!rows[0]) throw new Error('La propuesta ya fue decidida.');
    return view(rows[0]);
  }
  const { rows: claimed } = await pool.query<Row>(
    `update public.global_action_proposals p set state='executing',decided_at=now() where p.id=$1 and p.account_id=$2 and p.state='pending'
    and not exists(select 1 from unnest(p.source_workspace_ids) s(id) where not exists(select 1 from public.ba_member m where m."userId"=$2 and m."organizationId"=s.id and (cardinality(p.source_workspace_ids)=1 or m.role='owner'))) returning p.*`,
    [input.proposalId, input.accountId],
  );
  const proposal = claimed[0];
  if (!proposal) throw new Error('La propuesta ya fue decidida o tus permisos cambiaron.');
  let context: Awaited<ReturnType<typeof authorizedWrite>>;
  try {
    context = await authorizedWrite(input.accountId, proposal.workspace_id, proposal.tool_id);
  } catch (error) {
    return finish(
      proposal.id,
      'failed',
      null,
      error instanceof Error ? error.message : 'Permisos cambiaron.',
    );
  }
  try {
    const result = await runTool(context.def, proposal.input, context.ctx, { confirmed: true });
    const failure = explicitToolFailure(result);
    if (failure) return finish(proposal.id, 'failed', limited(result), failure);
    return finish(proposal.id, 'succeeded', limited(result), null);
  } catch (error) {
    if (
      error instanceof SecurityBlockedError ||
      error instanceof RateLimitError ||
      error instanceof ConfirmationRequiredError
    ) {
      return finish(
        proposal.id,
        'failed',
        null,
        (error.message || 'La política de la empresa rechazó la acción.').slice(0, 1000),
      );
    }
    return finish(
      proposal.id,
      'uncertain',
      null,
      'La ejecución pudo haber alcanzado el sistema externo. Revisa el resultado antes de crear otra propuesta.',
    );
  }
}
async function finish(
  id: string,
  state: 'succeeded' | 'failed' | 'uncertain',
  result: unknown,
  error: string | null,
) {
  const { rows } = await pool.query<Row>(
    "update public.global_action_proposals set state=$2,result=$3::jsonb,error=$4,finished_at=now() where id=$1 and state='executing' returning *",
    [id, state, JSON.stringify(result), error],
  );
  if (!rows[0]) throw new Error('No se pudo guardar el desenlace.');
  return view(rows[0]);
}
