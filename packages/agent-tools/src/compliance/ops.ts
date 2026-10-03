import { randomBytes } from 'node:crypto';
import { ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { bogotaToday, daysBetween } from '../commitments/shape';
import {
  createCommitment,
  dropCommitment,
  getCommitment,
  isUniqueViolation,
  markMet,
  rescheduleCommitment,
} from '../commitments/store';
import { listTaxObligations } from '../tax/store';
import { normalizeRadicado, parseRadicado } from './cases';
import { CHECKLIST_RULE_VERSION, buildChecklist } from './catalog';
import {
  addBusinessDays,
  businessDaysLeft,
  formatRadicado,
  legalDeadline,
  maxExtensionDate,
} from './pqrs';
import {
  COMPLIANCE_AREAS,
  type CaseRole,
  type CaseRow,
  type CaseStatus,
  type ComplianceArea,
  type ComplianceProfile,
  ENTITY_TYPES,
  type ItemRow,
  type ItemStatus,
  PQRS_OPEN,
  type PqrsChannel,
  type PqrsKind,
  type PqrsMatter,
  type PqrsRow,
  type PqrsStatus,
  SECTORS,
  SUPERVISION_LEVELS,
  SUPERVISORS,
} from './shape';
import {
  findLegalCaseByRadicado,
  getComplianceItem,
  getLegalCase,
  getPqrs,
  insertCaseAction,
  insertComplianceItems,
  insertLegalCase,
  insertPqrsRow,
  listComplianceItems,
  listLegalCases,
  listPqrs,
  nextPqrsSeq,
  readComplianceProfile,
  updateComplianceItem,
  updateLegalCase,
  updatePqrsRow,
  writeComplianceProfile,
} from './store';

/**
 * LAS DECISIONES DE CUMPLIMIENTO, COMPLETAS (0195). Las llaman el chat, la
 * pantalla /cumplimiento y el formulario público de PQRS, así que las tres
 * superficies no pueden hacer cosas distintas con el mismo clic.
 */

export interface OpsContext {
  userId: string;
  today?: string;
}

// ---------------------------------------------------------------------------
// Perfil y lista
// ---------------------------------------------------------------------------

export interface ProfileInput {
  entityType?: string;
  size?: string | null;
  revenueCop?: number | null;
  assetsCop?: number | null;
  figuresYear?: number | null;
  internationalCop?: number | null;
  stateContractsCop?: number | null;
  supervisor?: string;
  supervisionLevel?: string;
  sectors?: string[];
  handlesPersonalData?: boolean;
  consumerFacing?: boolean;
  employees?: number | null;
  hasBoard?: boolean;
  complianceOfficer?: string | null;
  ownerUserId?: string | null;
  privacyPolicyUrl?: string | null;
  pqrsOwnerUserId?: string | null;
  pqrsDeadlines?: Record<string, number>;
}

function nonNegative(v: number | null | undefined, label: string): number | null {
  if (v === null || v === undefined) return null;
  if (!Number.isFinite(v) || v < 0) throw new ValidationError(`${label} no puede ser negativo.`);
  return v;
}

export async function saveComplianceProfile(
  db: SupabaseClient,
  input: ProfileInput,
  ctx: OpsContext,
): Promise<{ profile: ComplianceProfile; sync: SyncResult }> {
  const patch: Record<string, unknown> = {};
  if (input.entityType !== undefined) {
    if (!(ENTITY_TYPES as readonly string[]).includes(input.entityType)) {
      throw new ValidationError('Ese tipo de sociedad no lo conozco.');
    }
    patch.entity_type = input.entityType;
  }
  if (input.size !== undefined) patch.size = input.size || null;
  if (input.revenueCop !== undefined)
    patch.revenue_cop = nonNegative(input.revenueCop, 'Los ingresos');
  if (input.assetsCop !== undefined) patch.assets_cop = nonNegative(input.assetsCop, 'Los activos');
  if (input.figuresYear !== undefined) patch.figures_year = input.figuresYear;
  if (input.internationalCop !== undefined) {
    patch.international_cop = nonNegative(input.internationalCop, 'Los negocios internacionales');
  }
  if (input.stateContractsCop !== undefined) {
    patch.state_contracts_cop = nonNegative(input.stateContractsCop, 'Los contratos con el Estado');
  }
  if (input.supervisor !== undefined) {
    if (!(SUPERVISORS as readonly string[]).includes(input.supervisor)) {
      throw new ValidationError('Esa superintendencia no la conozco.');
    }
    patch.supervisor = input.supervisor;
  }
  if (input.supervisionLevel !== undefined) {
    if (!(SUPERVISION_LEVELS as readonly string[]).includes(input.supervisionLevel)) {
      throw new ValidationError('Ese nivel de supervisión no lo conozco.');
    }
    patch.supervision_level = input.supervisionLevel;
  }
  if (input.sectors !== undefined) {
    patch.sectors = input.sectors.filter((s) => (SECTORS as readonly string[]).includes(s));
  }
  if (input.handlesPersonalData !== undefined)
    patch.handles_personal_data = input.handlesPersonalData;
  if (input.consumerFacing !== undefined) patch.consumer_facing = input.consumerFacing;
  if (input.employees !== undefined) patch.employees = input.employees;
  if (input.hasBoard !== undefined) patch.has_board = input.hasBoard;
  if (input.complianceOfficer !== undefined)
    patch.compliance_officer = input.complianceOfficer?.trim() || null;
  if (input.ownerUserId !== undefined) patch.owner_user_id = input.ownerUserId;
  if (input.privacyPolicyUrl !== undefined) {
    const url = input.privacyPolicyUrl?.trim() || null;
    if (url && !/^https?:\/\//i.test(url))
      throw new ValidationError('La política va como un enlace https://…');
    patch.privacy_policy_url = url;
  }
  if (input.pqrsOwnerUserId !== undefined) patch.pqrs_owner_user_id = input.pqrsOwnerUserId;
  if (input.pqrsDeadlines !== undefined) {
    const clean: Record<string, number> = {};
    for (const [k, v] of Object.entries(input.pqrsDeadlines)) {
      if (Number.isInteger(v) && v >= 1 && v <= 30) clean[k] = v;
    }
    patch.pqrs_deadlines = clean;
  }
  const profile = await writeComplianceProfile(db, patch, ctx.userId);
  const today = ctx.today ?? bogotaToday();
  const sync = await syncChecklist(db, profile, Number(today.slice(0, 4)), ctx);
  return { profile, sync };
}

export interface SyncResult {
  inserted: number;
  updated: number;
}

/**
 * Pone la lista del año al día con el perfil. Idempotente. Lo que una persona
 * decidió (cumplido, en curso, «no aplica» con su nombre) no se toca; lo que
 * el perfil decidió solo («no aplica» sin persona) se recalcula.
 */
export async function syncChecklist(
  db: SupabaseClient,
  profile: ComplianceProfile,
  year: number,
  ctx: OpsContext,
): Promise<SyncResult> {
  const specs = buildChecklist(profile, year);
  const existing = await listComplianceItems(db, { limit: 1000 });
  const byKey = new Map(existing.map((r) => [`${r.item_key}#${r.period}`, r]));
  let updated = 0;
  const toInsert: Parameters<typeof insertComplianceItems>[1] = [];

  // La matrícula se lleva en Impuestos (0180): si allá ya está hecha, aquí también.
  let camara: { status: string; statusAt: string | null } | null = null;
  try {
    const rows = await listTaxObligations(db, { year, kinds: ['camara_comercio'], limit: 5 });
    const first = rows[0];
    if (first) camara = { status: first.status, statusAt: first.statusAt };
  } catch {
    camara = null;
  }

  for (const spec of specs) {
    const current = byKey.get(`${spec.key}#${spec.period}`);
    const auto = spec.applies === 'no' ? 'no_aplica' : 'pendiente';
    const mirroredDone =
      spec.key === 'renovacion_matricula' && camara && camara.status !== 'pendiente';
    if (!current) {
      toInsert.push({
        item_key: spec.key,
        period: spec.period,
        area: spec.area,
        title: spec.title,
        description: spec.description,
        frequency: spec.frequency,
        due_on: spec.dueOn,
        due_needs_confirmation: spec.dueNeedsConfirmation,
        legal_basis: spec.legalBasis,
        applies: spec.applies,
        applicability_note: spec.applicabilityNote.slice(0, 600),
        status: mirroredDone ? 'cumplido' : auto,
        evidence_note: mirroredDone ? `Marcada «${camara?.status}» en Impuestos.` : null,
        completed_at: mirroredDone ? (camara?.statusAt ?? new Date().toISOString()) : null,
        linked_href: spec.linkedHref,
        source: 'catalogo',
        rule_version: CHECKLIST_RULE_VERSION,
        owner_user_id: profile.ownerUserId,
        created_by: ctx.userId,
      });
      continue;
    }
    const patch: Partial<ItemRow> = {};
    const pairs: Array<[keyof ItemRow, unknown]> = [
      ['title', spec.title],
      ['description', spec.description],
      ['due_on', spec.dueOn],
      ['due_needs_confirmation', spec.dueNeedsConfirmation],
      ['legal_basis', spec.legalBasis],
      ['applies', spec.applies],
      ['applicability_note', spec.applicabilityNote.slice(0, 600)],
      ['linked_href', spec.linkedHref],
    ];
    for (const [col, value] of pairs) {
      if (current[col] !== value) (patch as Record<string, unknown>)[col] = value;
    }
    const systemDecided = !current.completed_by;
    if (systemDecided && current.status === 'pendiente' && auto === 'no_aplica')
      patch.status = 'no_aplica';
    if (systemDecided && current.status === 'no_aplica' && auto === 'pendiente')
      patch.status = 'pendiente';
    if (mirroredDone && current.status !== 'cumplido') {
      patch.status = 'cumplido';
      patch.evidence_note = `Marcada «${camara?.status}» en Impuestos.`;
      patch.completed_at = camara?.statusAt ?? new Date().toISOString();
    }
    if (Object.keys(patch).length) {
      patch.rule_version = CHECKLIST_RULE_VERSION;
      await updateComplianceItem(db, current.id, patch);
      updated++;
    }
  }
  const inserted = (await insertComplianceItems(db, toInsert)).length;
  return { inserted, updated };
}

export interface MarkInput {
  id: string;
  status: ItemStatus;
  evidenceDocumentId?: string | null;
  evidenceUrl?: string | null;
  evidenceNote?: string | null;
  ownerUserId?: string | null;
}

export async function markComplianceItem(
  db: SupabaseClient,
  input: MarkInput,
  ctx: OpsContext,
): Promise<ItemRow> {
  const current = await getComplianceItem(db, input.id);
  if (!current) throw new ValidationError('Esa obligación ya no está en la lista.');
  const url = input.evidenceUrl?.trim() || null;
  if (url && !/^https?:\/\//i.test(url))
    throw new ValidationError('La evidencia va como un enlace https://…');
  const evidence = {
    evidence_document_id: input.evidenceDocumentId ?? current.evidence_document_id,
    evidence_url: url ?? current.evidence_url,
    evidence_note: input.evidenceNote?.trim().slice(0, 1000) || current.evidence_note,
  };
  if (
    input.status === 'cumplido' &&
    !evidence.evidence_document_id &&
    !evidence.evidence_url &&
    !evidence.evidence_note
  ) {
    throw new ValidationError(
      'Para marcarlo cumplido deja la evidencia: un documento, un enlace o una nota de qué se hizo.',
    );
  }
  if (input.status === 'no_aplica' && !input.evidenceNote?.trim()) {
    throw new ValidationError('Di por qué no aplica (queda como nota).');
  }
  const now = new Date().toISOString();
  return updateComplianceItem(db, input.id, {
    ...evidence,
    status: input.status,
    owner_user_id: input.ownerUserId === undefined ? current.owner_user_id : input.ownerUserId,
    completed_at: input.status === 'cumplido' || input.status === 'no_aplica' ? now : null,
    completed_by: input.status === 'cumplido' || input.status === 'no_aplica' ? ctx.userId : null,
  });
}

// ---------------------------------------------------------------------------
// El resumen (chat y pantalla)
// ---------------------------------------------------------------------------

export interface AreaProgress {
  area: ComplianceArea;
  total: number;
  done: number;
  percent: number;
  overdue: number;
  review: number;
}

export function isItemOverdue(
  item: Pick<ItemRow, 'status' | 'due_on' | 'applies'>,
  today: string,
): boolean {
  return (
    (item.status === 'pendiente' || item.status === 'en_curso') &&
    item.applies !== 'no' &&
    !!item.due_on &&
    item.due_on < today
  );
}

/** Cuenta por área lo que aplica (sí o revisar) y lo hecho. «No aplica» no cuenta. */
export function progressByArea(items: ItemRow[], today: string): AreaProgress[] {
  return COMPLIANCE_AREAS.map((area) => {
    const counted = items.filter(
      (i) => i.area === area && i.status !== 'no_aplica' && i.applies !== 'no',
    );
    const done = counted.filter((i) => i.status === 'cumplido').length;
    return {
      area,
      total: counted.length,
      done,
      percent: counted.length ? Math.round((done / counted.length) * 100) : 100,
      overdue: counted.filter((i) => isItemOverdue(i, today)).length,
      review: counted.filter((i) => i.applies === 'revisar' && i.status !== 'cumplido').length,
    };
  }).filter((a) => a.total > 0);
}

// ---------------------------------------------------------------------------
// PQRS
// ---------------------------------------------------------------------------

export interface PqrsInput {
  channel: PqrsChannel;
  kind: PqrsKind;
  matter?: PqrsMatter;
  subject: string;
  body: string;
  requesterName: string;
  requesterIdNumber?: string | null;
  requesterEmail?: string | null;
  requesterPhone?: string | null;
  clientId?: string | null;
  receivedAt?: string | null;
  sourceRef?: string | null;
  consentAccepted?: boolean;
  assignedUserId?: string | null;
}

/** El día de Bogotá de un instante (UTC-5 fijo). */
export function bogotaDay(instant: string | Date): string {
  const t = typeof instant === 'string' ? Date.parse(instant) : instant.getTime();
  return new Date(t - 5 * 3_600_000).toISOString().slice(0, 10);
}

export async function createPqrs(
  db: SupabaseClient,
  input: PqrsInput,
  ctx: { userId: string | null; profile?: ComplianceProfile | null },
): Promise<PqrsRow> {
  if (input.subject.trim().length < 3) throw new ValidationError('Escribe el asunto.');
  if (!input.body.trim()) throw new ValidationError('Escribe la solicitud.');
  if (input.requesterName.trim().length < 2)
    throw new ValidationError('Falta el nombre de quien la presenta.');
  const email = input.requesterEmail?.trim() || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new ValidationError('Ese correo no parece válido.');
  if (input.channel === 'formulario' && !input.consentAccepted) {
    throw new ValidationError(
      'Para radicar por el formulario hay que aceptar el tratamiento de datos.',
    );
  }
  const receivedAt = input.receivedAt ? new Date(input.receivedAt) : new Date();
  if (Number.isNaN(receivedAt.getTime()))
    throw new ValidationError('La fecha de recepción no es válida.');
  const receivedOn = bogotaDay(receivedAt);
  const matter = input.matter ?? 'general';
  const profile =
    ctx.profile === undefined ? await readComplianceProfile(db).catch(() => null) : ctx.profile;
  const deadline = legalDeadline(input.kind, matter, profile?.pqrsDeadlines ?? {});
  const dueOn = addBusinessDays(receivedOn, deadline.days);
  const year = Number(receivedOn.slice(0, 4));

  // El consecutivo: el índice único decide; si dos llegan a la vez, reintenta.
  for (let attempt = 0; attempt < 5; attempt++) {
    const seq = (await nextPqrsSeq(db, year)) + attempt;
    try {
      return await insertPqrsRow(db, {
        year,
        seq,
        radicado: formatRadicado(year, seq),
        channel: input.channel,
        kind: input.kind,
        matter,
        subject: input.subject.trim().slice(0, 200),
        body: input.body.trim().slice(0, 8000),
        requester_name: input.requesterName.trim().slice(0, 160),
        requester_id_number: input.requesterIdNumber?.trim().slice(0, 40) || null,
        requester_email: email,
        requester_phone: input.requesterPhone?.trim().slice(0, 40) || null,
        client_id: input.clientId ?? null,
        received_at: receivedAt.toISOString(),
        received_on: receivedOn,
        deadline_days: deadline.days,
        due_on: dueOn,
        deadline_basis: deadline.basis.slice(0, 400),
        status: 'radicada',
        assigned_user_id: input.assignedUserId ?? profile?.pqrsOwnerUserId ?? null,
        source_ref: input.sourceRef?.trim().slice(0, 300) || null,
        consent_accepted: !!input.consentAccepted,
        created_by: ctx.userId,
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new ValidationError('No pude asignar el radicado; intenta de nuevo.');
}

/** El plazo que manda hoy: la ampliación si la hubo. */
export function effectiveDue(row: Pick<PqrsRow, 'due_on' | 'extended_due_on'>): string {
  return row.extended_due_on ?? row.due_on;
}

export async function respondPqrs(
  db: SupabaseClient,
  input: { id: string; text: string; channel?: PqrsChannel | null; close?: boolean },
  ctx: OpsContext,
): Promise<PqrsRow> {
  const current = await getPqrs(db, input.id);
  if (!current) throw new ValidationError('Esa PQRS no existe.');
  if (!PQRS_OPEN.includes(current.status) && current.status !== 'respondida') {
    throw new ValidationError(`Esa PQRS está ${current.status}: ya no se responde.`);
  }
  const text = input.text.trim();
  if (text.length < 10) throw new ValidationError('La respuesta es muy corta.');
  if (/\[COMPLETAR:/i.test(text))
    throw new ValidationError('La respuesta todavía tiene partes por completar.');
  return updatePqrsRow(db, current.id, {
    status: input.close ? 'cerrada' : 'respondida',
    response_text: text.slice(0, 12000),
    responded_at: new Date().toISOString(),
    responded_by: ctx.userId,
    response_channel: input.channel ?? (current.requester_email ? 'correo' : current.channel),
  });
}

export async function updatePqrsState(
  db: SupabaseClient,
  input: {
    id: string;
    status?: PqrsStatus;
    assignedUserId?: string | null;
    extendTo?: string | null;
    extensionReason?: string | null;
  },
  ctx: OpsContext,
): Promise<PqrsRow> {
  const current = await getPqrs(db, input.id);
  if (!current) throw new ValidationError('Esa PQRS no existe.');
  const today = ctx.today ?? bogotaToday();
  const patch: Partial<PqrsRow> = {};
  if (input.assignedUserId !== undefined) patch.assigned_user_id = input.assignedUserId;
  if (input.status) {
    if (input.status === 'respondida')
      throw new ValidationError('Para responderla, escribe la respuesta.');
    if (input.status === 'cerrada' && !current.response_text) {
      throw new ValidationError(
        'Una PQRS se cierra después de responderla (o márcala desistida o trasladada).',
      );
    }
    patch.status = input.status;
  }
  if (input.extendTo) {
    if (!PQRS_OPEN.includes(current.status))
      throw new ValidationError('Sólo se amplía una PQRS abierta.');
    if (today > current.due_on) {
      throw new ValidationError(
        'La ampliación se avisa antes de que venza el plazo inicial; ese ya pasó.',
      );
    }
    const max = maxExtensionDate(current.received_on, current.deadline_days);
    if (input.extendTo <= current.due_on)
      throw new ValidationError('El nuevo plazo tiene que ser posterior al inicial.');
    if (input.extendTo > max) {
      throw new ValidationError(
        `El nuevo plazo no puede pasar del doble del inicial: a más tardar el ${max}.`,
      );
    }
    if (!input.extensionReason?.trim())
      throw new ValidationError('Di por qué se amplía (hay que informárselo a quien la presentó).');
    patch.extended_due_on = input.extendTo;
    patch.extension_reason = input.extensionReason.trim().slice(0, 600);
  }
  return updatePqrsRow(db, current.id, patch);
}

export interface PqrsDeadlineView {
  due: string;
  left: number;
  overdue: boolean;
}

export function pqrsDeadline(
  row: Pick<PqrsRow, 'due_on' | 'extended_due_on'>,
  today: string,
): PqrsDeadlineView {
  const due = effectiveDue(row);
  const left = businessDaysLeft(today, due);
  return { due, left, overdue: left < 0 };
}

/** Prende (con un token nuevo si no hay) o apaga el formulario público. */
export async function setPublicPqrsForm(
  db: SupabaseClient,
  input: { enabled: boolean; rotate?: boolean },
  ctx: OpsContext,
): Promise<ComplianceProfile> {
  const current = await readComplianceProfile(db);
  const patch: Record<string, unknown> = { pqrs_enabled: input.enabled };
  if (input.enabled && (!current?.pqrsToken || input.rotate)) {
    patch.pqrs_token = randomBytes(24).toString('base64url');
  }
  return writeComplianceProfile(db, patch, ctx.userId);
}

// ---------------------------------------------------------------------------
// Procesos judiciales
// ---------------------------------------------------------------------------

export interface CaseInput {
  id?: string;
  radicado?: string | null;
  title?: string;
  court?: string | null;
  city?: string | null;
  processType?: string | null;
  role?: CaseRole;
  counterparty?: string | null;
  parties?: string | null;
  claimAmount?: number | null;
  status?: CaseStatus;
  lastActionOn?: string | null;
  lastAction?: string | null;
  nextHearingOn?: string | null;
  nextHearing?: string | null;
  lawyer?: string | null;
  ownerUserId?: string | null;
  checkedVia?: 'manual' | 'rama_judicial';
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Crea o actualiza un proceso (por id o por radicado) y su próxima diligencia vigilada. */
export async function upsertLegalCase(
  db: SupabaseClient,
  input: CaseInput,
  ctx: OpsContext,
): Promise<{ row: CaseRow; created: boolean; actionAdded: boolean }> {
  const today = ctx.today ?? bogotaToday();
  let radicado: string | null | undefined;
  if (input.radicado !== undefined) {
    const digits = normalizeRadicado(input.radicado);
    if (digits && !parseRadicado(digits, Number(today.slice(0, 4)))) {
      throw new ValidationError(
        'El radicado de la Rama Judicial tiene 23 dígitos (con un año creíble en las posiciones 13 a 16).',
      );
    }
    radicado = digits || null;
  }
  for (const [label, value] of [
    ['la última actuación', input.lastActionOn],
    ['la próxima diligencia', input.nextHearingOn],
  ] as const) {
    if (value && !ISO.test(value))
      throw new ValidationError(`La fecha de ${label} va como AAAA-MM-DD.`);
  }
  let current: CaseRow | null = null;
  if (input.id) current = await getLegalCase(db, input.id);
  else if (radicado) current = await findLegalCaseByRadicado(db, radicado);

  const patch: Record<string, unknown> = {};
  if (radicado !== undefined) patch.radicado = radicado;
  if (input.title !== undefined) patch.title = input.title.trim().slice(0, 200);
  if (input.court !== undefined) patch.court = input.court?.trim() || null;
  if (input.city !== undefined) patch.city = input.city?.trim() || null;
  if (input.processType !== undefined) patch.process_type = input.processType?.trim() || null;
  if (input.role !== undefined) patch.role = input.role;
  if (input.counterparty !== undefined) patch.counterparty = input.counterparty?.trim() || null;
  if (input.parties !== undefined) patch.parties = input.parties?.trim() || null;
  if (input.claimAmount !== undefined) patch.claim_amount = input.claimAmount;
  if (input.status !== undefined) patch.status = input.status;
  if (input.lastActionOn !== undefined) patch.last_action_on = input.lastActionOn;
  if (input.lastAction !== undefined) patch.last_action = input.lastAction?.trim() || null;
  if (input.nextHearingOn !== undefined) patch.next_hearing_on = input.nextHearingOn;
  if (input.nextHearing !== undefined) patch.next_hearing = input.nextHearing?.trim() || null;
  if (input.lawyer !== undefined) patch.lawyer = input.lawyer?.trim() || null;
  if (input.ownerUserId !== undefined) patch.owner_user_id = input.ownerUserId;
  if (input.checkedVia) {
    patch.last_checked_at = new Date().toISOString();
    patch.last_checked_via = input.checkedVia;
  }

  let row: CaseRow;
  let created = false;
  if (current) {
    row = await updateLegalCase(db, current.id, patch);
  } else {
    const title = (input.title?.trim() || (radicado ? `Proceso ${radicado}` : '')).slice(0, 200);
    if (title.length < 3)
      throw new ValidationError('Dale un nombre al proceso o escribe su radicado.');
    row = await insertLegalCase(db, {
      ...patch,
      title,
      owner_user_id: input.ownerUserId ?? ctx.userId,
      created_by: ctx.userId,
    });
    created = true;
  }

  // La actuación nueva queda en la historia.
  let actionAdded = false;
  if (input.lastActionOn && input.lastAction?.trim()) {
    const changed =
      !current ||
      current.last_action_on !== input.lastActionOn ||
      current.last_action !== input.lastAction.trim();
    if (changed) {
      await insertCaseAction(db, {
        case_id: row.id,
        action_on: input.lastActionOn,
        text: input.lastAction.trim().slice(0, 2000),
        source: input.checkedVia === 'rama_judicial' ? 'rama_judicial' : 'manual',
        created_by: ctx.userId,
      });
      actionAdded = true;
    }
  }

  row = await syncHearing(db, row, ctx);
  return { row, created, actionAdded };
}

/** La próxima diligencia, como vencimiento con responsable. */
async function syncHearing(db: SupabaseClient, row: CaseRow, ctx: OpsContext): Promise<CaseRow> {
  const today = ctx.today ?? bogotaToday();
  const existing = row.hearing_commitment_id
    ? await getCommitment(db, row.hearing_commitment_id)
    : null;
  const open = existing && existing.state !== 'met' && existing.state !== 'dropped';
  const active = row.status === 'activo' || row.status === 'suspendido';
  if (!row.next_hearing_on || !active || row.next_hearing_on < today) {
    if (open && (!active || !row.next_hearing_on)) {
      await dropCommitment(db, {
        id: existing.id,
        reason: 'El proceso ya no tiene esa diligencia.',
        userId: ctx.userId,
      });
    } else if (open && row.next_hearing_on && row.next_hearing_on < today) {
      await markMet(db, {
        id: existing.id,
        userId: ctx.userId,
        note: 'Pasó la fecha de la diligencia.',
        today,
      });
    }
    return row;
  }
  if (open) {
    if (existing.due_on !== row.next_hearing_on) {
      await rescheduleCommitment(db, { id: existing.id, dueOn: row.next_hearing_on, today });
    }
    return row;
  }
  const created = await createCommitment(db, {
    title: `Diligencia: ${row.title}`.slice(0, 200),
    detail: `${row.next_hearing ?? 'Audiencia o diligencia'}${row.court ? ` en ${row.court}` : ''}${row.radicado ? ` (radicado ${row.radicado})` : ''}. Confirma la fecha y la hora con el apoderado o en el expediente.`,
    kind: 'other',
    dueOn: row.next_hearing_on,
    noticeDays: Math.min(10, Math.max(2, daysBetween(today, row.next_hearing_on))),
    counterparty: row.counterparty,
    ownerUserId: row.owner_user_id ?? ctx.userId,
    recurrence: 'none',
    source: { kind: 'manual', userId: ctx.userId },
    createdBy: ctx.userId,
  });
  return updateLegalCase(db, row.id, { hearing_commitment_id: created.id });
}

export async function addLegalCaseAction(
  db: SupabaseClient,
  input: { caseId: string; actionOn: string; text: string; source?: 'manual' | 'rama_judicial' },
  ctx: OpsContext,
): Promise<CaseRow> {
  if (!ISO.test(input.actionOn)) throw new ValidationError('La fecha va como AAAA-MM-DD.');
  const current = await getLegalCase(db, input.caseId);
  if (!current) throw new ValidationError('Ese proceso no existe.');
  await insertCaseAction(db, {
    case_id: current.id,
    action_on: input.actionOn,
    text: input.text.trim().slice(0, 2000),
    source: input.source ?? 'manual',
    created_by: ctx.userId,
  });
  if (!current.last_action_on || input.actionOn >= current.last_action_on) {
    return updateLegalCase(db, current.id, {
      last_action_on: input.actionOn,
      last_action: input.text.trim().slice(0, 1000),
      last_checked_at: new Date().toISOString(),
      last_checked_via: input.source ?? 'manual',
    });
  }
  return current;
}

// ---------------------------------------------------------------------------
// Todo junto
// ---------------------------------------------------------------------------

export interface ComplianceSnapshot {
  profile: ComplianceProfile | null;
  items: ItemRow[];
  progress: AreaProgress[];
  pqrs: PqrsRow[];
  cases: CaseRow[];
}

export async function loadCompliance(
  db: SupabaseClient,
  today: string,
): Promise<ComplianceSnapshot> {
  const [profile, items, pqrs, cases] = await Promise.all([
    readComplianceProfile(db),
    listComplianceItems(db, { limit: 1000 }),
    listPqrs(db, { limit: 500 }),
    listLegalCases(db, { limit: 300 }),
  ]);
  return { profile, items, progress: progressByArea(items, today), pqrs, cases };
}
