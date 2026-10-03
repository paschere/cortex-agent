import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { findClientByName, getClient } from '../clients/store';
import { personLabel } from '../directory/line';
import { listDirectory } from '../directory/store';
import { findProduct } from '../inventory/products';
import { findLocation, recordMovements } from '../inventory/stock';
import { documentNumber } from '../sales/shape';
import type { SalesDocumentRow } from '../sales/shape';
import {
  createSalesDocument,
  getSalesDocumentRow,
  getSalesLines,
  prepareInvoice,
} from '../sales/store';
import {
  type ProjectMetrics,
  projectMetrics,
  resolveRate,
  weekStartOf,
  weekTimesheet,
} from './math';
import type { Timesheet } from './math';
import {
  COST_COLUMNS,
  type CostKind,
  MILESTONE_COLUMNS,
  type MilestoneRow,
  PROJECT_COLUMNS,
  type ProjectCostRow,
  type ProjectKind,
  type ProjectRow,
  ProjectStateError,
  type ProjectStatus,
  RATE_COLUMNS,
  type RateRow,
  TIME_COLUMNS,
  type TimeEntryRow,
  canMoveProject,
  num,
  numOrNull,
  parseProjectNumber,
  projectCode,
  round,
} from './shape';

/**
 * EL ALMACÉN DE PROYECTOS (migración 0196).
 *
 * `db` es siempre un handle con alcance de empresa (getOrgScopedClient /
 * ctx.db): nada de aquí filtra por `organization_id` a mano y toda escritura
 * la estampa el handle.
 *
 * Las tareas son filas de `work_items` con `project_id` (el registro de trabajo
 * es el único sistema de tareas); las horas, `time_entries`; los costos,
 * `project_costs` más las salidas de inventario con `project_id`; lo facturado,
 * las facturas de ventas que salen del pedido atado o de los hitos.
 */

export class ProjectInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectInputError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IN_CHUNK = 100;

function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505';
}

// ---------------------------------------------------------------------------
// Leer proyectos
// ---------------------------------------------------------------------------

export interface ProjectListFilter {
  statuses?: readonly ProjectStatus[];
  clientId?: string | null;
  search?: string | null;
  limit?: number;
}

export async function listProjects(
  db: SupabaseClient,
  filter: ProjectListFilter = {},
): Promise<ProjectRow[]> {
  let q = db.from('projects').select(PROJECT_COLUMNS);
  if (filter.statuses?.length) q = q.in('status', [...filter.statuses]);
  if (filter.clientId) q = q.eq('client_id', filter.clientId);
  if (filter.search?.trim()) {
    const s = filter.search.trim().replace(/[%,()]/g, ' ');
    q = q.or(`title.ilike.%${s}%,code.ilike.%${s}%,client_name.ilike.%${s}%`);
  }
  const { data, error } = await q.order('number', { ascending: false }).limit(filter.limit ?? 500);
  if (error) throw error;
  return (data ?? []) as unknown as ProjectRow[];
}

