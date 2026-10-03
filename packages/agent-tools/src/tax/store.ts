import { ForbiddenError, NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isCompanyManager } from '../directory/store';
import {
  type ObligationKind,
  type ObligationStatus,
  type TaxObligation,
  type TaxProfile,
  type TaxProfileInput,
  nitCheckDigit,
  splitNit,
  taxProfileInputSchema,
} from './shape';

/**
 * LECTURAS Y ESCRITURAS DEL CALENDARIO TRIBUTARIO (tablas de la migración 0180).
 *
 * `db` es siempre el handle de la empresa (getOrgScopedClient en la app, o
 * `ctx.db` en una herramienta): nada aquí filtra por organization_id a mano.
 *
 * LA REGLA DEL PERMISO VIVE AQUÍ, no en la pantalla ni en la herramienta:
 * cambiar el perfil tributario es cosa de quien administra la empresa o es su
 * dueño (`isCompanyManager`). La herramienta `tax.configure` y la acción de
 * /impuestos llaman a `saveTaxProfile`; ninguna puede saltarse la revisión.
 * Marcar una obligación presentada o pagada lo puede hacer el responsable de
 * los impuestos o quien administra (`markTaxObligation`).
 */

// ---------------------------------------------------------------------------
// El perfil
// ---------------------------------------------------------------------------

export const TAX_PROFILE_COLUMNS =
  'nit, dv, person_type, gran_contribuyente, regimen_simple, iva_periodicity, agente_retencion, ica_city, ica_periodicity, exogena, activos_exterior, camara_comercio, nomina_electronica, pila, facturacion_electronica, owner_user_id, notice_days, source, source_document_id, updated_by, updated_at';

interface ProfileRow {
  nit: string;
  dv: string | null;
  person_type: TaxProfile['personType'];
  gran_contribuyente: boolean;
  regimen_simple: boolean;
  iva_periodicity: TaxProfile['ivaPeriodicity'];
  agente_retencion: boolean;
  ica_city: TaxProfile['icaCity'];
  ica_periodicity: TaxProfile['icaPeriodicity'];
  exogena: boolean;
  activos_exterior: boolean;
  camara_comercio: boolean;
  nomina_electronica: boolean;
  pila: boolean;
  facturacion_electronica: boolean;
  owner_user_id: string | null;
  notice_days: number;
  source: 'manual' | 'rut';
  source_document_id: string | null;
  updated_by: string | null;
  updated_at: string | null;
}

export function rowToProfile(row: ProfileRow): TaxProfile {
  return {
    nit: row.nit,
    dv: row.dv,
    personType: row.person_type,
    granContribuyente: row.gran_contribuyente,
    regimenSimple: row.regimen_simple,
    ivaPeriodicity: row.iva_periodicity,
    agenteRetencion: row.agente_retencion,
    icaCity: row.ica_city,
    icaPeriodicity: row.ica_periodicity,
    exogena: row.exogena,
    activosExterior: row.activos_exterior,
    camaraComercio: row.camara_comercio,
    nominaElectronica: row.nomina_electronica,
    pila: row.pila,
    facturacionElectronica: row.facturacion_electronica,
    ownerUserId: row.owner_user_id,
    noticeDays: row.notice_days,
    source: row.source,
    sourceDocumentId: row.source_document_id,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

export async function readTaxProfile(db: SupabaseClient): Promise<TaxProfile | null> {
  const { data, error } = await db.from('tax_profiles').select(TAX_PROFILE_COLUMNS).maybeSingle();
  if (error) throw error;
  return data ? rowToProfile(data as ProfileRow) : null;
}

/**
 * Valida y normaliza lo que llega del chat o del formulario. Pura: devuelve el
 * perfil listo para guardar o lanza `ValidationError` con una frase.
 */
export function normalizeProfileInput(
  input: TaxProfileInput,
): Omit<TaxProfile, 'updatedAt' | 'updatedBy'> {
  const parsed = taxProfileInputSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `Hay un dato del perfil tributario que no entiendo${first ? ` (${first.path.join('.')})` : ''}.`,
    );
  }
  const p = parsed.data;
  const { nit, dv } = splitNit(p.nit, p.dv);
  if (!/^\d{5,15}$/.test(nit))
    throw new ValidationError('El NIT tiene que tener entre 5 y 15 dígitos, sin letras.');
  if (dv !== null && dv !== nitCheckDigit(nit))
    throw new ValidationError(
      `El dígito de verificación no cuadra con ese NIT (debería ser ${nitCheckDigit(nit)}). Revisa que el NIT esté bien copiado del RUT.`,
    );
  // El ICA: sin ciudad no hay periodicidad; Bogotá elige, las demás tienen una.
  const icaCity = p.icaCity ?? null;
  let icaPeriodicity = p.icaPeriodicity ?? null;
  if (!icaCity || icaCity === 'otra') icaPeriodicity = null;
  else if (icaCity === 'bogota') icaPeriodicity = icaPeriodicity ?? 'bimestral';
  else icaPeriodicity = icaPeriodicity ?? 'anual';
  return {
    nit,
    dv,
    personType: p.personType,
    granContribuyente: p.granContribuyente,
    regimenSimple: p.regimenSimple,
    ivaPeriodicity: p.ivaPeriodicity,
    agenteRetencion: p.agenteRetencion,
    icaCity,
    icaPeriodicity,
    exogena: p.exogena,
    activosExterior: p.activosExterior,
    camaraComercio: p.camaraComercio,
    nominaElectronica: p.nominaElectronica,
    pila: p.pila,
    facturacionElectronica: p.facturacionElectronica,
    ownerUserId: p.ownerUserId ?? null,
    noticeDays: p.noticeDays,
    source: p.source,
    sourceDocumentId: p.sourceDocumentId ?? null,
  };
}

