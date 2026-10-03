import { NotFoundError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  CONTRACT_COLUMNS,
  type ContractEventKind,
  type ContractEventRow,
  type ContractRow,
  type ContractStatus,
  type ContractType,
  EVENT_COLUMNS,
  OBLIGATION_COLUMNS,
  type ObligationRow,
  type ObligationStatus,
} from './shape';
import type { TemplateField } from './templates';

/**
 * Lecturas y escrituras de contratos (0195). `db` es SIEMPRE el handle de la
 * empresa (getOrgScopedClient): nada filtra por empresa a mano. Toda lectura
 * mira `error`: una lista vacía por una consulta caída se vería igual que «no
 * hay contratos».
 */

/** Las columnas de la lista: sin el texto del borrador, que puede pesar 100 KB. */
export const CONTRACT_LIST_COLUMNS = CONTRACT_COLUMNS.replace(', body_text', '');

export interface ListContractsOptions {
  statuses?: ContractStatus[];
  types?: ContractType[];
  clientId?: string;
  supplierId?: string;
  limit?: number;
}

export async function listContracts(
  db: SupabaseClient,
  opts: ListContractsOptions = {},
): Promise<ContractRow[]> {
  let q = db.from('contracts').select(CONTRACT_LIST_COLUMNS);
  if (opts.statuses?.length) q = q.in('status', opts.statuses);
  if (opts.types?.length) q = q.in('contract_type', opts.types);
  if (opts.clientId) q = q.eq('client_id', opts.clientId);
  if (opts.supplierId) q = q.eq('supplier_id', opts.supplierId);
  const { data, error } = await q
    .order('updated_at', { ascending: false })
    .limit(opts.limit ?? 500);
  if (error) throw error;
  return ((data ?? []) as unknown as Omit<ContractRow, 'body_text'>[]).map((r) => ({
    ...r,
    body_text: null,
  }));
}

export async function getContract(db: SupabaseClient, id: string): Promise<ContractRow | null> {
  const { data, error } = await db
    .from('contracts')
    .select(CONTRACT_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return (data as ContractRow | null) ?? null;
}

export async function requireContract(db: SupabaseClient, id: string): Promise<ContractRow> {
  const row = await getContract(db, id);
  if (!row) throw new NotFoundError('Ese contrato ya no existe.');
  return row;
}

export type ContractInsert = Partial<Omit<ContractRow, 'id' | 'created_at' | 'updated_at'>> &
  Pick<ContractRow, 'contract_type' | 'title'>;

export async function insertContract(
  db: SupabaseClient,
  row: ContractInsert,
): Promise<ContractRow> {
  const { data, error } = await db.from('contracts').insert(row).select(CONTRACT_COLUMNS).single();
  if (error) throw error;
  return data as ContractRow;
}

export async function updateContract(
  db: SupabaseClient,
  id: string,
  patch: Partial<Omit<ContractRow, 'id' | 'created_at'>>,
): Promise<ContractRow> {
  const { data, error } = await db
    .from('contracts')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select(CONTRACT_COLUMNS)
    .single();
  if (error) throw error;
  return data as ContractRow;
}

// ---------------------------------------------------------------------------
// Obligaciones
// ---------------------------------------------------------------------------

export interface ListObligationsOptions {
  contractId?: string;
  statuses?: ObligationStatus[];
  dueBefore?: string;
  limit?: number;
}

export async function listObligations(
  db: SupabaseClient,
  opts: ListObligationsOptions = {},
): Promise<ObligationRow[]> {
  let q = db.from('contract_obligations').select(OBLIGATION_COLUMNS);
  if (opts.contractId) q = q.eq('contract_id', opts.contractId);
  if (opts.statuses?.length) q = q.in('status', opts.statuses);
  if (opts.dueBefore) q = q.lte('due_on', opts.dueBefore);
  const { data, error } = await q
    .order('due_on', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: true })
    .limit(opts.limit ?? 500);
  if (error) throw error;
  return (data ?? []) as ObligationRow[];
}