export async function getProjectRow(db: SupabaseClient, id: string): Promise<ProjectRow | null> {
  const { data, error } = await db
    .from('projects')
    .select(PROJECT_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return (data as unknown as ProjectRow | null) ?? null;
}

/** Por id, por código («OS-0007», «PRY 12») o por nombre (si hay uno solo). */
export async function findProject(
  db: SupabaseClient,
  ref: string,
): Promise<{ project: ProjectRow | null; candidates: ProjectRow[] }> {
  const clean = ref.trim();
  if (UUID_RE.test(clean)) {
    const p = await getProjectRow(db, clean);
    return { project: p, candidates: p ? [p] : [] };
  }
  const n = parseProjectNumber(clean);
  if (n !== null) {
    const { data, error } = await db
      .from('projects')
      .select(PROJECT_COLUMNS)
      .eq('number', n)
      .maybeSingle();
    if (error) throw error;
    if (data) return { project: data as unknown as ProjectRow, candidates: [] };
  }
  const found = await listProjects(db, { search: clean, limit: 10 });
  const exact = found.filter((p) => p.title.trim().toLowerCase() === clean.toLowerCase());
  if (exact.length === 1) return { project: exact[0] as ProjectRow, candidates: exact };
  return { project: found.length === 1 ? (found[0] as ProjectRow) : null, candidates: found };
}

export async function requireProject(db: SupabaseClient, ref: string): Promise<ProjectRow> {
  const { project, candidates } = await findProject(db, ref);
  if (project) return project;
  throw new ProjectInputError(
    candidates.length > 1
      ? `Hay varios proyectos que coinciden: ${candidates
          .slice(0, 5)
          .map((c) => `${c.code} ${c.title}`)
          .join(', ')}. ¿Cuál?`
      : `No encontré el proyecto «${ref}».`,
  );
}

// ---------------------------------------------------------------------------
// Crear
// ---------------------------------------------------------------------------

export interface ProjectInput {
  kind?: ProjectKind;
  title: string;
  description?: string | null;
  status?: ProjectStatus;
  clientId?: string | null;
  clientName?: string | null;
  ownerId?: string | null;
  currency?: string;
  budgetAmount?: number | null;
  budgetHours?: number | null;
  contractAmount?: number | null;
  startOn?: string | null;
  dueOn?: string | null;
  quoteId?: string | null;
  salesOrderId?: string | null;
  contractId?: string | null;
  opportunityId?: string | null;
  origin?: 'manual' | 'cotizacion' | 'pedido' | 'oportunidad' | 'chat';
  teamIds?: string[];
  location?: string | null;
  notes?: string | null;
  /** Tareas iniciales: van al registro de trabajo con `project_id`. */
  tasks?: Array<{ title: string; assigneeId?: string | null; dueOn?: string | null }>;
  milestones?: Array<{ title: string; amount: number; dueOn?: string | null }>;
}

async function nextNumber(db: SupabaseClient): Promise<number> {
  const { data, error } = await db
    .from('projects')
    .select('number')
    .order('number', { ascending: false })
    .limit(1);
  if (error) throw error;
  return num((data?.[0] as { number?: number } | undefined)?.number) + 1;
}

async function resolveClientFields(
  db: SupabaseClient,
  input: ProjectInput,
): Promise<{ client_id: string | null; client_name: string | null }> {
  if (input.clientId) {
    const c = await getClient(db, input.clientId);
    if (c) return { client_id: c.id, client_name: input.clientName?.trim() || c.name };
  }
  const name = input.clientName?.trim() || null;
  if (!name) return { client_id: null, client_name: null };
  const c = await findClientByName(db, name);
  return { client_id: c?.id ?? null, client_name: c?.name ?? name };
}

export async function createProject(
  db: SupabaseClient,
  input: ProjectInput,
  opts: { userId: string | null; today: string },
): Promise<ProjectRow> {
  const title = input.title.trim();
  if (!title) throw new ProjectInputError('Falta el nombre del proyecto.');
  if (input.startOn && input.dueOn && input.dueOn < input.startOn)
    throw new ProjectInputError('La fecha de entrega no puede ser antes del inicio.');
  const kind = input.kind ?? 'orden_servicio';
  const status = input.status ?? 'abierto';
  const client = await resolveClientFields(db, input);
  const base = {
    kind,
    title: title.slice(0, 200),
    description: input.description?.slice(0, 4000) ?? null,
    status,
    ...client,
    owner_id: input.ownerId ?? opts.userId,
    currency: input.currency ?? 'COP',
    budget_amount: input.budgetAmount ?? null,
    budget_hours: input.budgetHours ?? null,
    contract_amount: input.contractAmount ?? null,
    start_on: input.startOn ?? (status === 'cotizado' ? null : opts.today),
    due_on: input.dueOn ?? null,
    finished_on: ['terminado', 'facturado', 'cerrado'].includes(status) ? opts.today : null,
    quote_id: input.quoteId ?? null,
    sales_order_id: input.salesOrderId ?? null,
    contract_id: input.contractId ?? null,
    opportunity_id: input.opportunityId ?? null,
    origin: input.origin ?? 'manual',
    team_ids: input.teamIds ?? [],
    location: input.location ?? null,
    notes: input.notes ?? null,
    created_by: opts.userId,
  };
  let row: ProjectRow | null = null;
  for (let attempt = 0; attempt < 4 && !row; attempt++) {
    const number = await nextNumber(db);
    const { data, error } = await db
      .from('projects')
      .insert({ ...base, number, code: projectCode(kind, number) })
      .select(PROJECT_COLUMNS)
      .single();
    if (error) {
      // Otro creó el mismo número a la vez: se toma el siguiente.
      if (isUniqueViolation(error) && attempt < 3 && !String(error.message).includes('opportunity'))
        continue;
      throw error;
    }
    row = data as unknown as ProjectRow;
  }
  if (!row) throw new ProjectInputError('No pude numerar el proyecto; intenta de nuevo.');
  for (const t of input.tasks ?? []) await addProjectTask(db, row.id, t, opts.userId);
  if (input.milestones?.length) {
    const { error } = await db.from('project_milestones').insert(
      input.milestones.map((m, i) => ({
        project_id: row.id,
        position: i,
        title: m.title.slice(0, 200),
        amount: m.amount,
        due_on: m.dueOn ?? null,
      })),
    );
    if (error) throw error;
  }
  return row;
}

/** Lo que vale un documento de ventas antes de IVA (después de descuentos). */
export function preTaxAmount(doc: Pick<SalesDocumentRow, 'subtotal' | 'discount_total'>): number {
  return round(num(doc.subtotal) - num(doc.discount_total), 2);
}

/**
 * De una cotización o un pedido de ventas a una orden de servicio / proyecto:
 * el cliente, el valor del contrato (antes de IVA) y, si se pide, una tarea
 * por línea. Un pedido que ya tiene proyecto devuelve ese.
 */
export async function createProjectFromSalesDocument(
  db: SupabaseClient,
  doc: SalesDocumentRow,
  input: Partial<ProjectInput> & { tasksFromLines?: boolean },
  opts: { userId: string | null; today: string },
): Promise<{ project: ProjectRow; created: boolean }> {
  if (doc.kind === 'invoice')
    throw new ProjectInputError('Una factura no abre un proyecto: usa la cotización o el pedido.');
  const column = doc.kind === 'quote' ? 'quote_id' : 'sales_order_id';
  const { data: existing, error } = await db
    .from('projects')
    .select(PROJECT_COLUMNS)
    .eq(column, doc.id)
    .limit(1);
  if (error) throw error;
  if (existing?.[0]) return { project: existing[0] as unknown as ProjectRow, created: false };
  const lines = input.tasksFromLines ? await getSalesLines(db, doc.id) : [];
  const first = lines[0]?.description;
  const project = await createProject(
    db,
    {
      ...input,
      title: input.title?.trim() || `${first ?? 'Trabajo'} — ${doc.client_name}`.slice(0, 200),
      clientId: input.clientId ?? doc.client_id,
      clientName: input.clientName ?? doc.client_name,
      currency: doc.currency,
      contractAmount: input.contractAmount ?? preTaxAmount(doc),
      quoteId: doc.kind === 'quote' ? doc.id : (doc.source_id ?? null),
      salesOrderId: doc.kind === 'order' ? doc.id : null,
      origin: doc.kind === 'quote' ? 'cotizacion' : 'pedido',
      status:
        input.status ??
        (doc.kind === 'quote' && doc.status !== 'aceptada' ? 'cotizado' : 'abierto'),
      notes: input.notes ?? `Sale de ${documentNumber(doc)}.`,
      tasks: [
        ...(input.tasks ?? []),
        ...lines.map((l) => ({ title: String(l.description).slice(0, 300) })),
      ],
    },
    opts,
  );
  return { project, created: true };
}

/**
 * Para el embudo comercial (0193): una oportunidad ganada abre un proyecto.
 * Idempotente por `opportunityId` (índice único): llamarla dos veces devuelve
 * el mismo proyecto.
 */
export async function createProjectFromOpportunity(
  db: SupabaseClient,
  input: {
    opportunityId: string;
    title: string;
    clientId?: string | null;
    clientName?: string | null;
    amount?: number | null;
    ownerId?: string | null;
    dueOn?: string | null;
    kind?: ProjectKind;
    quoteId?: string | null;
  },
  opts: { userId: string | null; today: string },
): Promise<{ project: ProjectRow; created: boolean }> {
  const find = async () => {
    const { data, error } = await db
      .from('projects')
      .select(PROJECT_COLUMNS)
      .eq('opportunity_id', input.opportunityId)
      .maybeSingle();
    if (error) throw error;
    return (data as unknown as ProjectRow | null) ?? null;
  };
  const prior = await find();
  if (prior) return { project: prior, created: false };
  try {
    const project = await createProject(
      db,
      {
        kind: input.kind ?? 'proyecto',
        title: input.title,
        clientId: input.clientId ?? null,
        clientName: input.clientName ?? null,
        contractAmount: input.amount ?? null,
        ownerId: input.ownerId ?? null,
        dueOn: input.dueOn ?? null,
        opportunityId: input.opportunityId,
        quoteId: input.quoteId ?? null,
        origin: 'oportunidad',
      },
      opts,
    );
    return { project, created: true };
  } catch (err) {
    if (isUniqueViolation(err)) {
      const again = await find();
      if (again) return { project: again, created: false };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Cambiar
// ---------------------------------------------------------------------------

export interface ProjectPatch {
  title?: string;
  description?: string | null;
  status?: ProjectStatus;
  ownerId?: string | null;
  budgetAmount?: number | null;
  budgetHours?: number | null;
  contractAmount?: number | null;
  startOn?: string | null;
  dueOn?: string | null;
  clientName?: string | null;
  location?: string | null;
  notes?: string | null;
  teamIds?: string[];
  kind?: ProjectKind;
}

export async function updateProject(
  db: SupabaseClient,
  id: string,
  patch: ProjectPatch,
  opts: { today: string },
): Promise<ProjectRow> {
  const current = await getProjectRow(db, id);
  if (!current) throw new ProjectInputError('Ese proyecto ya no existe.');
  const row: Record<string, unknown> = {};
  if (patch.title !== undefined) {
    if (!patch.title.trim()) throw new ProjectInputError('El nombre no puede quedar vacío.');
    row.title = patch.title.trim().slice(0, 200);
  }
  if (patch.status && patch.status !== current.status) {
    if (!canMoveProject(current.status, patch.status))
      throw new ProjectStateError(current.status, patch.status);
    row.status = patch.status;
    if (['terminado', 'facturado', 'cerrado'].includes(patch.status))
      row.finished_on = current.finished_on ?? opts.today;
    else row.finished_on = null;
    if (patch.status === 'en_curso' && !current.start_on) row.start_on = opts.today;
  }
  const map: Array<[keyof ProjectPatch, string]> = [
    ['description', 'description'],
    ['ownerId', 'owner_id'],
    ['budgetAmount', 'budget_amount'],
    ['budgetHours', 'budget_hours'],
    ['contractAmount', 'contract_amount'],
    ['startOn', 'start_on'],
    ['dueOn', 'due_on'],
    ['clientName', 'client_name'],
    ['location', 'location'],
    ['notes', 'notes'],
    ['teamIds', 'team_ids'],
    ['kind', 'kind'],
  ];
  for (const [k, col] of map) if (patch[k] !== undefined) row[col] = patch[k];
  if (!Object.keys(row).length) return current;
  const { data, error } = await db
    .from('projects')
    .update(row)
    .eq('id', id)
    .select(PROJECT_COLUMNS)
    .single();
  if (error) throw error;
  return data as unknown as ProjectRow;
}

// ---------------------------------------------------------------------------
// Tareas: el registro de trabajo con project_id
// ---------------------------------------------------------------------------

export const PROJECT_WORK_TYPE = 'proyecto';

export interface ProjectTask {
  id: string;
  title: string;
  status: 'open' | 'done' | 'cancelled';
  assigneeId: string | null;
  assigneeLabel: string | null;
  dueAt: string | null;
  doneAt: string | null;
  openedAt: string;
}

export async function addProjectTask(
  db: SupabaseClient,
  projectId: string,
  task: { title: string; assigneeId?: string | null; dueOn?: string | null },
  userId: string | null,
): Promise<ProjectTask> {
  const title = task.title.trim();
  if (!title) throw new ProjectInputError('La tarea necesita un nombre.');
  const { data, error } = await db
    .from('work_items')
    .insert({
      project_id: projectId,
      assignee_id: task.assigneeId ?? null,
      work_type: PROJECT_WORK_TYPE,
      title: title.slice(0, 300),
      status: 'open',
      opened_at: new Date().toISOString(),
      due_on: task.dueOn ?? null,
      source_kind: 'manual',
      source_system: 'proyecto',
      source_ref: `proyecto:${projectId}:${randomUUID()}`,
      recorded_by: userId,
    })
    .select('id, title, status, assignee_id, assignee_label, due_on, due_at, done_at, opened_at')
    .single();
  if (error) throw error;
  return adaptTask(data as Record<string, unknown>);
}

function adaptTask(r: Record<string, unknown>): ProjectTask {
  return {
    id: String(r.id),
    title: String(r.title),
    status: r.status as ProjectTask['status'],
    assigneeId: (r.assignee_id as string | null) ?? null,
    assigneeLabel: (r.assignee_label as string | null) ?? null,
    dueAt: ((r.due_at as string | null) ?? (r.due_on as string | null)) || null,
    doneAt: (r.done_at as string | null) ?? null,
    openedAt: String(r.opened_at ?? ''),
  };
}

export async function setProjectTaskStatus(
  db: SupabaseClient,
  taskId: string,
  status: 'open' | 'done' | 'cancelled',
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await db
    .from('work_items')
    .update({
      status,
      done_at: status === 'done' ? now : null,
      last_activity_at: now,
      updated_at: now,
    })
    .eq('id', taskId)
    .not('project_id', 'is', null);
  if (error) throw error;
}

async function tasksFor(db: SupabaseClient, ids: readonly string[]) {
  const out = new Map<string, ProjectTask[]>();
  for (const part of chunks(ids, IN_CHUNK)) {
    const { data, error } = await db
      .from('work_items')
      .select(
        'id, project_id, title, status, assignee_id, assignee_label, due_on, due_at, done_at, opened_at',
      )
      .in('project_id', part)
      .order('opened_at', { ascending: true });
    if (error) throw error;
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      const pid = String(r.project_id);
      const list = out.get(pid) ?? [];
      list.push(adaptTask(r));
      out.set(pid, list);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tarifas
// ---------------------------------------------------------------------------

export interface LaborRate {
  userId: string | null;
  costRate: number;
  billRate: number | null;
  source: 'manual' | 'nomina';
}

export async function listRates(db: SupabaseClient): Promise<LaborRate[]> {
  const { data, error } = await db.from('project_rates').select(RATE_COLUMNS);
  if (error) throw error;
  return ((data ?? []) as unknown as RateRow[]).map((r) => ({
    userId: r.user_id,
    costRate: num(r.cost_rate),
    billRate: numOrNull(r.bill_rate),
    source: r.source,
  }));
}

/**
 * Fija la tarifa por hora de una persona (o la de la empresa con `userId`
 * nulo). Nómina (0194) la llama con `source: 'nomina'` para que el costo por
 * hora salga de lo que de verdad se paga; una tarifa puesta a mano no la pisa
 * nómina salvo que se pida (`overrideManual`).
 */
export async function setLaborRate(
  db: SupabaseClient,
  input: {
    userId: string | null;
    costRate: number;
    billRate?: number | null;
    source?: 'manual' | 'nomina';
    overrideManual?: boolean;
  },
  updatedBy: string | null = null,
): Promise<LaborRate> {
  if (!(input.costRate >= 0))
    throw new ProjectInputError('La tarifa de costo no puede ser negativa.');
  const source = input.source ?? 'manual';
  let q = db.from('project_rates').select(RATE_COLUMNS);
  q = input.userId ? q.eq('user_id', input.userId) : q.is('user_id', null);
  const { data: prior, error } = await q.maybeSingle();
  if (error) throw error;
  const p = prior as unknown as RateRow | null;
  if (p && p.source === 'manual' && source === 'nomina' && !input.overrideManual)
    return {
      userId: p.user_id,
      costRate: num(p.cost_rate),
      billRate: numOrNull(p.bill_rate),
      source: p.source,
    };
  const row = {
    user_id: input.userId,
    cost_rate: round(input.costRate, 2),
    bill_rate: input.billRate === undefined ? (p ? numOrNull(p.bill_rate) : null) : input.billRate,
    source,
    updated_by: updatedBy,
  };
  const res = p
    ? await db.from('project_rates').update(row).eq('id', p.id).select(RATE_COLUMNS).single()
    : await db.from('project_rates').insert(row).select(RATE_COLUMNS).single();
  if (res.error) throw res.error;
  const r = res.data as unknown as RateRow;
  return {
    userId: r.user_id,
    costRate: num(r.cost_rate),
    billRate: numOrNull(r.bill_rate),
    source: r.source,
  };
}

// ---------------------------------------------------------------------------
// Horas
// ---------------------------------------------------------------------------

export interface TimeInput {
  projectId: string;
  userId?: string | null;
  personLabel?: string | null;
  workedOn: string;
  hours: number;
  billable?: boolean;
  workItemId?: string | null;
  note?: string | null;
}

export interface TimeEntry {
  id: string;
  projectId: string;
  workItemId: string | null;
  userId: string | null;
  personLabel: string | null;
  workedOn: string;
  hours: number;
  billable: boolean;
  costRate: number;
  billRate: number | null;
  note: string | null;
}

function adaptTime(r: TimeEntryRow): TimeEntry {
  return {
    id: r.id,
    projectId: r.project_id,
    workItemId: r.work_item_id,
    userId: r.user_id,
    personLabel: r.person_label,
    workedOn: String(r.worked_on).slice(0, 10),
    hours: num(r.hours),
    billable: !!r.billable,
    costRate: num(r.cost_rate),
    billRate: numOrNull(r.bill_rate),
    note: r.note,
  };
}

export async function logTime(
  db: SupabaseClient,
  input: TimeInput,
  opts: { recordedBy: string | null; today: string },
): Promise<TimeEntry> {
  if (!(input.hours > 0 && input.hours <= 24))
    throw new ProjectInputError('Las horas de un día van entre 0 y 24.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.workedOn))
    throw new ProjectInputError('La fecha va como AAAA-MM-DD.');
  if (input.workedOn > opts.today)
    throw new ProjectInputError('No se registran horas de días que no han pasado.');
  if (!input.userId && !input.personLabel?.trim())
    throw new ProjectInputError('Dime de quién son las horas.');
  const rate = resolveRate(await listRates(db), input.userId ?? null);
  const { data, error } = await db
    .from('time_entries')
    .insert({
      project_id: input.projectId,
      work_item_id: input.workItemId ?? null,
      user_id: input.userId ?? null,
      person_label: input.userId ? null : (input.personLabel?.trim().slice(0, 160) ?? null),
      worked_on: input.workedOn,
      hours: round(input.hours, 2),
      billable: input.billable ?? true,
      cost_rate: rate.costRate,
      bill_rate: rate.billRate,
      note: input.note?.slice(0, 500) ?? null,
      recorded_by: opts.recordedBy,
    })
    .select(TIME_COLUMNS)
    .single();
  if (error) throw error;
  return adaptTime(data as unknown as TimeEntryRow);
}

export async function deleteTimeEntry(
  db: SupabaseClient,
  id: string,
  by: { userId: string; manager: boolean },
): Promise<void> {
  const { data, error } = await db
    .from('time_entries')
    .select('id, user_id')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return;
  if (!by.manager && (data as { user_id: string | null }).user_id !== by.userId)
    throw new ProjectInputError('Sólo puedes borrar tus propias horas.');
  const del = await db.from('time_entries').delete().eq('id', id);
  if (del.error) throw del.error;
}

/** La semana de horas de una persona, con el nombre de cada proyecto. */
export async function personTimesheet(
  db: SupabaseClient,
  userId: string,
  day: string,
): Promise<Timesheet & { projects: Record<string, { code: string; title: string }> }> {
  const start = weekStartOf(day);
  const end = new Date(Date.parse(`${start}T00:00:00Z`) + 6 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const { data, error } = await db
    .from('time_entries')
    .select('project_id, worked_on, hours')
    .eq('user_id', userId)
    .gte('worked_on', start)
    .lte('worked_on', end);
  if (error) throw error;
  const entries = (
    (data ?? []) as Array<{ project_id: string; worked_on: string; hours: unknown }>
  ).map((r) => ({ projectId: r.project_id, workedOn: String(r.worked_on), hours: num(r.hours) }));
  const sheet = weekTimesheet(entries, start);
  const ids = sheet.rows.map((r) => r.projectId);
  const projects: Record<string, { code: string; title: string }> = {};
  for (const part of chunks(ids, IN_CHUNK)) {
    const res = await db.from('projects').select('id, code, title').in('id', part);
    if (res.error) throw res.error;
    for (const p of (res.data ?? []) as Array<{ id: string; code: string; title: string }>)
      projects[p.id] = { code: p.code, title: p.title };
  }
  return { ...sheet, projects };
}

// ---------------------------------------------------------------------------
// Costos y materiales
// ---------------------------------------------------------------------------

export interface ProjectCost {
  id: string;
  kind: CostKind;
  description: string;
  amount: number;
  incurredOn: string;
  counterparty: string | null;
  ledgerMovementId: string | null;
  source: string;
}

function adaptCost(r: ProjectCostRow): ProjectCost {
  return {
    id: r.id,
    kind: r.kind,
    description: r.description,
    amount: num(r.amount),
    incurredOn: String(r.incurred_on).slice(0, 10),
    counterparty: r.counterparty,
    ledgerMovementId: r.ledger_movement_id,
    source: r.source,
  };
}

export async function addProjectCost(
  db: SupabaseClient,
  input: {
    projectId: string;
    kind: CostKind;
    description: string;
    amount: number;
    incurredOn: string;
    counterparty?: string | null;
    source?: 'manual' | 'libro' | 'chat';
    ledgerMovementId?: string | null;
  },
  userId: string | null,
): Promise<ProjectCost> {
  if (!input.description.trim()) throw new ProjectInputError('Describe el costo.');
  if (!(input.amount >= 0)) throw new ProjectInputError('El valor no puede ser negativo.');
  const { data, error } = await db
    .from('project_costs')
    .insert({
      project_id: input.projectId,
      kind: input.kind,
      description: input.description.trim().slice(0, 300),
      amount: round(input.amount, 2),
      incurred_on: input.incurredOn,
      counterparty: input.counterparty?.slice(0, 200) ?? null,
      ledger_movement_id: input.ledgerMovementId ?? null,
      source: input.source ?? 'manual',
      created_by: userId,
    })
    .select(COST_COLUMNS)
    .single();
  if (error) {
    if (isUniqueViolation(error))
      throw new ProjectInputError('Ese gasto del libro ya está cargado a un proyecto.');
    throw error;
  }
  return adaptCost(data as unknown as ProjectCostRow);
}

/** Un gasto del libro de plata (0172), cargado al proyecto una sola vez. */
export async function linkLedgerExpense(
  db: SupabaseClient,
  projectId: string,
  ledgerMovementId: string,
  opts: { userId: string | null; kind?: CostKind },
): Promise<ProjectCost> {
  const { data, error } = await db
    .from('ledger_movements')
    .select('id, direction, kind, amount, date, description, counterparty_name, status')
    .eq('id', ledgerMovementId)
    .maybeSingle();
  if (error) throw error;
  const m = data as {
    id: string;
    direction: string;
    amount: unknown;
    date: string;
    description: string;
    counterparty_name: string | null;
    status: string;
  } | null;
  if (!m) throw new ProjectInputError('Ese movimiento del libro no existe.');
  if (m.direction !== 'out') throw new ProjectInputError('Sólo una salida de plata es un costo.');
  if (m.status === 'cancelled') throw new ProjectInputError('Ese movimiento está anulado.');
  return addProjectCost(
    db,
    {
      projectId,
      kind: opts.kind ?? 'gasto',
      description: m.description,
      amount: num(m.amount),
      incurredOn: String(m.date).slice(0, 10),
      counterparty: m.counterparty_name,
      ledgerMovementId: m.id,
      source: 'libro',
    },
    opts.userId,
  );
}

/** Gastos del libro sin proyecto, para atarlos desde la pantalla. */
export async function unassignedLedgerExpenses(
  db: SupabaseClient,
  opts: { since: string; limit?: number },
): Promise<
  Array<{
    id: string;
    date: string;
    description: string;
    amount: number;
    counterparty: string | null;
    category: string | null;
  }>
> {
  const { data, error } = await db
    .from('ledger_movements')
    .select('id, date, description, amount, counterparty_name, category')
    .eq('direction', 'out')
    .in('kind', ['expense', 'payable'])
    .neq('status', 'cancelled')
    .is('duplicate_of', null)
    .gte('date', opts.since)
    .order('date', { ascending: false })
    .limit(opts.limit ?? 60);
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    id: string;
    date: string;
    description: string;
    amount: unknown;
    counterparty_name: string | null;
    category: string | null;
  }>;
  const linked = new Set<string>();
  for (const part of chunks(
    rows.map((r) => r.id),
    IN_CHUNK,
  )) {
    const res = await db
      .from('project_costs')
      .select('ledger_movement_id')
      .in('ledger_movement_id', part);
    if (res.error) throw res.error;
    for (const r of (res.data ?? []) as Array<{ ledger_movement_id: string }>)
      linked.add(r.ledger_movement_id);
  }
  return rows
    .filter((r) => !linked.has(r.id))
    .map((r) => ({
      id: r.id,
      date: String(r.date).slice(0, 10),
      description: r.description,
      amount: num(r.amount),
      counterparty: r.counterparty_name,
      category: r.category,
    }));
}

/**
 * Sacar material del inventario para el proyecto: una salida del libro de
 * existencias (0183) al costo promedio vigente, marcada con `project_id`.
 */
export async function consumeMaterial(
  db: SupabaseClient,
  input: {
    projectId: string;
    product: string;
    qty: number;
    location?: string | null;
    note?: string | null;
  },
  opts: { userId: string | null; today: string },
): Promise<{ productName: string; qty: number; unit: string }> {
  if (!(input.qty > 0)) throw new ProjectInputError('La cantidad tiene que ser mayor que cero.');
  const project = await getProjectRow(db, input.projectId);
  if (!project) throw new ProjectInputError('Ese proyecto ya no existe.');
  const { product, candidates } = await findProduct(db, input.product);
  if (!product)
    throw new ProjectInputError(
      candidates.length > 1
        ? `Hay varios productos parecidos: ${candidates
            .slice(0, 5)
            .map((c) => c.name)
            .join(', ')}. ¿Cuál?`
        : `No encontré «${input.product}» en el inventario.`,
    );
  const location = input.location ? await findLocation(db, input.location) : null;
  if (input.location && !location)
    throw new ProjectInputError(`No hay una bodega «${input.location}».`);
  const key = `proyecto:${project.id}:${randomUUID()}`;
  await recordMovements(
    db,
    [
      {
        productId: product.id,
        locationId: location?.id ?? null,
        kind: 'salida',
        qty: input.qty,
        referenceKind: 'manual',
        referenceId: project.id,
        referenceLabel: `${project.code} ${project.title}`.slice(0, 200),
        note: input.note ?? null,
        dedupeKey: key,
      },
    ],
    { userId: opts.userId, today: opts.today },
  );
  const { error } = await db
    .from('stock_movements')
    .update({ project_id: project.id })
    .eq('dedupe_key', key);
  if (error) throw error;
  return { productName: product.name, qty: input.qty, unit: product.unit };
}

// ---------------------------------------------------------------------------
// Hitos y facturación
// ---------------------------------------------------------------------------

export interface Milestone {
  id: string;
  position: number;
  title: string;
  amount: number;
  dueOn: string | null;
  status: MilestoneRow['status'];
  salesDocumentId: string | null;
  invoicedAt: string | null;
}

function adaptMilestone(r: MilestoneRow): Milestone {
  return {
    id: r.id,
    position: r.position,
    title: r.title,
    amount: num(r.amount),
    dueOn: r.due_on,
    status: r.status,
    salesDocumentId: r.sales_document_id,
    invoicedAt: r.invoiced_at,
  };
}

export async function addMilestone(
  db: SupabaseClient,
  projectId: string,
  m: { title: string; amount: number; dueOn?: string | null },
): Promise<Milestone> {
  if (!m.title.trim()) throw new ProjectInputError('El hito necesita un nombre.');
  if (!(m.amount >= 0)) throw new ProjectInputError('El valor del hito no puede ser negativo.');
  const { data: last } = await db
    .from('project_milestones')
    .select('position')
    .eq('project_id', projectId)
    .order('position', { ascending: false })
    .limit(1);
  const { data, error } = await db
    .from('project_milestones')
    .insert({
      project_id: projectId,
      position: num((last?.[0] as { position?: number } | undefined)?.position) + 1,
      title: m.title.trim().slice(0, 200),
      amount: round(m.amount, 2),
      due_on: m.dueOn ?? null,
    })
    .select(MILESTONE_COLUMNS)
    .single();
  if (error) throw error;
  return adaptMilestone(data as unknown as MilestoneRow);
}

export interface InvoiceOutcome {
  invoiceId: string;
  invoiceLabel: string;
  amount: number;
  /** Ya existía (reintento): no se creó otra. */
  existed: boolean;
}

/**
 * Facturar un hito, o lo que falte del proyecto: un pedido con una línea y su
 * factura en BORRADOR en ventas (0182). Emitirla ante la DIAN sigue siendo
 * `sales.invoice_emit`, con aprobación. Con un pedido de ventas atado y sin
 * hitos, la factura sale de ese pedido.
 */
export async function invoiceProject(
  db: SupabaseClient,
  projectId: string,
  opts: { userId: string; today: string; milestoneId?: string | null; amount?: number | null },
): Promise<InvoiceOutcome> {
  const project = await getProjectRow(db, projectId);
  if (!project) throw new ProjectInputError('Ese proyecto ya no existe.');
  if (project.status === 'cancelado')
    throw new ProjectInputError('Un proyecto cancelado no se factura.');
  if (project.status === 'cotizado')
    throw new ProjectInputError('Todavía está cotizado: ábrelo antes de facturarlo.');

  let milestone: Milestone | null = null;
  if (opts.milestoneId) {
    const { data, error } = await db
      .from('project_milestones')
      .select(MILESTONE_COLUMNS)
      .eq('id', opts.milestoneId)
      .eq('project_id', projectId)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new ProjectInputError('Ese hito no es de este proyecto.');
    milestone = adaptMilestone(data as unknown as MilestoneRow);
    if (milestone.status === 'facturado' && milestone.salesDocumentId) {
      const inv = await getSalesDocumentRow(db, milestone.salesDocumentId);
      if (inv && inv.status !== 'anulada')
        return {
          invoiceId: inv.id,
          invoiceLabel: documentNumber(inv),
          amount: preTaxAmount(inv),
          existed: true,
        };
    }
    if (milestone.status === 'cancelado') throw new ProjectInputError('Ese hito está cancelado.');
  }

  // Todo el proyecto desde su pedido de ventas, cuando no hay hitos de por medio.
  if (!milestone && !opts.amount && project.sales_order_id) {
    const order = await getSalesDocumentRow(db, project.sales_order_id);
    if (order && order.status !== 'anulada') {
      const before = await db
        .from('sales_documents')
        .select('id')
        .eq('source_id', order.id)
        .eq('kind', 'invoice')
        .neq('status', 'anulada')
        .limit(1);
      if (before.error) throw before.error;
      const invoice = await prepareInvoice(db, order, opts.userId);
      return {
        invoiceId: invoice.id,
        invoiceLabel: documentNumber(invoice),
        amount: preTaxAmount(invoice),
        existed: !!before.data?.length,
      };
    }
  }

  let amount = milestone?.amount ?? opts.amount ?? null;
  if (amount === null) {
    const detail = await loadProjectDetail(db, projectId, opts.today);
    amount = detail?.metrics.revenue.unbilled ?? 0;
  }
  if (!(amount > 0))
    throw new ProjectInputError('No hay nada por facturar: dime el valor o agrega un hito.');
  if (!project.client_name)
    throw new ProjectInputError('El proyecto no tiene cliente: dime a quién se le factura.');

  const description = milestone
    ? `${project.code} · ${milestone.title}`
    : `${project.code} · ${project.title}`;
  const order = await createSalesDocument(
    db,
    'order',
    {
      clientId: project.client_id,
      clientName: project.client_name,
      currency: project.currency,
      notes: `Facturación de ${project.code} ${project.title}.`,
      lines: [
        { description: description.slice(0, 1000), quantity: 1, unitPrice: round(amount, 2) },
      ],
    },
    { userId: opts.userId, today: opts.today },
  );
  const invoice = await prepareInvoice(db, order, opts.userId);
  if (milestone) {
    const { error } = await db
      .from('project_milestones')
      .update({
        status: 'facturado',
        sales_document_id: invoice.id,
        invoiced_at: new Date().toISOString(),
      })
      .eq('id', milestone.id);
    if (error) throw error;
  } else {
    // Facturar «lo que falta» queda como un hito más, para que se sume siempre igual.
    const { data: last } = await db
      .from('project_milestones')
      .select('position')
      .eq('project_id', projectId)
      .order('position', { ascending: false })
      .limit(1);
    const { error } = await db.from('project_milestones').insert({
      project_id: projectId,
      position: num((last?.[0] as { position?: number } | undefined)?.position) + 1,
      title: 'Facturación',
      amount: round(amount, 2),
      status: 'facturado',
      sales_document_id: invoice.id,
      invoiced_at: new Date().toISOString(),
    });
    if (error) throw error;
  }
  return {
    invoiceId: invoice.id,
    invoiceLabel: documentNumber(invoice),
    amount: round(amount, 2),
    existed: false,
  };
}

// ---------------------------------------------------------------------------
// El detalle y el tablero
// ---------------------------------------------------------------------------

export interface ProjectSalesDoc {
  id: string;
  kind: SalesDocumentRow['kind'];
  label: string;
  status: string;
  amount: number;
  issueDate: string;
}

export interface ProjectDetail {
  project: ProjectRow;
  tasks: ProjectTask[];
  time: TimeEntry[];
  costs: ProjectCost[];
  materials: Array<{
    id: string;
    productId: string;
    qty: number;
    unitCost: number | null;
    occurredOn: string;
    productName: string;
    unit: string;
  }>;
  milestones: Milestone[];
  salesDocs: ProjectSalesDoc[];
  metrics: ProjectMetrics;
  names: Record<string, string>;
}

interface Bundle {
  tasks: Map<string, ProjectTask[]>;
  time: Map<string, TimeEntry[]>;
  costs: Map<string, ProjectCost[]>;
  materials: Map<string, ProjectDetail['materials']>;
  milestones: Map<string, Milestone[]>;
  docs: Map<string, ProjectSalesDoc[]>;
  /** Contrato de los proyectos sin valor propio: el del pedido/cotización atada. */
  contract: Map<string, number>;
}

function push<T>(map: Map<string, T[]>, key: string, value: T) {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

async function loadBundle(db: SupabaseClient, projects: readonly ProjectRow[]): Promise<Bundle> {
  const ids = projects.map((p) => p.id);
  const bundle: Bundle = {
    tasks: await tasksFor(db, ids),
    time: new Map(),
    costs: new Map(),
    materials: new Map(),
    milestones: new Map(),
    docs: new Map(),
    contract: new Map(),
  };
  for (const part of chunks(ids, IN_CHUNK)) {
    const [time, costs, mats, miles] = await Promise.all([
      db
        .from('time_entries')
        .select(TIME_COLUMNS)
        .in('project_id', part)
        .order('worked_on', { ascending: false }),
      db
        .from('project_costs')
        .select(COST_COLUMNS)
        .in('project_id', part)
        .order('incurred_on', { ascending: false }),
      db
        .from('stock_movements')
        .select('id, project_id, product_id, qty, unit_cost, occurred_on')
        .in('project_id', part)
        .order('occurred_on', { ascending: false }),
      db
        .from('project_milestones')
        .select(MILESTONE_COLUMNS)
        .in('project_id', part)
        .order('position'),
    ]);
    if (time.error) throw time.error;
    if (costs.error) throw costs.error;
    if (mats.error) throw mats.error;
    if (miles.error) throw miles.error;
    for (const r of (time.data ?? []) as unknown as TimeEntryRow[])
      push(bundle.time, r.project_id, adaptTime(r));
    for (const r of (costs.data ?? []) as unknown as ProjectCostRow[])
      push(bundle.costs, r.project_id, adaptCost(r));
    for (const r of (miles.data ?? []) as unknown as MilestoneRow[])
      push(bundle.milestones, r.project_id, adaptMilestone(r));
    const matRows = (mats.data ?? []) as Array<{
      id: string;
      project_id: string;
      product_id: string;
      qty: unknown;
      unit_cost: unknown;
      occurred_on: string;
    }>;
    const productIds = [...new Set(matRows.map((m) => m.product_id))];
    const names = new Map<string, { name: string; unit: string }>();
    for (const pp of chunks(productIds, IN_CHUNK)) {
      const res = await db.from('products').select('id, name, unit').in('id', pp);
      if (res.error) throw res.error;
      for (const p of (res.data ?? []) as Array<{ id: string; name: string; unit: string }>)
        names.set(p.id, { name: p.name, unit: p.unit });
    }
    for (const m of matRows)
      push(bundle.materials, m.project_id, {
        id: m.id,
        productId: m.product_id,
        qty: num(m.qty),
        unitCost: numOrNull(m.unit_cost),
        occurredOn: String(m.occurred_on).slice(0, 10),
        productName: names.get(m.product_id)?.name ?? 'Producto',
        unit: names.get(m.product_id)?.unit ?? 'und',
      });
  }

  // Documentos de ventas: el pedido/cotización atada, sus facturas y las de los hitos.
  const linked = new Map<string, string>(); // docId → projectId
  for (const p of projects) {
    if (p.sales_order_id) linked.set(p.sales_order_id, p.id);
    if (p.quote_id) linked.set(p.quote_id, p.id);
  }
  for (const [pid, list] of bundle.milestones)
    for (const m of list) if (m.salesDocumentId) linked.set(m.salesDocumentId, pid);
  const seen = new Set<string>();
  const addDoc = (pid: string, d: SalesDocumentRow) => {
    if (seen.has(`${pid}:${d.id}`)) return;
    seen.add(`${pid}:${d.id}`);
    push(bundle.docs, pid, {
      id: d.id,
      kind: d.kind,
      label: documentNumber(d),
      status: d.status,
      amount: preTaxAmount(d),
      issueDate: String(d.issue_date).slice(0, 10),
    });
  };
  const docIds = [...linked.keys()];
  for (const part of chunks(docIds, IN_CHUNK)) {
    const res = await db
      .from('sales_documents')
      .select(
        'id, kind, number, status, source_id, provider_number, subtotal, discount_total, issue_date',
      )
      .in('id', part);
    if (res.error) throw res.error;
    for (const d of (res.data ?? []) as unknown as SalesDocumentRow[])
      addDoc(linked.get(d.id) as string, d);
  }
  // Facturas que salieron del pedido (o de la cotización) atada.
  const sources = projects.flatMap(
    (p) => [p.sales_order_id, p.quote_id].filter(Boolean) as string[],
  );
  for (const part of chunks(sources, IN_CHUNK)) {
    const res = await db
      .from('sales_documents')
      .select(
        'id, kind, number, status, source_id, provider_number, subtotal, discount_total, issue_date',
      )
      .eq('kind', 'invoice')
      .in('source_id', part);
    if (res.error) throw res.error;
    for (const d of (res.data ?? []) as unknown as SalesDocumentRow[]) {
      const pid = linked.get(String(d.source_id));
      if (pid) addDoc(pid, d);
    }
  }
  for (const p of projects) {
    if (numOrNull(p.contract_amount) !== null) continue;
    const docs = bundle.docs.get(p.id) ?? [];
    const order = docs.find((d) => d.id === p.sales_order_id && d.status !== 'anulada');
    const quote = docs.find((d) => d.id === p.quote_id && d.status !== 'anulada');
    const base = order ?? quote;
    if (base) bundle.contract.set(p.id, base.amount);
  }
  return bundle;
}

function metricsFor(p: ProjectRow, b: Bundle, today: string): ProjectMetrics {
  const docs = b.docs.get(p.id) ?? [];
  const invoiced = docs
    .filter((d) => d.kind === 'invoice' && d.status !== 'anulada')
    .reduce((s, d) => s + d.amount, 0);
  return projectMetrics(
    {
      project: {
        status: p.status,
        budgetAmount: numOrNull(p.budget_amount),
        budgetHours: numOrNull(p.budget_hours),
        contractAmount: numOrNull(p.contract_amount) ?? b.contract.get(p.id) ?? null,
        dueOn: p.due_on,
        currency: p.currency,
      },
      tasks: b.tasks.get(p.id) ?? [],
      time: b.time.get(p.id) ?? [],
      costs: b.costs.get(p.id) ?? [],
      materials: b.materials.get(p.id) ?? [],
      invoiced,
      milestones: b.milestones.get(p.id) ?? [],
    },
    today,
  );
}

async function namesFor(db: SupabaseClient): Promise<Record<string, string>> {
  const people = await listDirectory(db);
  return Object.fromEntries(people.map((p) => [p.id, personLabel(p)]));
}

export async function loadProjectDetail(
  db: SupabaseClient,
  id: string,
  today: string,
): Promise<ProjectDetail | null> {
  const project = await getProjectRow(db, id);
  if (!project) return null;
  const [b, names] = await Promise.all([loadBundle(db, [project]), namesFor(db)]);
  return {
    project,
    tasks: b.tasks.get(id) ?? [],
    time: b.time.get(id) ?? [],
    costs: b.costs.get(id) ?? [],
    materials: b.materials.get(id) ?? [],
    milestones: b.milestones.get(id) ?? [],
    salesDocs: b.docs.get(id) ?? [],
    metrics: metricsFor(project, b, today),
    names,
  };
}

export interface ProjectSummary {
  project: ProjectRow;
  metrics: ProjectMetrics;
  ownerName: string | null;
}

/** Todos (o los filtrados) con su cuenta: el tablero, la lista y el piloto. */
export async function loadProjectsOverview(
  db: SupabaseClient,
  today: string,
  filter: ProjectListFilter = {},
): Promise<{ projects: ProjectSummary[]; names: Record<string, string> }> {
  const rows = await listProjects(db, filter);
  if (!rows.length) return { projects: [], names: {} };
  const [b, names] = await Promise.all([loadBundle(db, rows), namesFor(db)]);
  return {
    projects: rows.map((p) => ({
      project: p,
      metrics: metricsFor(p, b, today),
      ownerName: p.owner_id ? (names[p.owner_id] ?? null) : null,
    })),
    names,
  };
}

// ---------------------------------------------------------------------------
// Oportunidades ganadas del embudo (0193) que todavía no tienen proyecto
// ---------------------------------------------------------------------------

export interface WonOpportunity {
  id: string;
  title: string;
  clientId: string | null;
  clientName: string | null;
  value: number | null;
  currency: string;
  wonAt: string;
  quoteId: string | null;
  ownerId: string | null;
}

/**
 * Lo ganado en el embudo sin proyecto abierto, para ofrecer «abrir el
 * proyecto» con un clic. Si el embudo no está instalado todavía (su tabla no
 * existe), devuelve vacío: es un módulo que se construye a la vez.
 */
export async function wonOpportunitiesWithoutProject(
  db: SupabaseClient,
  opts: { limit?: number } = {},
): Promise<WonOpportunity[]> {
  const { data, error } = await db
    .from('crm_opportunities')
    .select('id, title, client_id, client_name, value, currency, won_at, quote_id, owner_user_id')
    .not('won_at', 'is', null)
    .order('won_at', { ascending: false })
    .limit(opts.limit ?? 30);
  if (error) {
    const code = (error as { code?: string }).code;
    if (code === '42P01' || code === 'PGRST205') return [];
    throw error;
  }
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  if (!rows.length) return [];
  const taken = new Set<string>();
  for (const part of chunks(
    rows.map((r) => String(r.id)),
    IN_CHUNK,
  )) {
    const res = await db.from('projects').select('opportunity_id').in('opportunity_id', part);
    if (res.error) throw res.error;
    for (const r of (res.data ?? []) as Array<{ opportunity_id: string }>)
      taken.add(r.opportunity_id);
  }
  return rows
    .filter((r) => !taken.has(String(r.id)))
    .map((r) => ({
      id: String(r.id),
      title: String(r.title ?? 'Oportunidad'),
      clientId: (r.client_id as string | null) ?? null,
      clientName: (r.client_name as string | null) ?? null,
      value: numOrNull(r.value),
      currency: String(r.currency ?? 'COP'),
      wonAt: String(r.won_at),
      quoteId: (r.quote_id as string | null) ?? null,
      ownerId: (r.owner_user_id as string | null) ?? null,
    }));
}
