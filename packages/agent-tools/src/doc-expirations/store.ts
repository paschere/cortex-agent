import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { bogotaToday } from '../commitments/shape';
import type { VerifiedExpiration } from './detect';
import {
  type Confidence,
  DEFAULT_LEAD_DAYS,
  type ExpirationKind,
  type ExpirationStatus,
  type SubjectKind,
  deriveExpirationStatus,
  expirationTitle,
  isOpenStatus,
  normalizePlate,
  subjectKey,
} from './kinds';

/**
 * Lecturas y escrituras de `document_expirations` y de sus barridos (0184).
 *
 * `db` es SIEMPRE el handle de la empresa (getOrgScopedClient): nada aquí
 * filtra por empresa a mano, y una consulta sin el handle no compila contra
 * la regla de tenencia (tenancy/tables.ts).
 *
 * Toda lectura mira `error`: una lista vacía por una consulta caída se vería
 * igual que «nada vence», y es justo lo contrario.
 */

export const EXPIRATION_COLUMNS =
  'id, document_id, chunk_id, space_id, source, kind, title, subject_kind, subject, subject_key, vehicle_id, client_id, issuer, number, issued_on, expires_on, issued_quote, expires_quote, renewal_lead_days, owner_user_id, status, confidence, needs_review, review_note, confirmed_by, confirmed_at, commitment_id, renewed_by_id, renewed_at, dismissed_reason, model_id, extractor_version, created_by, created_at, updated_at';

export interface ExpirationRow {
  id: string;
  document_id: string | null;
  chunk_id: string | null;
  space_id: string | null;
  source: 'documento' | 'manual';
  kind: ExpirationKind;
  title: string;
  subject_kind: SubjectKind;
  subject: string | null;
  subject_key: string | null;
  vehicle_id: string | null;
  client_id: string | null;
  issuer: string | null;
  number: string | null;
  issued_on: string | null;
  expires_on: string | null;
  issued_quote: string | null;
  expires_quote: string | null;
  renewal_lead_days: number;
  owner_user_id: string | null;
  status: ExpirationStatus;
  confidence: Confidence;
  needs_review: boolean;
  review_note: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  commitment_id: string | null;
  renewed_by_id: string | null;
  renewed_at: string | null;
  dismissed_reason: string | null;
  model_id: string | null;
  extractor_version: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  /** Unidos por `hydrate`, nunca guardados. */
  owner_name?: string | null;
  document_title?: string | null;
  vehicle_plate?: string | null;
  client_name?: string | null;
}

// ---------------------------------------------------------------------------
// Lecturas
// ---------------------------------------------------------------------------

export interface ListExpirationsOptions {
  /** Sólo lo que espera a una persona (true) o sólo lo confirmado (false). */
  needsReview?: boolean;
  /** Incluir renovados y descartados. Por defecto, no. */
  includeClosed?: boolean;
  kind?: ExpirationKind;
  vehicleId?: string;
  clientId?: string;
  ownerUserId?: string;
  expiresBefore?: string;
  limit?: number;
}

export async function listExpirations(
  db: SupabaseClient,
  opts: ListExpirationsOptions = {},
): Promise<ExpirationRow[]> {
  let query = db.from('document_expirations').select(EXPIRATION_COLUMNS);
  if (opts.needsReview !== undefined) query = query.eq('needs_review', opts.needsReview);
  if (!opts.includeClosed) query = query.in('status', ['vigente', 'por_vencer', 'vencido']);
  if (opts.kind) query = query.eq('kind', opts.kind);
  if (opts.vehicleId) query = query.eq('vehicle_id', opts.vehicleId);
  if (opts.clientId) query = query.eq('client_id', opts.clientId);
  if (opts.ownerUserId) query = query.eq('owner_user_id', opts.ownerUserId);
  if (opts.expiresBefore) query = query.lte('expires_on', opts.expiresBefore);
  const { data, error } = await query
    .order('expires_on', { ascending: true })
    .limit(opts.limit ?? 500);
  if (error) throw error;
  return (data ?? []) as ExpirationRow[];
}

