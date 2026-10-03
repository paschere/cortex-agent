import { ForbiddenError, NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { bogotaToday } from '../commitments/shape';
import { createCommitment, isUniqueViolation, markMet } from '../commitments/store';
import { isCompanyManager } from '../directory/store';
import {
  ACTIVITY_KINDS,
  ACTIVITY_KIND_LABEL,
  ACTIVITY_STANDARD,
  type ActivityKind,
  INCIDENT_KINDS,
  INCIDENT_KIND_LABEL,
  INCIDENT_SEVERITIES,
  type IncidentKind,
  type IncidentSeverity,
  incidentDeadlines,
} from './deadlines';
import {
  SST_STATUSES,
  type SstCompliance,
  type SstGroupSize,
  type SstStatus,
  applicableStandards,
  sstCompliance,
  standardsGroup,
} from './standards';

/**
 * EL SG-SST EN LA BASE (migración 0194).
 *
 * Quién puede qué: CUALQUIERA del equipo reporta un accidente o incidente (es
 * una obligación de todos y llega tarde si hay que buscar a quien administra).
 * Registrar actividades, evaluar estándares y cerrar investigaciones lo hace
 * el responsable del SG-SST (`sst_settings.responsible_user_id`) o quien
 * administra. Los plazos (FURAT, investigación, actividades programadas,
 * estándares con fecha) se vuelven vencimientos (`commitments`), así que los
 * avisos salen del mismo vigilante que cuida los SOAT y los impuestos.
 *
 * Datos médicos: Cortex guarda que un examen se hizo y de qué tipo, nunca el
 * resultado (es historia clínica; la custodia la IPS).
 */

export const SST_COMMITMENT_SYSTEM = 'sg-sst';

export interface SstSettings {
  workers: number;
  maxRiskClass: number;
  committee: 'copasst' | 'vigia';
  responsibleUserId: string | null;
  responsibleName: string | null;
  responsibleLicense: string | null;
  arl: string | null;
  configured: boolean;
}

export async function readSstSettings(db: SupabaseClient): Promise<SstSettings> {
  const { data, error } = await db
    .from('sst_settings')
    .select(
      'workers, max_risk_class, committee, responsible_user_id, responsible_name, responsible_license, arl',
    )
    .maybeSingle();
  if (error) throw error;
  if (!data)
    return {
      workers: 1,
      maxRiskClass: 1,
      committee: 'vigia',
      responsibleUserId: null,
      responsibleName: null,
      responsibleLicense: null,
      arl: null,
      configured: false,
    };
  const r = data as {
    workers: number;
    max_risk_class: number;
    committee: 'copasst' | 'vigia';
    responsible_user_id: string | null;
    responsible_name: string | null;
    responsible_license: string | null;
    arl: string | null;
  };
  return {
    workers: r.workers,
    maxRiskClass: r.max_risk_class,
    committee: r.committee,
    responsibleUserId: r.responsible_user_id,
    responsibleName: r.responsible_name,
    responsibleLicense: r.responsible_license,
    arl: r.arl,
    configured: true,
  };
}

/** ¿Puede gestionar el SG-SST? Quien administra o el responsable designado. */
export async function canManageSst(
  db: SupabaseClient,
  userId: string | null | undefined,
): Promise<boolean> {
  if (!userId) return false;
  if (await isCompanyManager(db, userId)) return true;
  const s = await readSstSettings(db).catch(() => null);
  return Boolean(s?.responsibleUserId && s.responsibleUserId === userId);
}

async function requireSst(db: SupabaseClient, userId: string, what: string) {
  if (!(await canManageSst(db, userId)))
    throw new ForbiddenError(
      `${what} lo hace el responsable del SG-SST o quien administra la empresa.`,
    );
}

export async function saveSstSettings(
  db: SupabaseClient,
  input: Omit<SstSettings, 'configured'>,
  opts: { userId: string },
): Promise<SstSettings> {
  if (!(await isCompanyManager(db, opts.userId)))
    throw new ForbiddenError('Configurar el SG-SST es de quien administra la empresa.');
  const workers = Math.max(1, Math.min(100000, Math.round(input.workers)));
  const risk = Math.max(1, Math.min(5, Math.round(input.maxRiskClass)));
  const { error } = await db.from('sst_settings').upsert(
    {
      workers,
      max_risk_class: risk,
      committee: workers >= 10 ? 'copasst' : input.committee === 'copasst' ? 'copasst' : 'vigia',
      responsible_user_id: input.responsibleUserId ?? null,
      responsible_name: input.responsibleName?.trim().slice(0, 160) || null,
      responsible_license: input.responsibleLicense?.trim().slice(0, 160) || null,
      arl: input.arl?.trim().slice(0, 80) || null,
      updated_by: opts.userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'organization_id' },
  );
  if (error) throw error;
  return readSstSettings(db);
}

// ---------------------------------------------------------------------------
// Autoevaluación y plan anual
// ---------------------------------------------------------------------------

export interface SstPlanItem {
  id: string;
  year: number;
  code: string;
  title: string;
  cycle: string;
  weight: number;
  status: SstStatus;
  justification: string | null;
  evidenceDocumentId: string | null;
  evidenceUrl: string | null;
  ownerUserId: string | null;
  dueDate: string | null;
  commitmentId: string | null;
  evaluatedAt: string | null;
  notes: string | null;
}

const PLAN_COLUMNS =
  'id, year, standard_code, title, cycle, weight, status, justification, evidence_document_id, evidence_url, owner_user_id, due_date, commitment_id, evaluated_at, notes';

interface PlanRow {
  id: string;
  year: number;
  standard_code: string;
  title: string;
  cycle: string;
  weight: number | string;
  status: SstStatus;
  justification: string | null;
  evidence_document_id: string | null;
  evidence_url: string | null;
  owner_user_id: string | null;
  due_date: string | null;
  commitment_id: string | null;
  evaluated_at: string | null;
  notes: string | null;
}

function adaptPlan(r: PlanRow): SstPlanItem {
  return {
    id: r.id,
    year: r.year,
    code: r.standard_code,
    title: r.title,
    cycle: r.cycle,
    weight: Number(r.weight),
    status: r.status,
    justification: r.justification,
    evidenceDocumentId: r.evidence_document_id,
    evidenceUrl: r.evidence_url,
    ownerUserId: r.owner_user_id,
    dueDate: r.due_date,
    commitmentId: r.commitment_id,
    evaluatedAt: r.evaluated_at,
    notes: r.notes,
  };
}

export async function listSstPlan(db: SupabaseClient, year: number): Promise<SstPlanItem[]> {
  const { data, error } = await db
    .from('sst_plan')
    .select(PLAN_COLUMNS)
    .eq('year', year)
    .limit(200);
  if (error) throw error;
  return ((data ?? []) as PlanRow[])
    .map(adaptPlan)
    .sort((a, b) => a.code.localeCompare(b.code, 'es', { numeric: true }));
}

/**
 * Crea (o pone al día) la autoevaluación del año con los estándares que le
 * aplican por tamaño y riesgo. No toca el estado de los que ya existen; quita
 * los que dejaron de aplicar sólo si siguen sin evaluar.
 */
export async function ensureSstPlan(
  db: SupabaseClient,
  year: number,
  opts: { userId: string },
): Promise<{ group: SstGroupSize; items: SstPlanItem[] }> {
  await requireSst(db, opts.userId, 'Armar la autoevaluación');
  const settings = await readSstSettings(db);
  const group = standardsGroup(settings.workers, settings.maxRiskClass);
  const wanted = applicableStandards(group);
  const current = await listSstPlan(db, year);
  const have = new Map(current.map((i) => [i.code, i]));
  const wantedCodes = new Set(wanted.map((w) => w.code));
  const inserts = wanted
    .filter((w) => !have.has(w.code))
    .map((w) => ({
      year,
      standard_code: w.code,
      title: w.title,
      cycle: w.cycle,
      weight: w.weight,
      status: 'pendiente',
    }));
  if (inserts.length) {
    const { error } = await db.from('sst_plan').insert(inserts);
    if (error && !isUniqueViolation(error)) throw error;
  }
  // Pesos al día (el grupo pudo cambiar).
  for (const w of wanted) {
    const h = have.get(w.code);
    if (h && h.weight !== w.weight) {
      const { error } = await db.from('sst_plan').update({ weight: w.weight }).eq('id', h.id);
      if (error) throw error;
    }
  }
  const stale = current
    .filter((i) => !wantedCodes.has(i.code) && i.status === 'pendiente')
    .map((i) => i.id);
  if (stale.length) {
    const { error } = await db.from('sst_plan').delete().in('id', stale);
    if (error) throw error;
  }
  return { group, items: (await listSstPlan(db, year)).filter((i) => wantedCodes.has(i.code)) };
}

export async function updateSstStandard(
  db: SupabaseClient,
  input: {
    id: string;
    status?: SstStatus;
    justification?: string | null;
    evidenceDocumentId?: string | null;
    evidenceUrl?: string | null;
    ownerUserId?: string | null;
    dueDate?: string | null;
    notes?: string | null;
  },
  opts: { userId: string },
): Promise<SstPlanItem> {
  await requireSst(db, opts.userId, 'Evaluar un estándar');
  if (input.status && !SST_STATUSES.includes(input.status))
    throw new ValidationError('Estado desconocido.');
  if (input.status === 'no_aplica' && !input.justification?.trim())
    throw new ValidationError(
      'Un «no aplica» necesita la justificación (art. 27, Resolución 0312).',
    );
  if (input.evidenceUrl && !/^https?:\/\//.test(input.evidenceUrl))
    throw new ValidationError('La evidencia debe ser un enlace http(s).');
  const { data: cur, error: e0 } = await db
    .from('sst_plan')
    .select(PLAN_COLUMNS)
    .eq('id', input.id)
    .maybeSingle();
  if (e0) throw e0;
  if (!cur) throw new NotFoundError('Ese estándar no está en la autoevaluación.');
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.status) {
    patch.status = input.status;
    patch.evaluated_by = opts.userId;
    patch.evaluated_at = new Date().toISOString();
  }
  if (input.justification !== undefined) patch.justification = input.justification?.trim() || null;
  if (input.evidenceDocumentId !== undefined) patch.evidence_document_id = input.evidenceDocumentId;
  if (input.evidenceUrl !== undefined) patch.evidence_url = input.evidenceUrl || null;
  if (input.ownerUserId !== undefined) patch.owner_user_id = input.ownerUserId;
  if (input.dueDate !== undefined) patch.due_date = input.dueDate;
  if (input.notes !== undefined) patch.notes = input.notes?.trim().slice(0, 1000) || null;
  const { data, error } = await db
    .from('sst_plan')
    .update(patch)
    .eq('id', input.id)
    .select(PLAN_COLUMNS)
    .single();
  if (error) throw error;
  let item = adaptPlan(data as PlanRow);
  // Fecha para cumplirlo → vencimiento; cumplido → se cierra.
  if (item.status === 'cumple' && item.commitmentId) {
    await markMet(db, {
      id: item.commitmentId,
      userId: opts.userId,
      note: 'Estándar cumplido.',
    }).catch(() => undefined);
  } else if (
    item.dueDate &&
    item.status !== 'cumple' &&
    item.status !== 'no_aplica' &&
    !item.commitmentId &&
    item.dueDate >= bogotaToday()
  ) {
    const c = await createSstCommitment(db, {
      title: `SG-SST: ${item.code} ${item.title}`,
      detail: 'Estándar mínimo de la Resolución 0312 de 2019 pendiente en la autoevaluación.',
      dueOn: item.dueDate,
      ownerUserId: item.ownerUserId,
      userId: opts.userId,
    });
    if (c) {
      const upd = await db.from('sst_plan').update({ commitment_id: c }).eq('id', item.id);
      if (upd.error) throw upd.error;
      item = { ...item, commitmentId: c };
    }
  }
  return item;
}

export async function sstComplianceFor(
  db: SupabaseClient,
  year: number,
): Promise<SstCompliance & { total: number }> {
  const items = await listSstPlan(db, year);
  const c = sstCompliance(
    items.map((i) => ({
      code: i.code,
      weight: i.weight,
      status: i.status,
      justification: i.justification,
      hasEvidence: Boolean(i.evidenceDocumentId || i.evidenceUrl),
    })),
  );
  return { ...c, total: items.length };
}

async function createSstCommitment(
  db: SupabaseClient,
  input: {
    title: string;
    detail: string;
    dueOn: string;
    ownerUserId: string | null;
    userId: string;
    noticeDays?: number;
  },
): Promise<string | null> {
  try {
    const settings = await readSstSettings(db).catch(() => null);
    const row = await createCommitment(db, {
      title: input.title.slice(0, 200),
      detail: input.detail,
      kind: 'other',
      dueOn: input.dueOn,
      noticeDays: input.noticeDays ?? 3,
      counterparty: 'SG-SST',
      ownerUserId: input.ownerUserId ?? settings?.responsibleUserId ?? input.userId,
      source: { kind: 'system', system: SST_COMMITMENT_SYSTEM, readAt: new Date().toISOString() },
      createdBy: input.userId,
    });
    return row.id;
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Actividades
// ---------------------------------------------------------------------------

export interface SstActivity {
  id: string;
  kind: ActivityKind;
  title: string;
  plannedDate: string | null;
  doneDate: string | null;
  status: 'programada' | 'realizada' | 'cancelada';
  participants: number | null;
  employeeId: string | null;
  examType: string | null;
  standardCode: string | null;
  evidenceDocumentId: string | null;
  evidenceUrl: string | null;
  notes: string | null;
  commitmentId: string | null;
}

const ACTIVITY_COLUMNS =
  'id, kind, title, planned_date, done_date, status, participants, employee_id, exam_type, standard_code, evidence_document_id, evidence_url, notes, commitment_id';

interface ActivityRow {
  id: string;
  kind: ActivityKind;
  title: string;
  planned_date: string | null;
  done_date: string | null;
  status: 'programada' | 'realizada' | 'cancelada';
  participants: number | null;
  employee_id: string | null;
  exam_type: string | null;
  standard_code: string | null;
  evidence_document_id: string | null;
  evidence_url: string | null;
  notes: string | null;
  commitment_id: string | null;
}

function adaptActivity(r: ActivityRow): SstActivity {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    plannedDate: r.planned_date,
    doneDate: r.done_date,
    status: r.status,
    participants: r.participants,
    employeeId: r.employee_id,
    examType: r.exam_type,
    standardCode: r.standard_code,
    evidenceDocumentId: r.evidence_document_id,
    evidenceUrl: r.evidence_url,
    notes: r.notes,
    commitmentId: r.commitment_id,
  };
}

export async function listSstActivities(
  db: SupabaseClient,
  opts: { from?: string; to?: string; status?: string[]; limit?: number } = {},
): Promise<SstActivity[]> {
  let q = db
    .from('sst_activities')
    .select(ACTIVITY_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(opts.limit ?? 500);
  if (opts.status?.length) q = q.in('status', opts.status);
  const { data, error } = await q;
  if (error) throw error;
  let list = ((data ?? []) as ActivityRow[]).map(adaptActivity);
  const when = (a: SstActivity) => a.doneDate ?? a.plannedDate ?? '';
  if (opts.from) list = list.filter((a) => when(a) >= (opts.from as string));
  if (opts.to) list = list.filter((a) => when(a) <= (opts.to as string));
  return list.sort((a, b) => (when(a) < when(b) ? 1 : -1));
}

export interface LogActivityInput {
  id?: string | null;
  kind: ActivityKind;
  title?: string | null;
  plannedDate?: string | null;
  doneDate?: string | null;
  participants?: number | null;
  employeeId?: string | null;
  examType?: 'ingreso' | 'periodico' | 'retiro' | 'post_incapacidad' | null;
  standardCode?: string | null;
  evidenceDocumentId?: string | null;
  evidenceUrl?: string | null;
  notes?: string | null;
}

/** Programa o registra una actividad. Con `doneDate` queda realizada. */
export async function logSstActivity(
  db: SupabaseClient,
  input: LogActivityInput,
  opts: { userId: string },
): Promise<SstActivity> {
  await requireSst(db, opts.userId, 'Registrar actividades del SG-SST');
  if (!ACTIVITY_KINDS.includes(input.kind))
    throw new ValidationError('Tipo de actividad desconocido.');
  if (!input.plannedDate && !input.doneDate)
    throw new ValidationError('Falta la fecha (programada o en que se hizo).');
  if (input.evidenceUrl && !/^https?:\/\//.test(input.evidenceUrl))
    throw new ValidationError('La evidencia debe ser un enlace http(s).');
  const today = bogotaToday();
  if (input.doneDate && input.doneDate > today)
    throw new ValidationError('Una actividad realizada no puede tener fecha futura.');
  const row = {
    kind: input.kind,
    title: (input.title?.trim() || ACTIVITY_KIND_LABEL[input.kind]).slice(0, 200),
    planned_date: input.plannedDate ?? null,
    done_date: input.doneDate ?? null,
    status: input.doneDate ? 'realizada' : 'programada',
    participants: input.participants ?? null,
    employee_id: input.employeeId ?? null,
    exam_type: input.kind === 'examen_medico' ? (input.examType ?? 'periodico') : null,
    standard_code: input.standardCode ?? ACTIVITY_STANDARD[input.kind],
    evidence_document_id: input.evidenceDocumentId ?? null,
    evidence_url: input.evidenceUrl ?? null,
    notes: input.notes?.trim().slice(0, 1000) || null,
    updated_at: new Date().toISOString(),
  };
  let saved: SstActivity;
  if (input.id) {
    const { data, error } = await db
      .from('sst_activities')
      .update(row)
      .eq('id', input.id)
      .select(ACTIVITY_COLUMNS)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new NotFoundError('Esa actividad no existe.');
    saved = adaptActivity(data as ActivityRow);
  } else {
    const { data, error } = await db
      .from('sst_activities')
      .insert({ ...row, created_by: opts.userId })
      .select(ACTIVITY_COLUMNS)
      .single();
    if (error) throw error;
    saved = adaptActivity(data as ActivityRow);
  }
  if (saved.status === 'realizada' && saved.commitmentId) {
    await markMet(db, {
      id: saved.commitmentId,
      userId: opts.userId,
      note: 'Actividad realizada.',
    }).catch(() => undefined);
  } else if (
    saved.status === 'programada' &&
    saved.plannedDate &&
    saved.plannedDate >= today &&
    !saved.commitmentId
  ) {
    const c = await createSstCommitment(db, {
      title: `SG-SST: ${saved.title}`,
      detail: `${ACTIVITY_KIND_LABEL[saved.kind]} programada en el plan anual. Al hacerla, registra la evidencia en SG-SST.`,
      dueOn: saved.plannedDate,
      ownerUserId: null,
      userId: opts.userId,
    });
    if (c) {
      const upd = await db.from('sst_activities').update({ commitment_id: c }).eq('id', saved.id);
      if (upd.error) throw upd.error;
      saved = { ...saved, commitmentId: c };
    }
  }
  return saved;
}

// ---------------------------------------------------------------------------
// Accidentes e incidentes
// ---------------------------------------------------------------------------

export interface SstIncident {
  id: string;
  kind: IncidentKind;
  severity: IncidentSeverity;
  occurredOn: string;
  employeeId: string | null;
  place: string | null;
  description: string;
  daysLost: number | null;
  furatDue: string | null;
  furatReportedOn: string | null;
  investigationDue: string;
  investigationDoneOn: string | null;
  investigationDocumentId: string | null;
  ministryDue: string | null;
  correctiveActions: string | null;
  status: 'abierto' | 'investigado' | 'cerrado';
  furatCommitmentId: string | null;
  investigationCommitmentId: string | null;
}

const INCIDENT_COLUMNS =
  'id, kind, severity, occurred_on, employee_id, place, description, days_lost, furat_due, furat_reported_on, investigation_due, investigation_done_on, investigation_document_id, ministry_due, corrective_actions, status, furat_commitment_id, investigation_commitment_id';

interface IncidentRow {
  id: string;
  kind: IncidentKind;
  severity: IncidentSeverity;
  occurred_on: string;
  employee_id: string | null;
  place: string | null;
  description: string;
  days_lost: number | null;
  furat_due: string | null;
  furat_reported_on: string | null;
  investigation_due: string;
  investigation_done_on: string | null;
  investigation_document_id: string | null;
  ministry_due: string | null;
  corrective_actions: string | null;
  status: 'abierto' | 'investigado' | 'cerrado';
  furat_commitment_id: string | null;
  investigation_commitment_id: string | null;
}

function adaptIncident(r: IncidentRow): SstIncident {
  return {
    id: r.id,
    kind: r.kind,
    severity: r.severity,
    occurredOn: r.occurred_on,
    employeeId: r.employee_id,
    place: r.place,
    description: r.description,
    daysLost: r.days_lost,
    furatDue: r.furat_due,
    furatReportedOn: r.furat_reported_on,
    investigationDue: r.investigation_due,
    investigationDoneOn: r.investigation_done_on,
    investigationDocumentId: r.investigation_document_id,
    ministryDue: r.ministry_due,
    correctiveActions: r.corrective_actions,
    status: r.status,
    furatCommitmentId: r.furat_commitment_id,
    investigationCommitmentId: r.investigation_commitment_id,
  };
}

export async function listSstIncidents(
  db: SupabaseClient,
  opts: { open?: boolean; limit?: number } = {},
): Promise<SstIncident[]> {
  let q = db
    .from('sst_incidents')
    .select(INCIDENT_COLUMNS)
    .order('occurred_on', { ascending: false })
    .limit(opts.limit ?? 300);
  if (opts.open) q = q.neq('status', 'cerrado');
  const { data, error } = await q;
  if (error) throw error;
  return ((data ?? []) as IncidentRow[]).map(adaptIncident);
}

export interface ReportIncidentInput {
  kind: IncidentKind;
  severity?: IncidentSeverity;
  occurredOn: string;
  employeeId?: string | null;
  place?: string | null;
  description: string;
  daysLost?: number | null;
}

/** Reportar: cualquiera del equipo. Crea los vencimientos de FURAT e investigación. */
export async function reportSstIncident(
  db: SupabaseClient,
  input: ReportIncidentInput,
  opts: { userId: string },
): Promise<{ incident: SstIncident; notes: string[] }> {
  if (!INCIDENT_KINDS.includes(input.kind))
    throw new ValidationError('Tipo de evento desconocido.');
  const severity = input.severity ?? 'leve';
  if (!INCIDENT_SEVERITIES.includes(severity)) throw new ValidationError('Gravedad desconocida.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.occurredOn))
    throw new ValidationError('La fecha va como AAAA-MM-DD.');
  const today = bogotaToday();
  if (input.occurredOn > today)
    throw new ValidationError('La fecha del evento no puede ser futura.');
  if ((input.description ?? '').trim().length < 3) throw new ValidationError('Describe qué pasó.');
  const d = incidentDeadlines({ kind: input.kind, severity, occurredOn: input.occurredOn });
  const { data, error } = await db
    .from('sst_incidents')
    .insert({
      kind: input.kind,
      severity,
      occurred_on: input.occurredOn,
      employee_id: input.employeeId ?? null,
      place: input.place?.trim().slice(0, 200) || null,
      description: input.description.trim().slice(0, 2000),
      days_lost: input.daysLost ?? null,
      furat_due: d.furatDue,
      investigation_due: d.investigationDue,
      ministry_due: d.ministryDue,
      reported_by: opts.userId,
    })
    .select(INCIDENT_COLUMNS)
    .single();
  if (error) throw error;
  let incident = adaptIncident(data as IncidentRow);
  const label = INCIDENT_KIND_LABEL[incident.kind];
  const patch: Record<string, string> = {};
  if (d.furatDue && d.furatDue >= today) {
    const c = await createSstCommitment(db, {
      title: `Reportar FURAT a la ARL: ${label.toLowerCase()} del ${incident.occurredOn}`,
      detail:
        'Formato Único de Reporte de Accidente de Trabajo a la ARL y a la EPS dentro de los 2 días hábiles siguientes (Res. 156 de 2005).',
      dueOn: d.furatDue,
      ownerUserId: null,
      userId: opts.userId,
      noticeDays: 1,
    });
    if (c) patch.furat_commitment_id = c;
  }
  if (d.investigationDue >= today) {
    const c = await createSstCommitment(db, {
      title: `Investigar ${label.toLowerCase()} del ${incident.occurredOn}`,
      detail:
        'Investigación con el COPASST o el vigía dentro de los 15 días siguientes (Res. 1401 de 2007).',
      dueOn: d.investigationDue,
      ownerUserId: null,
      userId: opts.userId,
      noticeDays: 5,
    });
    if (c) patch.investigation_commitment_id = c;
  }
  if (Object.keys(patch).length) {
    const upd = await db
      .from('sst_incidents')
      .update(patch)
      .eq('id', incident.id)
      .select(INCIDENT_COLUMNS)
      .single();
    if (upd.error) throw upd.error;
    incident = adaptIncident(upd.data as IncidentRow);
  }
  return { incident, notes: d.notes };
}

/** Marca el FURAT reportado, la investigación hecha o el caso cerrado. */
export async function updateSstIncident(
  db: SupabaseClient,
  input: {
    id: string;
    furatReportedOn?: string | null;
    investigationDoneOn?: string | null;
    investigationDocumentId?: string | null;
    correctiveActions?: string | null;
    close?: boolean;
  },
  opts: { userId: string },
): Promise<SstIncident> {
  await requireSst(db, opts.userId, 'Cerrar el seguimiento de un accidente');
  const { data: cur, error: e0 } = await db
    .from('sst_incidents')
    .select(INCIDENT_COLUMNS)
    .eq('id', input.id)
    .maybeSingle();
  if (e0) throw e0;
  if (!cur) throw new NotFoundError('Ese evento no existe.');
  const before = adaptIncident(cur as IncidentRow);
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.furatReportedOn !== undefined) patch.furat_reported_on = input.furatReportedOn;
  if (input.investigationDoneOn !== undefined)
    patch.investigation_done_on = input.investigationDoneOn;
  if (input.investigationDocumentId !== undefined)
    patch.investigation_document_id = input.investigationDocumentId;
  if (input.correctiveActions !== undefined)
    patch.corrective_actions = input.correctiveActions?.trim().slice(0, 2000) || null;
  const investigated = (input.investigationDoneOn ?? before.investigationDoneOn) != null;
  if (input.close) {
    if (!investigated)
      throw new ValidationError('Antes de cerrarlo hay que registrar la investigación.');
    patch.status = 'cerrado';
  } else if (investigated) patch.status = 'investigado';
  const { data, error } = await db
    .from('sst_incidents')
    .update(patch)
    .eq('id', input.id)
    .select(INCIDENT_COLUMNS)
    .single();
  if (error) throw error;
  const after = adaptIncident(data as IncidentRow);
  if (after.furatReportedOn && after.furatCommitmentId)
    await markMet(db, {
      id: after.furatCommitmentId,
      userId: opts.userId,
      note: 'FURAT reportado.',
    }).catch(() => undefined);
  if (after.investigationDoneOn && after.investigationCommitmentId)
    await markMet(db, {
      id: after.investigationCommitmentId,
      userId: opts.userId,
      note: 'Investigación hecha.',
    }).catch(() => undefined);
  return after;
}