export async function getObligation(db: SupabaseClient, id: string): Promise<ObligationRow | null> {
  const { data, error } = await db
    .from('contract_obligations')
    .select(OBLIGATION_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return (data as ObligationRow | null) ?? null;
}

export async function insertObligations(
  db: SupabaseClient,
  rows: Array<
    Partial<ObligationRow> & Pick<ObligationRow, 'contract_id' | 'party' | 'description' | 'source'>
  >,
): Promise<ObligationRow[]> {
  if (rows.length === 0) return [];
  const { data, error } = await db
    .from('contract_obligations')
    .insert(rows)
    .select(OBLIGATION_COLUMNS);
  if (error) throw error;
  return (data ?? []) as ObligationRow[];
}

export async function updateObligation(
  db: SupabaseClient,
  id: string,
  patch: Partial<Omit<ObligationRow, 'id' | 'contract_id' | 'created_at'>>,
): Promise<ObligationRow> {
  const { data, error } = await db
    .from('contract_obligations')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select(OBLIGATION_COLUMNS)
    .single();
  if (error) throw error;
  return data as ObligationRow;
}

/** Volver a leer un contrato reemplaza lo que nadie ha confirmado todavía. */
export async function deletePendingReadObligations(
  db: SupabaseClient,
  contractId: string,
): Promise<void> {
  const { error } = await db
    .from('contract_obligations')
    .delete()
    .eq('contract_id', contractId)
    .eq('status', 'propuesta')
    .eq('source', 'documento');
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Línea de tiempo
// ---------------------------------------------------------------------------

export async function addContractEvent(
  db: SupabaseClient,
  input: {
    contractId: string;
    kind: ContractEventKind;
    detail?: string | null;
    actorUserId?: string | null;
  },
): Promise<void> {
  const { error } = await db.from('contract_events').insert({
    contract_id: input.contractId,
    kind: input.kind,
    detail: input.detail?.slice(0, 600) ?? null,
    actor_user_id: input.actorUserId ?? null,
  });
  if (error) throw error;
}

export async function listContractEvents(
  db: SupabaseClient,
  contractId: string,
): Promise<ContractEventRow[]> {
  const { data, error } = await db
    .from('contract_events')
    .select(EVENT_COLUMNS)
    .eq('contract_id', contractId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data ?? []) as ContractEventRow[];
}

// ---------------------------------------------------------------------------
// Plantillas propias
// ---------------------------------------------------------------------------

export interface CompanyTemplateRow {
  id: string;
  builtin_key: string | null;
  contract_type: ContractType;
  name: string;
  description: string | null;
  body: string;
  fields: TemplateField[];
  status: 'activa' | 'archivada';
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const TEMPLATE_COLUMNS =
  'id, builtin_key, contract_type, name, description, body, fields, status, created_by, created_at, updated_at';

export async function listCompanyTemplates(db: SupabaseClient): Promise<CompanyTemplateRow[]> {
  const { data, error } = await db
    .from('contract_templates')
    .select(TEMPLATE_COLUMNS)
    .eq('status', 'activa')
    .order('name', { ascending: true })
    .limit(100);
  if (error) throw error;
  return (data ?? []) as CompanyTemplateRow[];
}

export async function getCompanyTemplate(
  db: SupabaseClient,
  id: string,
): Promise<CompanyTemplateRow | null> {
  const { data, error } = await db
    .from('contract_templates')
    .select(TEMPLATE_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return (data as CompanyTemplateRow | null) ?? null;
}

export async function saveCompanyTemplate(
  db: SupabaseClient,
  input: {
    id?: string;
    builtinKey?: string | null;
    contractType: ContractType;
    name: string;
    description?: string | null;
    body: string;
    fields: TemplateField[];
    userId: string;
  },
): Promise<CompanyTemplateRow> {
  const row = {
    builtin_key: input.builtinKey ?? null,
    contract_type: input.contractType,
    name: input.name.trim(),
    description: input.description?.trim() || null,
    body: input.body,
    fields: input.fields,
    updated_at: new Date().toISOString(),
  };
  const query = input.id
    ? db.from('contract_templates').update(row).eq('id', input.id)
    : db.from('contract_templates').insert({ ...row, created_by: input.userId });
  const { data, error } = await query.select(TEMPLATE_COLUMNS).single();
  if (error) throw error;
  return data as CompanyTemplateRow;
}

// ---------------------------------------------------------------------------
// Nombres para la pantalla y el chat
// ---------------------------------------------------------------------------

/** Nombres de personas, clientes y proveedores por id, en tres lecturas. */
export async function loadContractNames(
  db: SupabaseClient,
  rows: Array<
    Pick<ContractRow, 'owner_user_id' | 'client_id' | 'supplier_id' | 'employee_user_id'>
  >,
): Promise<{
  people: Map<string, string>;
  clients: Map<string, string>;
  suppliers: Map<string, string>;
}> {
  const ids = (pick: (r: (typeof rows)[number]) => string | null) =>
    [...new Set(rows.map(pick).filter(Boolean))] as string[];
  const userIds = [...new Set([...ids((r) => r.owner_user_id), ...ids((r) => r.employee_user_id)])];
  const clientIds = ids((r) => r.client_id);
  const supplierIds = ids((r) => r.supplier_id);
  const [users, clients, suppliers] = await Promise.all([
    userIds.length ? db.from('users').select('id, name, email').in('id', userIds) : null,
    clientIds.length ? db.from('clients').select('id, name').in('id', clientIds) : null,
    supplierIds.length ? db.from('suppliers').select('id, name').in('id', supplierIds) : null,
  ]);
  if (users?.error) throw users.error;
  if (clients?.error) throw clients.error;
  if (suppliers?.error) throw suppliers.error;
  return {
    people: new Map(
      ((users?.data ?? []) as Array<{ id: string; name: string | null; email: string }>).map(
        (u) => [u.id, u.name?.trim() || u.email],
      ),
    ),
    clients: new Map(
      ((clients?.data ?? []) as Array<{ id: string; name: string }>).map((c) => [c.id, c.name]),
    ),
    suppliers: new Map(
      ((suppliers?.data ?? []) as Array<{ id: string; name: string }>).map((s) => [s.id, s.name]),
    ),
  };
}
