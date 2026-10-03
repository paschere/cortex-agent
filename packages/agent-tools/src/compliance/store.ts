import type { SupabaseClient } from '@supabase/supabase-js';
import {
  CASE_ACTION_COLUMNS,
  CASE_COLUMNS,
  type CaseActionRow,
  type CaseRow,
  type ComplianceProfile,
  ITEM_COLUMNS,
  type ItemRow,
  type ItemStatus,
  PQRS_COLUMNS,
  PROFILE_COLUMNS,
  type PqrsRow,
  type PqrsStatus,
  type ProfileRow,
  rowToProfile,
} from './shape';

/**
 * Lecturas y escrituras de cumplimiento (0195). `db` es SIEMPRE el handle de
 * la empresa (getOrgScopedClient). Toda lectura mira `error`: una lista vacía
 * por una consulta caída se vería igual que «todo al día».
 */

// ---------------------------------------------------------------------------
// Perfil
// ---------------------------------------------------------------------------

export async function readComplianceProfile(db: SupabaseClient): Promise<ComplianceProfile | null> {
  const { data, error } = await db
    .from('compliance_profiles')
    .select(PROFILE_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToProfile(data as ProfileRow) : null;
}

export async function writeComplianceProfile(
  db: SupabaseClient,
  patch: Record<string, unknown>,
  userId: string,
): Promise<ComplianceProfile> {
  const { data: current, error: readError } = await db
    .from('compliance_profiles')
    .select('id')
    .maybeSingle();
  if (readError) throw readError;
  const now = new Date().toISOString();
  const query = current
    ? db
        .from('compliance_profiles')
        .update({ ...patch, updated_by: userId, updated_at: now })
        .eq('id', (current as { id: string }).id)
    : db.from('compliance_profiles').insert({ ...patch, created_by: userId, updated_by: userId });
  const { data, error } = await query.select(PROFILE_COLUMNS).single();
  if (error) throw error;
  return rowToProfile(data as ProfileRow);
}

// ---------------------------------------------------------------------------
// Lista de cumplimiento
// ---------------------------------------------------------------------------

export async function listComplianceItems(
  db: SupabaseClient,
  opts: { statuses?: ItemStatus[]; limit?: number } = {},
): Promise<ItemRow[]> {
  let q = db.from('compliance_items').select(ITEM_COLUMNS);
  if (opts.statuses?.length) q = q.in('status', opts.statuses);
  const { data, error } = await q
    .order('area', { ascending: true })
    .order('due_on', { ascending: true, nullsFirst: false })
    .limit(opts.limit ?? 500);
  if (error) throw error;
  return (data ?? []) as ItemRow[];
}

export async function getComplianceItem(db: SupabaseClient, id: string): Promise<ItemRow | null> {
  const { data, error } = await db
    .from('compliance_items')
    .select(ITEM_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return (data as ItemRow | null) ?? null;
}

export async function insertComplianceItems(
  db: SupabaseClient,
  rows: Array<
    Partial<ItemRow> &
      Pick<ItemRow, 'item_key' | 'area' | 'title' | 'frequency'> & { created_by?: string | null }
  >,
): Promise<ItemRow[]> {
  if (rows.length === 0) return [];
  const { data, error } = await db.from('compliance_items').insert(rows).select(ITEM_COLUMNS);
  if (error) throw error;
  return (data ?? []) as ItemRow[];
}

export async function updateComplianceItem(
  db: SupabaseClient,
  id: string,
  patch: Partial<Omit<ItemRow, 'id' | 'created_at'>>,
): Promise<ItemRow> {
  const { data, error } = await db
    .from('compliance_items')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select(ITEM_COLUMNS)
    .single();
  if (error) throw error;
  return data as ItemRow;
}

// ---------------------------------------------------------------------------
// PQRS
// ---------------------------------------------------------------------------

export async function listPqrs(
  db: SupabaseClient,
  opts: { statuses?: PqrsStatus[]; limit?: number } = {},
): Promise<PqrsRow[]> {
  let q = db.from('pqrs').select(PQRS_COLUMNS);
  if (opts.statuses?.length) q = q.in('status', opts.statuses);
  const { data, error } = await q
    .order('received_at', { ascending: false })
    .limit(opts.limit ?? 500);
  if (error) throw error;
  return (data ?? []) as PqrsRow[];
}

export async function getPqrs(db: SupabaseClient, idOrRadicado: string): Promise<PqrsRow | null> {
  const byRadicado = /^PQRS-\d{4}-\d{6}$/i.test(idOrRadicado.trim());
  const { data, error } = await db
    .from('pqrs')
    .select(PQRS_COLUMNS)
    .eq(
      byRadicado ? 'radicado' : 'id',
      byRadicado ? idOrRadicado.trim().toUpperCase() : idOrRadicado,
    )
    .maybeSingle();
  if (error) throw error;
  return (data as PqrsRow | null) ?? null;
}

/** El siguiente consecutivo del año. La unicidad la garantiza el índice; quien inserta reintenta. */
export async function nextPqrsSeq(db: SupabaseClient, year: number): Promise<number> {
  const { data, error } = await db
    .from('pqrs')
    .select('seq')
    .eq('year', year)
    .order('seq', { ascending: false })
    .limit(1);
  if (error) throw error;
  return (((data ?? [])[0] as { seq: number } | undefined)?.seq ?? 0) + 1;
}

export async function insertPqrsRow(
  db: SupabaseClient,
  row: Record<string, unknown>,
): Promise<PqrsRow> {
  const { data, error } = await db.from('pqrs').insert(row).select(PQRS_COLUMNS).single();
  if (error) throw error;
  return data as PqrsRow;
}

export async function updatePqrsRow(
  db: SupabaseClient,
  id: string,
  patch: Partial<Omit<PqrsRow, 'id' | 'created_at'>>,
): Promise<PqrsRow> {
  const { data, error } = await db
    .from('pqrs')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select(PQRS_COLUMNS)
    .single();
  if (error) throw error;
  return data as PqrsRow;
}

// ---------------------------------------------------------------------------
// Procesos judiciales
// ---------------------------------------------------------------------------

export async function listLegalCases(
  db: SupabaseClient,
  opts: { limit?: number } = {},
): Promise<CaseRow[]> {
  const { data, error } = await db
    .from('legal_cases')
    .select(CASE_COLUMNS)
    .order('status', { ascending: true })
    .order('next_hearing_on', { ascending: true, nullsFirst: false })
    .limit(opts.limit ?? 300);
  if (error) throw error;
  return (data ?? []) as CaseRow[];
}

export async function getLegalCase(db: SupabaseClient, id: string): Promise<CaseRow | null> {
  const { data, error } = await db
    .from('legal_cases')
    .select(CASE_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return (data as CaseRow | null) ?? null;
}

export async function findLegalCaseByRadicado(
  db: SupabaseClient,
  radicado: string,
): Promise<CaseRow | null> {
  const { data, error } = await db
    .from('legal_cases')
    .select(CASE_COLUMNS)
    .eq('radicado', radicado)
    .maybeSingle();
  if (error) throw error;
  return (data as CaseRow | null) ?? null;
}

export async function insertLegalCase(
  db: SupabaseClient,
  row: Record<string, unknown>,
): Promise<CaseRow> {
  const { data, error } = await db.from('legal_cases').insert(row).select(CASE_COLUMNS).single();
  if (error) throw error;
  return data as CaseRow;
}

export async function updateLegalCase(
  db: SupabaseClient,
  id: string,
  patch: Record<string, unknown>,
): Promise<CaseRow> {
  const { data, error } = await db
    .from('legal_cases')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select(CASE_COLUMNS)
    .single();
  if (error) throw error;
  return data as CaseRow;
}

export async function listCaseActions(
  db: SupabaseClient,
  caseId: string,
): Promise<CaseActionRow[]> {
  const { data, error } = await db
    .from('legal_case_actions')
    .select(CASE_ACTION_COLUMNS)
    .eq('case_id', caseId)
    .order('action_on', { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data ?? []) as CaseActionRow[];
}

export async function insertCaseAction(
  db: SupabaseClient,
  row: {
    case_id: string;
    action_on: string;
    text: string;
    source: 'manual' | 'rama_judicial';
    created_by: string | null;
  },
): Promise<CaseActionRow> {
  const { data, error } = await db
    .from('legal_case_actions')
    .insert(row)
    .select(CASE_ACTION_COLUMNS)
    .single();
  if (error) throw error;
  return data as CaseActionRow;
}