export async function getExpiration(db: SupabaseClient, id: string): Promise<ExpirationRow | null> {
  const { data, error } = await db
    .from('document_expirations')
    .select(EXPIRATION_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return (data as ExpirationRow | null) ?? null;
}

/** Nombres, títulos y placas para decirlo en palabras. Cada lectura revisa su error. */
export async function hydrate(db: SupabaseClient, rows: ExpirationRow[]): Promise<ExpirationRow[]> {
  if (rows.length === 0) return rows;
  const ids = (pick: (r: ExpirationRow) => string | null) =>
    [...new Set(rows.map(pick).filter(Boolean))] as string[];
  const userIds = ids((r) => r.owner_user_id);
  const docIds = ids((r) => r.document_id);
  const vehicleIds = ids((r) => r.vehicle_id);
  const clientIds = ids((r) => r.client_id);

  const [users, docs, vehicles, clients] = await Promise.all([
    userIds.length
      ? db.from('users').select('id, name, email').in('id', userIds)
      : Promise.resolve({ data: [], error: null }),
    docIds.length
      ? db.from('kb_documents').select('id, title').in('id', docIds)
      : Promise.resolve({ data: [], error: null }),
    vehicleIds.length
      ? db.from('vehicles').select('id, plate').in('id', vehicleIds)
      : Promise.resolve({ data: [], error: null }),
    clientIds.length
      ? db.from('clients').select('id, name').in('id', clientIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  for (const r of [users, docs, vehicles, clients]) if (r.error) throw r.error;

  const userName = new Map(
    ((users.data ?? []) as Array<{ id: string; name: string | null; email: string }>).map((u) => [
      u.id,
      u.name?.trim() || u.email,
    ]),
  );
  const docTitle = new Map(
    ((docs.data ?? []) as Array<{ id: string; title: string }>).map((d) => [d.id, d.title]),
  );
  const plate = new Map(
    ((vehicles.data ?? []) as Array<{ id: string; plate: string }>).map((v) => [v.id, v.plate]),
  );
  const clientName = new Map(
    ((clients.data ?? []) as Array<{ id: string; name: string }>).map((c) => [c.id, c.name]),
  );
  return rows.map((r) => ({
    ...r,
    owner_name: r.owner_user_id ? (userName.get(r.owner_user_id) ?? null) : null,
    document_title: r.document_id ? (docTitle.get(r.document_id) ?? null) : null,
    vehicle_plate: r.vehicle_id ? (plate.get(r.vehicle_id) ?? null) : null,
    client_name: r.client_id ? (clientName.get(r.client_id) ?? null) : null,
  }));
}

// ---------------------------------------------------------------------------
// A qué cosa de Cortex pertenece el sujeto
// ---------------------------------------------------------------------------

export interface SubjectLinks {
  vehicleId: string | null;
  vehicleOwnerId: string | null;
  clientId: string | null;
  clientOwnerId: string | null;
}

/**
 * La placa → el vehículo de la flota; el nombre → el cliente, sólo si el
 * nombre es EXACTAMENTE el de un cliente (sin mayúsculas ni puntuación). Un
 * vínculo que no se ganó es peor que ninguno (0075): un parecido no cuenta.
 */
export async function resolveSubject(
  db: SupabaseClient,
  subjectKind: SubjectKind,
  subject: string | null,
): Promise<SubjectLinks> {
  const none: SubjectLinks = {
    vehicleId: null,
    vehicleOwnerId: null,
    clientId: null,
    clientOwnerId: null,
  };
  if (!subject) return none;
  if (subjectKind === 'vehiculo') {
    const plate = normalizePlate(subject);
    if (!plate) return none;
    const { data, error } = await db
      .from('vehicles')
      .select('id, user_id')
      .eq('plate', plate)
      .eq('archived', false)
      .limit(1);
    if (error) throw error;
    const row = (data ?? [])[0] as { id: string; user_id: string } | undefined;
    return row ? { ...none, vehicleId: row.id, vehicleOwnerId: row.user_id } : none;
  }
  if (subjectKind === 'cliente') {
    const key = subjectKey(subject);
    if (key.length < 3) return none;
    const { data, error } = await db.from('clients').select('id, name, owner_user_id').limit(2000);
    if (error) throw error;
    const rows = (data ?? []) as Array<{ id: string; name: string; owner_user_id: string | null }>;
    const matches = rows.filter((c) => subjectKey(c.name) === key);
    // Dos clientes con el mismo nombre: no se elige.
    if (matches.length !== 1) return none;
    const only = matches[0] as (typeof rows)[number];
    return { ...none, clientId: only.id, clientOwnerId: only.owner_user_id };
  }
  return none;
}

// ---------------------------------------------------------------------------
// Escrituras
// ---------------------------------------------------------------------------

export interface SaveDetectedInput {
  documentId: string;
  spaceId: string | null;
  items: VerifiedExpiration[];
  /** Quien subió el documento: responde mientras nadie diga otra cosa. */
  uploaderId: string | null;
  modelId: string | null;
  extractorVersion: string;
}

/**
 * Guarda lo leído de un documento. Idempotente: la misma lectura del mismo
 * documento actualiza su fila (documento, tipo, sujeto) en vez de duplicarla,
 * y una fila que una persona ya confirmó o descartó NO se toca — su decisión
 * vale más que una relectura.
 */
export async function saveDetected(
  db: SupabaseClient,
  input: SaveDetectedInput,
  today: string = bogotaToday(),
): Promise<ExpirationRow[]> {
  const { data: existingData, error: existingError } = await db
    .from('document_expirations')
    .select(EXPIRATION_COLUMNS)
    .eq('document_id', input.documentId)
    .limit(20);
  if (existingError) throw existingError;
  const existing = (existingData ?? []) as ExpirationRow[];

  const saved: ExpirationRow[] = [];
  for (const item of input.items) {
    const links = await resolveSubject(db, item.subjectKind, item.subject);
    const owner = links.vehicleOwnerId ?? links.clientOwnerId ?? input.uploaderId;
    const leadDays = DEFAULT_LEAD_DAYS[item.kind];
    const fields = {
      chunk_id: item.chunkId,
      space_id: input.spaceId,
      kind: item.kind,
      title: expirationTitle({
        kind: item.kind,
        subject: item.subject,
        issuer: item.issuer,
        label: item.label,
      }),
      subject_kind: item.subjectKind,
      subject: item.subject,
      vehicle_id: links.vehicleId,
      client_id: links.clientId,
      issuer: item.issuer,
      number: item.number,
      issued_on: item.issuedOn,
      expires_on: item.expiresOn,
      issued_quote: item.issuedQuote,
      expires_quote: item.expiresQuote,
      confidence: item.confidence,
      review_note: item.reviewNote,
      status: deriveExpirationStatus(
        { expires_on: item.expiresOn, renewal_lead_days: leadDays },
        today,
      ),
      model_id: input.modelId,
      extractor_version: input.extractorVersion,
      updated_at: new Date().toISOString(),
    };

    const key = subjectKey(item.subject);
    const prior = existing.find((r) => r.kind === item.kind && subjectKey(r.subject) === key);
    if (prior) {
      if (!prior.needs_review || prior.status === 'descartado') {
        saved.push(prior);
        continue;
      }
      const { data, error } = await db
        .from('document_expirations')
        .update(fields)
        .eq('id', prior.id)
        .select(EXPIRATION_COLUMNS)
        .single();
      if (error) throw error;
      saved.push(data as ExpirationRow);
      continue;
    }
    const { data, error } = await db
      .from('document_expirations')
      .insert({
        ...fields,
        document_id: input.documentId,
        source: 'documento',
        renewal_lead_days: leadDays,
        owner_user_id: owner,
        needs_review: true,
        created_by: input.uploaderId,
      })
      .select(EXPIRATION_COLUMNS)
      .single();
    if (error) {
      // Otra lectura del mismo documento llegó primero (índice único de
      // 0184): la suya vale.
      if ((error as { code?: string }).code === '23505') continue;
      throw error;
    }
    saved.push(data as ExpirationRow);
  }
  return saved;
}

export interface ConfirmInput {
  id: string;
  userId: string;
  /** Lo que la persona corrige al confirmar. La cita queda como estaba. */
  expiresOn?: string | null;
  issuedOn?: string | null;
  kind?: ExpirationKind;
  subject?: string | null;
  subjectKind?: SubjectKind;
  ownerUserId?: string | null;
  renewalLeadDays?: number | null;
  today?: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Una persona da por buena la fecha (o la corrige). Desde aquí se vigila.
 * Lo que pase después — el vencimiento en `commitments`, cerrar el papel
 * anterior — lo hace `afterConfirm` en sync.ts.
 */
export async function confirmExpirationRow(
  db: SupabaseClient,
  input: ConfirmInput,
): Promise<ExpirationRow> {
  const current = await getExpiration(db, input.id);
  if (!current) throw new NotFoundError('Ese vencimiento ya no existe.');
  if (current.status === 'descartado') {
    throw new ValidationError('Ese documento ya se descartó; regístralo de nuevo si sí vence.');
  }
  const expiresOn = input.expiresOn ?? current.expires_on;
  if (!expiresOn || !ISO.test(expiresOn)) {
    throw new ValidationError(
      'Falta la fecha de vencimiento: el documento no la dice con día, mes y año. Escríbela para confirmar.',
    );
  }
  const issuedOn = input.issuedOn === undefined ? current.issued_on : input.issuedOn;
  if (issuedOn && issuedOn > expiresOn) {
    throw new ValidationError('La fecha de expedición no puede ser posterior al vencimiento.');
  }
  const kind = input.kind ?? current.kind;
  const subject = input.subject === undefined ? current.subject : input.subject?.trim() || null;
  const subjectKind = input.subjectKind ?? current.subject_kind;
  const leadDays =
    input.renewalLeadDays ??
    (input.kind && input.kind !== current.kind
      ? DEFAULT_LEAD_DAYS[kind]
      : current.renewal_lead_days);
  const today = input.today ?? bogotaToday();
  const now = new Date().toISOString();

  const patch: Record<string, unknown> = {
    expires_on: expiresOn,
    issued_on: issuedOn,
    kind,
    subject,
    subject_kind: subjectKind,
    renewal_lead_days: leadDays,
    needs_review: false,
    confirmed_by: input.userId,
    confirmed_at: now,
    status: deriveExpirationStatus({ expires_on: expiresOn, renewal_lead_days: leadDays }, today),
    updated_at: now,
  };
  if (input.ownerUserId !== undefined) patch.owner_user_id = input.ownerUserId;
  if (!current.owner_user_id && input.ownerUserId === undefined) patch.owner_user_id = input.userId;
  if (subject !== current.subject || subjectKind !== current.subject_kind) {
    const links = await resolveSubject(db, subjectKind, subject);
    patch.vehicle_id = links.vehicleId;
    patch.client_id = links.clientId;
  }
  if (kind !== current.kind || subject !== current.subject) {
    patch.title = expirationTitle({ kind, subject, issuer: current.issuer });
  }

  const { data, error } = await db
    .from('document_expirations')
    .update(patch)
    .eq('id', input.id)
    .select(EXPIRATION_COLUMNS)
    .single();
  if (error) throw error;
  return data as ExpirationRow;
}

export interface TrackManualInput {
  userId: string;
  kind: ExpirationKind;
  expiresOn: string;
  subject?: string | null;
  subjectKind?: SubjectKind;
  issuer?: string | null;
  number?: string | null;
  issuedOn?: string | null;
  ownerUserId?: string | null;
  renewalLeadDays?: number | null;
  documentId?: string | null;
  label?: string | null;
  today?: string;
}

/** Un papel que alguien registra a mano: nace confirmado por esa persona. */
export async function insertManual(
  db: SupabaseClient,
  input: TrackManualInput,
): Promise<ExpirationRow> {
  if (!ISO.test(input.expiresOn)) {
    throw new ValidationError(
      `La fecha de vencimiento va como AAAA-MM-DD; llegó «${input.expiresOn}».`,
    );
  }
  if (input.issuedOn && input.issuedOn > input.expiresOn) {
    throw new ValidationError('La fecha de expedición no puede ser posterior al vencimiento.');
  }
  const subjectKind =
    input.subjectKind ??
    (input.kind === 'soat' || input.kind === 'tecnomecanica' ? 'vehiculo' : 'empresa');
  const subject =
    subjectKind === 'vehiculo'
      ? (normalizePlate(input.subject) ?? input.subject?.trim() ?? null)
      : input.subject?.trim() || null;
  const links = await resolveSubject(db, subjectKind, subject);
  const leadDays = input.renewalLeadDays ?? DEFAULT_LEAD_DAYS[input.kind];
  const now = new Date().toISOString();
  const today = input.today ?? bogotaToday();
  const { data, error } = await db
    .from('document_expirations')
    .insert({
      document_id: input.documentId ?? null,
      source: 'manual',
      kind: input.kind,
      title: expirationTitle({
        kind: input.kind,
        subject,
        issuer: input.issuer,
        label: input.label,
      }),
      subject_kind: subjectKind,
      subject,
      vehicle_id: links.vehicleId,
      client_id: links.clientId,
      issuer: input.issuer?.trim() || null,
      number: input.number?.trim() || null,
      issued_on: input.issuedOn ?? null,
      expires_on: input.expiresOn,
      renewal_lead_days: leadDays,
      owner_user_id:
        input.ownerUserId ?? links.vehicleOwnerId ?? links.clientOwnerId ?? input.userId,
      status: deriveExpirationStatus(
        { expires_on: input.expiresOn, renewal_lead_days: leadDays },
        today,
      ),
      confidence: 'alta',
      needs_review: false,
      confirmed_by: input.userId,
      confirmed_at: now,
      created_by: input.userId,
    })
    .select(EXPIRATION_COLUMNS)
    .single();
  if (error) throw error;
  return data as ExpirationRow;
}

/** «Esto no es un papel que vence» o «ya no aplica». */
export async function dismissExpiration(
  db: SupabaseClient,
  input: { id: string; reason: string },
): Promise<ExpirationRow> {
  const { data, error } = await db
    .from('document_expirations')
    .update({
      status: 'descartado',
      dismissed_reason: input.reason.trim().slice(0, 500) || 'Sin motivo registrado',
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.id)
    .select(EXPIRATION_COLUMNS)
    .single();
  if (error) throw error;
  return data as ExpirationRow;
}

/** Los papeles abiertos del mismo tipo y sujeto, para cerrar los que renueva uno nuevo. */
export async function openSiblings(
  db: SupabaseClient,
  row: ExpirationRow,
  today: string,
): Promise<ExpirationRow[]> {
  const key = subjectKey(row.subject);
  // Sin sujeto, «el mismo papel» es demasiado vago para cerrar nada solo,
  // salvo que sea de la empresa (una sola licencia de funcionamiento).
  if (!key && row.subject_kind !== 'empresa') return [];
  const { data, error } = await db
    .from('document_expirations')
    .select(EXPIRATION_COLUMNS)
    .eq('kind', row.kind)
    .eq('needs_review', false)
    .in('status', ['vigente', 'por_vencer', 'vencido'])
    .limit(300);
  if (error) throw error;
  return ((data ?? []) as ExpirationRow[]).filter(
    (r) =>
      r.id !== row.id &&
      subjectKey(r.subject) === key &&
      (key || r.subject_kind === 'empresa') &&
      r.expires_on != null &&
      row.expires_on != null &&
      r.expires_on < row.expires_on &&
      isOpenStatus(deriveExpirationStatus(r, today)),
  );
}

export async function markRenewed(
  db: SupabaseClient,
  input: { oldId: string; newId: string },
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await db
    .from('document_expirations')
    .update({ status: 'renovado', renewed_by_id: input.newId, renewed_at: now, updated_at: now })
    .eq('id', input.oldId);
  if (error) throw error;
}

export async function setCommitmentLink(
  db: SupabaseClient,
  id: string,
  commitmentId: string | null,
): Promise<void> {
  const { error } = await db
    .from('document_expirations')
    .update({ commitment_id: commitmentId, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

/** Cambia responsable o anticipación de un papel ya confirmado. */
export async function updateExpirationFields(
  db: SupabaseClient,
  id: string,
  patch: { ownerUserId?: string | null; renewalLeadDays?: number },
): Promise<ExpirationRow> {
  const values: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.ownerUserId !== undefined) values.owner_user_id = patch.ownerUserId;
  if (patch.renewalLeadDays !== undefined) {
    if (patch.renewalLeadDays < 0 || patch.renewalLeadDays > 365) {
      throw new ValidationError('La anticipación va de 0 a 365 días.');
    }
    values.renewal_lead_days = patch.renewalLeadDays;
  }
  const { data, error } = await db
    .from('document_expirations')
    .update(values)
    .eq('id', id)
    .select(EXPIRATION_COLUMNS)
    .single();
  if (error) throw error;
  return data as ExpirationRow;
}

// ---------------------------------------------------------------------------
// Barridos
// ---------------------------------------------------------------------------

export type ScanOutcome = 'queued' | 'found' | 'none' | 'skipped' | 'failed';

export interface ScanRow {
  id: string;
  document_id: string;
  outcome: ScanOutcome;
  model_called: boolean;
  detail: string | null;
  renews_expiration_id: string | null;
  extractor_version: string | null;
  scanned_at: string | null;
}

const SCAN_COLUMNS =
  'id, document_id, outcome, model_called, detail, renews_expiration_id, extractor_version, scanned_at';

export async function getScan(db: SupabaseClient, documentId: string): Promise<ScanRow | null> {
  const { data, error } = await db
    .from('document_expiration_scans')
    .select(SCAN_COLUMNS)
    .eq('document_id', documentId)
    .maybeSingle();
  if (error) throw error;
  return (data as ScanRow | null) ?? null;
}

export async function recordScan(
  db: SupabaseClient,
  input: {
    documentId: string;
    outcome: ScanOutcome;
    modelCalled?: boolean;
    detail?: string | null;
    renewsExpirationId?: string | null;
    extractorVersion?: string | null;
  },
): Promise<void> {
  const now = new Date().toISOString();
  const values: Record<string, unknown> = {
    outcome: input.outcome,
    model_called: input.modelCalled ?? false,
    detail: input.detail?.slice(0, 600) ?? null,
    extractor_version: input.extractorVersion ?? null,
    scanned_at: input.outcome === 'queued' ? null : now,
    updated_at: now,
  };
  if (input.renewsExpirationId !== undefined)
    values.renews_expiration_id = input.renewsExpirationId;
  const prior = await getScan(db, input.documentId);
  if (prior) {
    const { error } = await db.from('document_expiration_scans').update(values).eq('id', prior.id);
    if (error) throw error;
    return;
  }
  const { error } = await db
    .from('document_expiration_scans')
    .insert({ ...values, document_id: input.documentId });
  if (error && (error as { code?: string }).code !== '23505') throw error;
}
