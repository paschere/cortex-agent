import { ForbiddenError, NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { WithholdingCertificate } from './certificates';
import { DRAFT_FORM, type DraftFigures, type DraftKind, type DraftStatus } from './draft-shape';
import type { TaxObligation } from './shape';
import { canMarkTaxObligations, readTaxProfile } from './store';
import { markTaxObligation } from './sync';

/**
 * LOS BORRADORES Y LOS CERTIFICADOS GUARDADOS (tablas de la migración 0197).
 *
 * `db` es el handle de la empresa. EL PERMISO VIVE AQUÍ: guardar, marcar
 * revisado, presentado o anulado lo puede hacer quien responde por los
 * impuestos (el contador del perfil) o quien administra la empresa
 * (`canMarkTaxObligations`, el mismo de marcar una obligación).
 *
 * Un borrador revisado o presentado no se reescribe: sus cifras son las que vio
 * el contador. Para rehacerlo se anula y se arma otro.
 */

export const TAX_DRAFT_COLUMNS =
  'id, obligation_id, form_kind, form, period_start, period_end, period_label, status, figures, rules_version, result_amount, notes, created_by, reviewed_by, reviewed_at, presented_by, presented_at, evidence_document_id, evidence_url, created_at, updated_at';

interface DraftRow {
  id: string;
  obligation_id: string | null;
  form_kind: DraftKind;
  form: string | null;
  period_start: string;
  period_end: string;
  period_label: string;
  status: DraftStatus;
  figures: DraftFigures;
  rules_version: string;
  result_amount: number | string;
  notes: string | null;
  created_by: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  presented_by: string | null;
  presented_at: string | null;
  evidence_document_id: string | null;
  evidence_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaxDraftRecord {
  id: string;
  obligationId: string | null;
  kind: DraftKind;
  form: string | null;
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
  status: DraftStatus;
  figures: DraftFigures;
  rulesVersion: string;
  resultAmount: number;
  notes: string | null;
  createdBy: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  presentedBy: string | null;
  presentedAt: string | null;
  evidenceDocumentId: string | null;
  evidenceUrl: string | null;
  updatedAt: string;
}

function adapt(r: DraftRow): TaxDraftRecord {
  return {
    id: r.id,
    obligationId: r.obligation_id,
    kind: r.form_kind,
    form: r.form,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    periodLabel: r.period_label,
    status: r.status,
    figures: r.figures,
    rulesVersion: r.rules_version,
    resultAmount: Number(r.result_amount) || 0,
    notes: r.notes,
    createdBy: r.created_by,
    reviewedBy: r.reviewed_by,
    reviewedAt: r.reviewed_at,
    presentedBy: r.presented_by,
    presentedAt: r.presented_at,
    evidenceDocumentId: r.evidence_document_id,
    evidenceUrl: r.evidence_url,
    updatedAt: r.updated_at,
  };
}

async function requireTaxRole(db: SupabaseClient, userId: string): Promise<void> {
  const profile = await readTaxProfile(db);
  if (!(await canMarkTaxObligations(db, userId, profile)))
    throw new ForbiddenError(
      'Los borradores los guarda y los marca quien responde por los impuestos o quien administra la empresa.',
    );
}

export async function getTaxDraft(db: SupabaseClient, id: string): Promise<TaxDraftRecord | null> {
  const { data, error } = await db
    .from('tax_drafts')
    .select(TAX_DRAFT_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data ? adapt(data as DraftRow) : null;
}

/** El borrador vivo (no anulado) de una obligación. */
export async function liveDraftFor(
  db: SupabaseClient,
  obligationId: string,
): Promise<TaxDraftRecord | null> {
  const { data, error } = await db
    .from('tax_drafts')
    .select(TAX_DRAFT_COLUMNS)
    .eq('obligation_id', obligationId)
    .neq('status', 'anulado')
    .maybeSingle();
  if (error) throw error;
  return data ? adapt(data as DraftRow) : null;
}

/** Estado del borrador vivo de varias obligaciones (para pintar la lista). */
export async function draftStatusByObligation(
  db: SupabaseClient,
  obligationIds: string[],
): Promise<Map<string, DraftStatus>> {
  const out = new Map<string, DraftStatus>();
  for (let i = 0; i < obligationIds.length; i += 300) {
    const { data, error } = await db
      .from('tax_drafts')
      .select('obligation_id, status')
      .in('obligation_id', obligationIds.slice(i, i + 300))
      .neq('status', 'anulado');
    if (error) {
      // Antes de aplicar 0197 la tabla no existe: no hay borradores, no es un error.
      const code = (error as { code?: string }).code;
      if (code === '42P01' || code === 'PGRST205') return out;
      throw error;
    }
    for (const r of (data ?? []) as Array<{ obligation_id: string; status: DraftStatus }>)
      out.set(r.obligation_id, r.status);
  }
  return out;
}

interface SaveDraftInput {
  obligation: Pick<TaxObligation, 'id'> | null;
  figures: DraftFigures;
  userId: string;
  notes?: string | null;
}

/**
 * Guarda (o rehace) el borrador de una obligación como «borrador». Si ya hay
 * uno revisado o presentado, no lo toca.
 */
export async function saveTaxDraft(
  db: SupabaseClient,
  input: SaveDraftInput,
): Promise<TaxDraftRecord> {
  await requireTaxRole(db, input.userId);
  const f = input.figures;
  const now = new Date().toISOString();
  const row = {
    obligation_id: input.obligation?.id ?? null,
    form_kind: f.kind,
    form: DRAFT_FORM[f.kind],
    period_start: f.period.from,
    period_end: f.period.to,
    period_label: f.period.label.slice(0, 80),
    status: 'borrador' as const,
    figures: f,
    rules_version: f.rulesVersion,
    result_amount: f.result.amount,
    notes: input.notes?.trim().slice(0, 2000) || null,
    updated_at: now,
  };
  const live = input.obligation ? await liveDraftFor(db, input.obligation.id) : null;
  if (live) {
    if (live.status !== 'borrador')
      throw new ValidationError(
        `Ese borrador ya está ${live.status === 'revisado' ? 'revisado por el contador' : 'presentado'}: sus cifras no se reescriben. Anúlalo si hay que rehacerlo.`,
      );
    const { data, error } = await db
      .from('tax_drafts')
      .update({ ...row, notes: row.notes ?? live.notes })
      .eq('id', live.id)
      .eq('status', 'borrador')
      .select(TAX_DRAFT_COLUMNS)
      .single();
    if (error) throw error;
    return adapt(data as DraftRow);
  }
  const { data, error } = await db
    .from('tax_drafts')
    .insert({ ...row, created_by: input.userId })
    .select(TAX_DRAFT_COLUMNS)
    .single();
  if (error) throw error;
  return adapt(data as DraftRow);
}

/**
 * «Revisado por el contador»: congela las cifras que vio (las que llegan, o
 * las guardadas si no llegan nuevas).
 */
export async function markDraftReviewed(
  db: SupabaseClient,
  input: {
    obligation: Pick<TaxObligation, 'id'> | null;
    figures: DraftFigures | null;
    userId: string;
    notes?: string | null;
    draftId?: string | null;
  },
): Promise<TaxDraftRecord> {
  await requireTaxRole(db, input.userId);
  let draft = input.draftId ? await getTaxDraft(db, input.draftId) : null;
  if (!draft && input.obligation) draft = await liveDraftFor(db, input.obligation.id);
  if (!draft) {
    if (!input.figures) throw new NotFoundError('No hay borrador que marcar.');
    draft = await saveTaxDraft(db, {
      obligation: input.obligation,
      figures: input.figures,
      userId: input.userId,
      notes: input.notes,
    });
  } else if (draft.status === 'borrador' && input.figures) {
    draft = await saveTaxDraft(db, {
      obligation: input.obligation,
      figures: input.figures,
      userId: input.userId,
      notes: input.notes,
    });
  }
  if (draft.status === 'presentado' || draft.status === 'anulado')
    throw new ValidationError(`Ese borrador ya está ${draft.status}.`);
  if (draft.status === 'revisado') return draft;
  const now = new Date().toISOString();
  const { data, error } = await db
    .from('tax_drafts')
    .update({ status: 'revisado', reviewed_by: input.userId, reviewed_at: now, updated_at: now })
    .eq('id', draft.id)
    .eq('status', 'borrador')
    .select(TAX_DRAFT_COLUMNS)
    .single();
  if (error) throw error;
  return adapt(data as DraftRow);
}

/**
 * «Presentado»: alguien lo presentó por fuera y deja el formulario como
 * evidencia. Marca también la obligación del calendario como presentada (lo
 * que mira el cierre de mes), sin bajar una que ya estaba pagada.
 */
export async function markDraftPresented(
  db: SupabaseClient,
  input: {
    draftId: string;
    userId: string;
    evidenceDocumentId?: string | null;
    evidenceUrl?: string | null;
    note?: string | null;
  },
): Promise<{ draft: TaxDraftRecord; obligationNote: string | null }> {
  await requireTaxRole(db, input.userId);
  const draft = await getTaxDraft(db, input.draftId);
  if (!draft) throw new NotFoundError('Ese borrador ya no existe.');
  if (draft.status === 'anulado') throw new ValidationError('Ese borrador está anulado.');
  const url = input.evidenceUrl?.trim() || null;
  if (url && !/^https?:\/\/\S+$/.test(url))
    throw new ValidationError('La evidencia tiene que ser un enlace que empiece por https://');
  const docId = input.evidenceDocumentId ?? null;
  if (!docId && !url && !draft.evidenceDocumentId && !draft.evidenceUrl)
    throw new ValidationError(
      'Para marcarlo presentado sube el formulario presentado (PDF) o pega el enlace del recibo.',
    );
  if (docId) {
    const { data, error } = await db
      .from('kb_documents')
      .select('id')
      .eq('id', docId)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new ValidationError('No encuentro ese documento en el Cerebro.');
  }
  const now = new Date().toISOString();
  const { data, error } = await db
    .from('tax_drafts')
    .update({
      status: 'presentado',
      presented_by: input.userId,
      presented_at: now,
      reviewed_at: draft.reviewedAt ?? now,
      reviewed_by: draft.reviewedBy ?? input.userId,
      evidence_document_id: docId ?? draft.evidenceDocumentId,
      evidence_url: url ?? draft.evidenceUrl,
      notes: input.note?.trim().slice(0, 2000) || draft.notes,
      updated_at: now,
    })
    .eq('id', draft.id)
    .select(TAX_DRAFT_COLUMNS)
    .single();
  if (error) throw error;
  const saved = adapt(data as DraftRow);

  let obligationNote: string | null = null;
  if (saved.obligationId) {
    const { data: ob, error: oerr } = await db
      .from('tax_obligations')
      .select('status')
      .eq('id', saved.obligationId)
      .maybeSingle();
    if (oerr) throw oerr;
    if ((ob as { status?: string } | null)?.status === 'pendiente') {
      const r = await markTaxObligation(db, {
        id: saved.obligationId,
        status: 'presentada',
        note: input.note ?? 'Presentada desde el borrador de Cortex',
        evidenceDocumentId: saved.evidenceDocumentId,
        evidenceUrl: saved.evidenceUrl,
        userId: input.userId,
      });
      obligationNote = r.commitmentNote ?? `«${r.obligation.title}» quedó como presentada.`;
    }
  }
  return { draft: saved, obligationNote };
}

export async function annulTaxDraft(
  db: SupabaseClient,
  input: { draftId: string; userId: string; note?: string | null },
): Promise<TaxDraftRecord> {
  await requireTaxRole(db, input.userId);
  const draft = await getTaxDraft(db, input.draftId);
  if (!draft) throw new NotFoundError('Ese borrador ya no existe.');
  if (draft.status === 'presentado')
    throw new ValidationError(
      'Un borrador presentado no se anula: la declaración ya salió. Si hay que corregirla, eso lo hace tu contador ante la DIAN.',
    );
  const { data, error } = await db
    .from('tax_drafts')
    .update({
      status: 'anulado',
      notes: input.note?.trim().slice(0, 2000) || draft.notes,
      updated_at: new Date().toISOString(),
    })
    .eq('id', draft.id)
    .select(TAX_DRAFT_COLUMNS)
    .single();
  if (error) throw error;
  return adapt(data as DraftRow);
}

// ---------------------------------------------------------------------------
// Certificados de retención
// ---------------------------------------------------------------------------

export const CERTIFICATE_COLUMNS =
  'id, supplier_id, supplier_nit, supplier_name, kind, year, period, concept, base, withheld, sources, document_path, issued_at, issued_by, sent_to, sent_at, updated_at';

export interface CertificateRecord {
  id: string;
  supplierId: string | null;
  supplierNit: string | null;
  supplierName: string;
  kind: WithholdingCertificate['kind'];
  year: number;
  period: number | null;
  base: number;
  withheld: number;
  issuedAt: string | null;
  sentTo: string | null;
  sentAt: string | null;
}

interface CertificateRow {
  id: string;
  supplier_id: string | null;
  supplier_nit: string | null;
  supplier_name: string;
  kind: WithholdingCertificate['kind'];
  year: number;
  period: number | null;
  base: number | string;
  withheld: number | string;
  issued_at: string | null;
  sent_to: string | null;
  sent_at: string | null;
}

function adaptCert(r: CertificateRow): CertificateRecord {
  return {
    id: r.id,
    supplierId: r.supplier_id,
    supplierNit: r.supplier_nit,
    supplierName: r.supplier_name,
    kind: r.kind,
    year: r.year,
    period: r.period,
    base: Number(r.base) || 0,
    withheld: Number(r.withheld) || 0,
    issuedAt: r.issued_at,
    sentTo: r.sent_to,
    sentAt: r.sent_at,
  };
}

export async function listCertificateRecords(
  db: SupabaseClient,
  opts: { year: number; kind?: WithholdingCertificate['kind'] },
): Promise<CertificateRecord[]> {
  let q = db.from('tax_withholding_certificates').select(CERTIFICATE_COLUMNS).eq('year', opts.year);
  if (opts.kind) q = q.eq('kind', opts.kind);
  const { data, error } = await q.limit(2000);
  if (error) throw error;
  return ((data ?? []) as CertificateRow[]).map(adaptCert);
}

/** Expide (guarda o actualiza) un certificado con sus cifras de hoy. */
export async function issueCertificate(
  db: SupabaseClient,
  cert: WithholdingCertificate,
  opts: { userId: string; sentTo?: string | null },
): Promise<CertificateRecord> {
  let q = db
    .from('tax_withholding_certificates')
    .select('id')
    .eq('kind', cert.kind)
    .eq('year', cert.year);
  q = cert.period === null ? q.is('period', null) : q.eq('period', cert.period);
  q = cert.supplierNit
    ? q.eq('supplier_nit', cert.supplierNit)
    : q.is('supplier_nit', null).eq('supplier_name', cert.supplierName);
  const { data: found, error: ferr } = await q.maybeSingle();
  if (ferr) throw ferr;
  const now = new Date().toISOString();
  const row = {
    supplier_id: cert.supplierId,
    supplier_nit: cert.supplierNit,
    supplier_name: cert.supplierName.slice(0, 200),
    kind: cert.kind,
    year: cert.year,
    period: cert.period,
    concept: cert.concept?.slice(0, 120) ?? null,
    base: Math.max(0, cert.base),
    withheld: Math.max(0, cert.withheld),
    sources: cert.sources,
    issued_at: now,
    issued_by: opts.userId,
    ...(opts.sentTo ? { sent_to: opts.sentTo.slice(0, 500), sent_at: now } : {}),
    updated_at: now,
  };
  const existing = found as { id: string } | null;
  const { data, error } = existing
    ? await db
        .from('tax_withholding_certificates')
        .update(row)
        .eq('id', existing.id)
        .select(CERTIFICATE_COLUMNS)
        .single()
    : await db
        .from('tax_withholding_certificates')
        .insert(row)
        .select(CERTIFICATE_COLUMNS)
        .single();
  if (error) throw error;
  return adaptCert(data as CertificateRow);
}

/** El concepto de retención de un proveedor (columna de 0197). Quien responde por impuestos o administra. */
export async function setSupplierWithholdingConcept(
  db: SupabaseClient,
  input: { supplierId: string; concept: string | null; userId: string },
): Promise<void> {
  await requireTaxRole(db, input.userId);
  const { data, error } = await db
    .from('suppliers')
    .update({ withholding_concept: input.concept, updated_at: new Date().toISOString() })
    .eq('id', input.supplierId)
    .select('id')
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError('Ese proveedor ya no existe.');
}