/** Guarda el perfil. Sólo quien administra o es dueño. No sincroniza: eso es sync.ts. */
export async function saveTaxProfile(
  db: SupabaseClient,
  input: TaxProfileInput,
  opts: { userId: string },
): Promise<TaxProfile> {
  if (!(await isCompanyManager(db, opts.userId)))
    throw new ForbiddenError(
      'Sólo quien administra la empresa o es su dueño puede cambiar el perfil tributario.',
    );
  const p = normalizeProfileInput(input);
  if (p.ownerUserId) {
    const { data, error } = await db
      .from('users')
      .select('id')
      .eq('id', p.ownerUserId)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new ValidationError('Esa persona no está en esta empresa.');
  }
  const { data, error } = await db
    .from('tax_profiles')
    .upsert(
      {
        nit: p.nit,
        dv: p.dv,
        person_type: p.personType,
        gran_contribuyente: p.granContribuyente,
        regimen_simple: p.regimenSimple,
        iva_periodicity: p.ivaPeriodicity,
        agente_retencion: p.agenteRetencion,
        ica_city: p.icaCity,
        ica_periodicity: p.icaPeriodicity,
        exogena: p.exogena,
        activos_exterior: p.activosExterior,
        camara_comercio: p.camaraComercio,
        nomina_electronica: p.nominaElectronica,
        pila: p.pila,
        facturacion_electronica: p.facturacionElectronica,
        owner_user_id: p.ownerUserId,
        notice_days: p.noticeDays,
        source: p.source,
        source_document_id: p.sourceDocumentId,
        updated_by: opts.userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'organization_id' },
    )
    .select(TAX_PROFILE_COLUMNS)
    .single();
  if (error) throw error;
  return rowToProfile(data as ProfileRow);
}

// ---------------------------------------------------------------------------
// Las obligaciones
// ---------------------------------------------------------------------------

export const TAX_OBLIGATION_COLUMNS =
  'id, year, obligation_key, kind, period, title, authority, form, due_date, requires_payment, needs_confirmation, rule_version, source_note, status, status_at, status_by, status_note, evidence_document_id, evidence_url, commitment_id';

export interface ObligationRow {
  id: string;
  year: number;
  obligation_key: string;
  kind: ObligationKind;
  period: string;
  title: string;
  authority: string;
  form: string | null;
  due_date: string;
  requires_payment: boolean;
  needs_confirmation: boolean;
  rule_version: string;
  source_note: string | null;
  status: ObligationStatus;
  status_at: string | null;
  status_by: string | null;
  status_note: string | null;
  evidence_document_id: string | null;
  evidence_url: string | null;
  commitment_id: string | null;
}

export function rowToObligation(row: ObligationRow): TaxObligation {
  return {
    id: row.id,
    key: row.obligation_key,
    year: row.year,
    kind: row.kind,
    period: row.period,
    title: row.title,
    authority: row.authority,
    form: row.form,
    dueDate: row.due_date,
    requiresPayment: row.requires_payment,
    needsConfirmation: row.needs_confirmation,
    ruleVersion: row.rule_version,
    sourceNote: row.source_note,
    status: row.status,
    statusAt: row.status_at,
    statusBy: row.status_by,
    statusNote: row.status_note,
    evidenceDocumentId: row.evidence_document_id,
    evidenceUrl: row.evidence_url,
    commitmentId: row.commitment_id,
  };
}

export interface ListObligationsOptions {
  year?: number;
  from?: string;
  to?: string;
  statuses?: ObligationStatus[];
  kinds?: ObligationKind[];
  limit?: number;
}

export async function listTaxObligations(
  db: SupabaseClient,
  opts: ListObligationsOptions = {},
): Promise<TaxObligation[]> {
  let q = db.from('tax_obligations').select(TAX_OBLIGATION_COLUMNS);
  if (opts.year) q = q.eq('year', opts.year);
  if (opts.from) q = q.gte('due_date', opts.from);
  if (opts.to) q = q.lte('due_date', opts.to);
  if (opts.statuses?.length) q = q.in('status', opts.statuses);
  if (opts.kinds?.length) q = q.in('kind', opts.kinds);
  const { data, error } = await q
    .order('due_date', { ascending: true })
    .order('obligation_key', { ascending: true })
    .limit(opts.limit ?? 500);
  if (error) throw error;
  return ((data ?? []) as ObligationRow[]).map(rowToObligation);
}

export async function getTaxObligation(
  db: SupabaseClient,
  id: string,
): Promise<TaxObligation | null> {
  const { data, error } = await db
    .from('tax_obligations')
    .select(TAX_OBLIGATION_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToObligation(data as ObligationRow) : null;
}

/**
 * Puede marcar obligaciones quien responde por los impuestos (el dueño del
 * perfil) o quien administra la empresa.
 */
export async function canMarkTaxObligations(
  db: SupabaseClient,
  userId: string,
  profile: Pick<TaxProfile, 'ownerUserId'> | null,
): Promise<boolean> {
  if (profile?.ownerUserId && profile.ownerUserId === userId) return true;
  return isCompanyManager(db, userId);
}

export interface MarkObligationInput {
  id: string;
  status: ObligationStatus;
  note?: string | null;
  evidenceDocumentId?: string | null;
  evidenceUrl?: string | null;
  userId: string;
}

/**
 * Cambia el estado de una obligación, con su evidencia. No toca el
 * vencimiento: eso lo hace sync.ts `settleCommitmentFor`, para que el cierre
 * del vencimiento sea el mismo desde la pantalla y desde el chat.
 */
export async function updateObligationStatus(
  db: SupabaseClient,
  input: MarkObligationInput,
): Promise<TaxObligation> {
  const current = await getTaxObligation(db, input.id);
  if (!current) throw new NotFoundError('Esa obligación ya no existe.');
  const url = input.evidenceUrl?.trim() || null;
  if (url && !/^https?:\/\/\S+$/.test(url))
    throw new ValidationError('La evidencia tiene que ser un enlace que empiece por https://');
  if (input.evidenceDocumentId) {
    const { data, error } = await db
      .from('kb_documents')
      .select('id')
      .eq('id', input.evidenceDocumentId)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new ValidationError('No encuentro ese documento en el Cerebro.');
  }
  const now = new Date().toISOString();
  const pending = input.status === 'pendiente';
  const { data, error } = await db
    .from('tax_obligations')
    .update({
      status: input.status,
      status_at: pending ? null : now,
      status_by: pending ? null : input.userId,
      status_note: input.note?.trim().slice(0, 500) || null,
      // La evidencia se conserva si no llega una nueva: marcar «pagada»
      // después de «presentada» no borra el formulario ya adjunto.
      evidence_document_id: input.evidenceDocumentId ?? current.evidenceDocumentId,
      evidence_url: url ?? current.evidenceUrl,
      updated_at: now,
    })
    .eq('id', input.id)
    .select(TAX_OBLIGATION_COLUMNS)
    .single();
  if (error) throw error;
  return rowToObligation(data as ObligationRow);
}
