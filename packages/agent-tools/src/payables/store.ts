import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isCompanyManager } from '../directory/store';
import { matchPayables } from '../ledger/payables';
import { runForecast } from '../ledger/plans';
import {
  MOVEMENT_COLUMNS,
  type MovementDraft,
  type MovementRow,
  invoiceLinkKey,
  isCounted,
} from '../ledger/shape';
import { upsertMovements } from '../ledger/store';
import type { ForecastResult, LedgerSourceKind } from '../ledger/types';
import { type HistoryInvoice, checkPayable, isBlocked } from './checks';
import { type PayableDraft, dedupeKeyOf } from './intake';
import { type PurchaseOrderLookup, purchaseOrderLookup } from './purchase-orders';
import { type PlanWeek, type ScheduleSuggestion, payPlanByWeek, suggestPayDates } from './schedule';
import {
  OPEN_STATUSES,
  PAYABLE_COLUMNS,
  type PaidEvidence,
  type PayableCheck,
  type PayableInvoiceRow,
  type PayableSource,
  type PayableStatus,
  PayableTransitionError,
  SUPPLIER_COLUMNS,
  type SupplierRow,
  adaptPayable,
  assertMove,
  cleanNit,
  effectiveDueDate,
  num,
  round2,
  supplierNameKey,
} from './shape';

/**
 * CUENTAS POR PAGAR CONTRA LA BASE (migración 0181).
 *
 * El `db` llega siempre con alcance de empresa; nada filtra por
 * `organization_id` a mano. Toda lectura revisa `error`.
 *
 *   RECIBIR (`intakePayable`): dedupe por CUFE, por proveedor + número y por
 *   referencia de la fuente; el proveedor se encuentra o se crea por NIT (o por
 *   nombre); las retenciones salen de la factura o de las tarifas del
 *   proveedor; la revisión (checks.ts) decide si queda «Por revisar» o «Por
 *   aprobar»; y la factura entra al libro de plata como `payable`.
 *
 *   DECIDIR (`approvePayables`, `rejectPayables`, `schedulePayables`): sólo
 *   quien la aprueba (el aprobador del proveedor) o un dueño/administrador.
 *   Programar sugiere el día contra la proyección de caja (schedule.ts).
 *
 *   PAGADA (`syncPaidFromLedger`, `markPaid`): cuando una salida del banco la
 *   paga (reusa `matchPayables` del libro, por el NETO de retenciones), o una
 *   persona la marca con evidencia. NUNCA se mueve plata desde aquí.
 */

export class PayableAccessError extends Error {}

const LEDGER_SYSTEM = 'cuentas por pagar';

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === '23505';
}

// ---------------------------------------------------------------------------
// Lecturas
// ---------------------------------------------------------------------------

export async function getPayable(
  db: SupabaseClient,
  id: string,
): Promise<PayableInvoiceRow | null> {
  const { data, error } = await db
    .from('payable_invoices')
    .select(PAYABLE_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return (data as PayableInvoiceRow | null) ?? null;
}

export interface ListPayablesOptions {
  statuses?: readonly PayableStatus[];
  supplierId?: string | null;
  limit?: number;
}

export async function listPayables(
  db: SupabaseClient,
  opts: ListPayablesOptions = {},
): Promise<PayableInvoiceRow[]> {
  let q = db.from('payable_invoices').select(PAYABLE_COLUMNS);
  if (opts.statuses?.length) q = q.in('status', [...opts.statuses]);
  if (opts.supplierId) q = q.eq('supplier_id', opts.supplierId);
  const { data, error } = await q
    .order('due_date', { ascending: true, nullsFirst: false })
    .order('issue_date', { ascending: true })
    .limit(Math.min(Math.max(opts.limit ?? 500, 1), 2000));
  if (error) throw error;
  return (data ?? []) as PayableInvoiceRow[];
}

export async function listSuppliers(db: SupabaseClient): Promise<SupplierRow[]> {
  const { data, error } = await db
    .from('suppliers')
    .select(SUPPLIER_COLUMNS)
    .order('name', { ascending: true })
    .limit(2000);
  if (error) throw error;
  return (data ?? []) as SupplierRow[];
}

export async function getSupplier(db: SupabaseClient, id: string): Promise<SupplierRow | null> {
  const { data, error } = await db
    .from('suppliers')
    .select(SUPPLIER_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return (data as SupplierRow | null) ?? null;
}

/** El NIT de la empresa, de «Datos de la empresa» (sección identidad). */
export async function companyNit(db: SupabaseClient): Promise<string | null> {
  const { data, error } = await db
    .from('company_facts')
    .select('label, value')
    .eq('section', 'identidad')
    .limit(50);
  if (error) return null;
  for (const f of (data ?? []) as Array<{ label: string; value: string }>) {
    if (/\bnit\b/i.test(f.label)) return cleanNit(f.value);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Proveedores
// ---------------------------------------------------------------------------

export async function findOrCreateSupplier(
  db: SupabaseClient,
  input: { nit: string | null; name: string; userId?: string | null },
): Promise<SupplierRow> {
  const nit = cleanNit(input.nit);
  const key = supplierNameKey(input.name);
  if (nit) {
    const { data, error } = await db
      .from('suppliers')
      .select(SUPPLIER_COLUMNS)
      .eq('nit', nit)
      .maybeSingle();
    if (error) throw error;
    if (data) return data as SupplierRow;
  }
  // Sin NIT (o NIT nuevo): el mismo nombre sin NIT es el mismo proveedor.
  const { data: byName, error: nameErr } = await db
    .from('suppliers')
    .select(SUPPLIER_COLUMNS)
    .eq('name_key', key)
    .limit(5);
  if (nameErr) throw nameErr;
  const named = (byName ?? []) as SupplierRow[];
  const adoptable = named.find((s) => !s.nit);
  if (adoptable) {
    if (nit) {
      const { error } = await db
        .from('suppliers')
        .update({ nit, updated_at: new Date().toISOString() })
        .eq('id', adoptable.id);
      if (error && !isUniqueViolation(error)) throw error;
      return { ...adoptable, nit };
    }
    return adoptable;
  }
  if (!nit && named[0]) return named[0];
  const now = new Date().toISOString();
  const row = {
    id: randomUUID(),
    nit,
    name: input.name.trim().slice(0, 200) || 'Proveedor',
    name_key: key,
    created_by: input.userId ?? null,
    created_at: now,
    updated_at: now,
  };
  const { error } = await db.from('suppliers').insert(row);
  if (error) {
    if (isUniqueViolation(error) && nit) return findOrCreateSupplier(db, input);
    throw error;
  }
  return {
    ...row,
    email: null,
    payment_terms_days: null,
    approver_id: null,
    retefuente_rate: null,
    reteiva_rate: null,
    reteica_rate: null,
    notes: null,
  };
}

export interface SupplierPatch {
  name?: string;
  email?: string | null;
  paymentTermsDays?: number | null;
  approverId?: string | null;
  retefuenteRate?: number | null;
  reteivaRate?: number | null;
  reteicaRate?: number | null;
  notes?: string | null;
}

export async function updateSupplier(
  db: SupabaseClient,
  id: string,
  patch: SupplierPatch,
): Promise<void> {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined) {
    row.name = patch.name.trim().slice(0, 200);
    row.name_key = supplierNameKey(patch.name);
  }
  if (patch.email !== undefined) row.email = patch.email?.trim() || null;
  if (patch.paymentTermsDays !== undefined) row.payment_terms_days = patch.paymentTermsDays;
  if (patch.approverId !== undefined) row.approver_id = patch.approverId;
  if (patch.retefuenteRate !== undefined) row.retefuente_rate = patch.retefuenteRate;
  if (patch.reteivaRate !== undefined) row.reteiva_rate = patch.reteivaRate;
  if (patch.reteicaRate !== undefined) row.reteica_rate = patch.reteicaRate;
  if (patch.notes !== undefined) row.notes = patch.notes?.trim() || null;
  const { error } = await db.from('suppliers').update(row).eq('id', id);
  if (error) throw error;
}

function hasRates(s: SupplierRow | null): boolean {
  return Boolean(
    s && (s.retefuente_rate != null || s.reteiva_rate != null || s.reteica_rate != null),
  );
}

/** Retenciones con las tarifas del proveedor: retefuente y ReteICA sobre la base, ReteIVA sobre el IVA. */
export function withholdingsFromRates(
  supplier: Pick<SupplierRow, 'retefuente_rate' | 'reteiva_rate' | 'reteica_rate'>,
  base: number,
  iva: number,
): { retefuente: number; reteiva: number; reteica: number } {
  const r = (v: number | string | null) => (num(v) ?? 0) / 100;
  return {
    retefuente: round2(base * r(supplier.retefuente_rate)),
    reteiva: round2(iva * r(supplier.reteiva_rate)),
    reteica: round2(base * r(supplier.reteica_rate)),
  };
}

// ---------------------------------------------------------------------------
// El libro de plata
// ---------------------------------------------------------------------------

function ledgerSourceOf(row: PayableInvoiceRow): {
  kind: LedgerSourceKind;
  system: string;
  ref: string;
} {
  switch (row.source) {
    case 'contable':
      return { kind: 'accounting', system: row.source_system, ref: row.source_ref };
    case 'chat':
      return { kind: 'chat', system: LEDGER_SYSTEM, ref: `payable:${row.id}` };
    case 'manual':
      return { kind: 'manual', system: LEDGER_SYSTEM, ref: `payable:${row.id}` };
    default:
      // Correo: un documento leído por Cortex (con sistema = pesa como lo dicho
      // a mano); si el PDF confirmado o el programa contable la traen, mandan.
      return { kind: 'document', system: 'correo · factura electrónica', ref: `payable:${row.id}` };
  }
}

/** La factura como movimiento del libro. Pura. */
export function payableLedgerDraft(
  row: PayableInvoiceRow,
  termsDays?: number | null,
): MovementDraft {
  const net = num(row.net_amount) ?? num(row.total) ?? 0;
  const status =
    row.status === 'pagada' ? 'settled' : row.status === 'rechazada' ? 'cancelled' : 'expected';
  return {
    direction: 'out',
    kind: 'payable',
    status,
    amount: num(row.total) ?? 0,
    currency: row.currency,
    date: row.issue_date,
    dueDate:
      row.scheduled_pay_date ??
      effectiveDueDate({ issueDate: row.issue_date, dueDate: row.due_date, termsDays }),
    settledAt: row.status === 'pagada' ? row.paid_at : null,
    outstanding: status === 'expected' ? net : 0,
    counterpartyName: row.supplier_name,
    counterpartyTaxId: row.supplier_nit,
    description: `Factura de compra ${row.doc_number} · ${row.supplier_name}`,
    docNumber: row.doc_number,
    linkKey: invoiceLinkKey({
      direction: 'out',
      docNumber: row.doc_number,
      counterpartyTaxId: row.supplier_nit,
      counterpartyName: row.supplier_name,
    }),
    source: ledgerSourceOf(row),
  };
}

/**
 * Escribir (o actualizar) la fila del libro de la factura. Las que llegaron de
 * un documento confirmado ya tienen la suya (la escribe la sincronización del
 * libro) y no se tocan: la proyección les superpone lo decidido (overlay.ts).
 */
export async function syncLedgerRow(
  db: SupabaseClient,
  row: PayableInvoiceRow,
  opts: { termsDays?: number | null; userId?: string | null } = {},
): Promise<string | null> {
  if (row.source === 'documento') return row.ledger_movement_id;
  const draft = payableLedgerDraft(row, opts.termsDays);
  const result = await upsertMovements(db, [draft], { recordedBy: opts.userId ?? null });
  const id = result.inserted[0] ?? result.updated[0] ?? null;
  if (id && id !== row.ledger_movement_id) {
    const { error } = await db
      .from('payable_invoices')
      .update({ ledger_movement_id: id })
      .eq('id', row.id);
    if (error) throw error;
    return id;
  }
  if (!id && !row.ledger_movement_id) {
    // Nada cambió y no la teníamos enlazada: buscar la fila por su referencia.
    const src = draft.source;
    const { data, error } = await db
      .from('ledger_movements')
      .select('id')
      .eq('source_kind', src.kind)
      .eq('source_system', src.system ?? '')
      .eq('source_ref', src.ref)
      .maybeSingle();
    if (error) throw error;
    const found = (data as { id: string } | null)?.id ?? null;
    if (found) {
      const { error: e } = await db
        .from('payable_invoices')
        .update({ ledger_movement_id: found })
        .eq('id', row.id);
      if (e) throw e;
    }
    return found;
  }
  return row.ledger_movement_id ?? id;
}

// ---------------------------------------------------------------------------
// Recibir
// ---------------------------------------------------------------------------

export type IntakeOutcome = 'creada' | 'duplicada';

export interface IntakeResult {
  outcome: IntakeOutcome;
  invoice: PayableInvoiceRow;
}

async function findExisting(
  db: SupabaseClient,
  draft: PayableDraft,
  dedupeKey: string,
): Promise<PayableInvoiceRow | null> {
  const probes: Array<[string, string]> = [['dedupe_key', dedupeKey]];
  if (draft.cufe) probes.unshift(['cufe', draft.cufe]);
  for (const [col, value] of probes) {
    const { data, error } = await db
      .from('payable_invoices')
      .select(PAYABLE_COLUMNS)
      .eq(col, value)
      .limit(1);
    if (error) throw error;
    const hit = ((data ?? []) as PayableInvoiceRow[])[0];
    if (hit) return hit;
  }
  const { data, error } = await db
    .from('payable_invoices')
    .select(PAYABLE_COLUMNS)
    .eq('source', draft.source)
    .eq('source_system', draft.sourceSystem)
    .eq('source_ref', draft.sourceRef)
    .limit(1);
  if (error) throw error;
  return ((data ?? []) as PayableInvoiceRow[])[0] ?? null;
}

/** Lo que una segunda copia de la misma factura agrega a la primera (sin pisar). */
function enrichment(existing: PayableInvoiceRow, draft: PayableDraft): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (!existing.cufe && draft.cufe) patch.cufe = draft.cufe;
  if (!existing.customer_nit && draft.customerNit) patch.customer_nit = draft.customerNit;
  if (!existing.supplier_dv && draft.supplierDv) patch.supplier_dv = draft.supplierDv;
  if (!existing.due_date && draft.dueDate) patch.due_date = draft.dueDate;
  if (existing.subtotal == null && draft.subtotal != null) patch.subtotal = draft.subtotal;
  if ((!existing.lines || existing.lines.length === 0) && draft.lines.length)
    patch.lines = draft.lines;
  if (!existing.order_reference && draft.orderReference)
    patch.order_reference = draft.orderReference;
  if (existing.dian_validated == null && draft.dianValidated != null)
    patch.dian_validated = draft.dianValidated;
  if (!existing.extraction_id && draft.extractionId) patch.extraction_id = draft.extractionId;
  const ev = existing.evidence ?? {};
  const merged = {
    ...draft.evidence,
    ...ev,
    files: [...new Set([...(ev.files ?? []), ...(draft.evidence.files ?? [])])],
  };
  if (JSON.stringify(merged) !== JSON.stringify(ev)) patch.evidence = merged;
  return patch;
}

async function historyFor(
  db: SupabaseClient,
  supplierId: string | null,
  exceptId: string | null,
): Promise<HistoryInvoice[]> {
  if (!supplierId) return [];
  const { data, error } = await db
    .from('payable_invoices')
    .select('id, doc_number, issue_date, total, currency, status, lines')
    .eq('supplier_id', supplierId)
    .neq('status', 'rechazada')
    .order('issue_date', { ascending: false })
    .limit(60);
  if (error) throw error;
  return (
    (data ?? []) as Array<{
      id: string;
      doc_number: string;
      issue_date: string;
      total: number | string;
      currency: string;
      status: string;
      lines: HistoryInvoice['lines'];
    }>
  )
    .filter((r) => r.id !== exceptId)
    .map((r) => ({
      id: r.id,
      docNumber: r.doc_number,
      issueDate: r.issue_date,
      total: num(r.total) ?? 0,
      currency: r.currency,
      status: r.status,
      lines: Array.isArray(r.lines) ? r.lines : [],
    }));
}

async function computeChecks(
  db: SupabaseClient,
  row: Pick<
    PayableInvoiceRow,
    | 'id'
    | 'doc_number'
    | 'supplier_nit'
    | 'supplier_dv'
    | 'supplier_name'
    | 'customer_nit'
    | 'currency'
    | 'issue_date'
    | 'due_date'
    | 'subtotal'
    | 'total'
    | 'lines'
    | 'retefuente'
    | 'reteiva'
    | 'reteica'
    | 'order_reference'
    | 'dian_validated'
  >,
  supplier: SupplierRow | null,
  ctx: { today: string; ourNit: string | null; lookup: PurchaseOrderLookup },
): Promise<{ checks: PayableCheck[]; purchaseOrderId: string | null }> {
  const total = num(row.total) ?? 0;
  const [history, po] = await Promise.all([
    historyFor(db, supplier?.id ?? null, row.id),
    ctx.lookup.available
      ? ctx.lookup
          .find({
            orderReference: row.order_reference,
            supplierNit: row.supplier_nit,
            total,
            currency: row.currency,
          })
          .catch(() => null)
      : Promise.resolve(null),
  ]);
  const checks = checkPayable(
    {
      docNumber: row.doc_number,
      supplierNit: row.supplier_nit,
      supplierDv: row.supplier_dv,
      supplierName: row.supplier_name,
      customerNit: row.customer_nit,
      currency: row.currency,
      issueDate: row.issue_date,
      dueDate: row.due_date,
      subtotal: num(row.subtotal),
      total,
      lines: Array.isArray(row.lines) ? row.lines : [],
      withholdings: {
        retefuente: num(row.retefuente) ?? 0,
        reteiva: num(row.reteiva) ?? 0,
        reteica: num(row.reteica) ?? 0,
      },
      orderReference: row.order_reference,
      dianAccepted: row.dian_validated,
    },
    {
      today: ctx.today,
      companyNit: ctx.ourNit,
      supplier: supplier
        ? { nit: supplier.nit, name: supplier.name, hasWithholdingRates: hasRates(supplier) }
        : null,
      history,
      purchaseOrder: po,
      purchaseOrdersAvailable: ctx.lookup.available,
    },
  );
  return { checks, purchaseOrderId: po?.id ?? null };
}

export interface IntakeOptions {
  today: string;
  userId?: string | null;
  /** Para no releer el NIT propio en cada factura de un mismo barrido. */
  ourNit?: string | null;
  lookup?: PurchaseOrderLookup;
}

/** Recibir una factura de proveedor. Idempotente: la misma factura otra vez es «duplicada». */
export async function intakePayable(
  db: SupabaseClient,
  draft: PayableDraft,
  opts: IntakeOptions,
): Promise<IntakeResult> {
  const dedupeKey = dedupeKeyOf(draft);
  const existing = await findExisting(db, draft, dedupeKey);
  if (existing) {
    const patch = enrichment(existing, draft);
    if (Object.keys(patch).length) {
      const { error } = await db
        .from('payable_invoices')
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq('id', existing.id);
      if (error) throw error;
    }
    return {
      outcome: 'duplicada',
      invoice: { ...existing, ...(patch as Partial<PayableInvoiceRow>) },
    };
  }

  const supplier = await findOrCreateSupplier(db, {
    nit: draft.supplierNit,
    name: draft.supplierName,
    userId: opts.userId,
  });
  const base = draft.subtotal ?? round2(draft.total - draft.iva - draft.otherTaxes);
  let withholdingSource: PayableInvoiceRow['withholding_source'] = null;
  let w = { retefuente: 0, reteiva: 0, reteica: 0 };
  if (draft.withholdings) {
    w = draft.withholdings;
    withholdingSource = 'factura';
  } else if (hasRates(supplier)) {
    w = withholdingsFromRates(supplier, base, draft.iva);
    withholdingSource = 'proveedor';
  }
  const ourNit = opts.ourNit !== undefined ? opts.ourNit : await companyNit(db);
  const lookup = opts.lookup ?? purchaseOrderLookup(db);
  const now = new Date().toISOString();
  const row: PayableInvoiceRow = {
    id: randomUUID(),
    supplier_id: supplier.id,
    source: draft.source,
    source_system: draft.sourceSystem,
    source_ref: draft.sourceRef.slice(0, 300),
    cufe: draft.cufe,
    doc_number: draft.docNumber.trim().slice(0, 120),
    dedupe_key: dedupeKey,
    supplier_nit: cleanNit(draft.supplierNit),
    supplier_dv: draft.supplierDv,
    supplier_name: draft.supplierName.trim().slice(0, 200),
    customer_nit: cleanNit(draft.customerNit),
    currency: draft.currency,
    issue_date: draft.issueDate,
    due_date: draft.dueDate,
    subtotal: draft.subtotal,
    iva: draft.iva,
    other_taxes: draft.otherTaxes,
    total: draft.total,
    retefuente: w.retefuente,
    reteiva: w.reteiva,
    reteica: w.reteica,
    withholding_source: withholdingSource,
    net_amount: round2(Math.max(0, draft.total - w.retefuente - w.reteiva - w.reteica)),
    lines: draft.lines,
    order_reference: draft.orderReference,
    purchase_order_id: null,
    status: 'recibida',
    checks: [],
    checked_at: now,
    approver_id: supplier.approver_id,
    approved_by: null,
    approved_at: null,
    rejected_by: null,
    rejected_at: null,
    rejection_reason: null,
    scheduled_pay_date: null,
    scheduled_by: null,
    schedule_note: null,
    paid_at: null,
    paid_by: null,
    paid_evidence: null,
    ledger_movement_id: draft.ledgerMovementId ?? null,
    extraction_id: draft.extractionId ?? null,
    evidence: draft.evidence,
    dian_validated: draft.dianValidated,
    created_by: opts.userId ?? null,
    created_at: now,
    updated_at: now,
  };
  const { checks, purchaseOrderId } = await computeChecks(db, row, supplier, {
    today: opts.today,
    ourNit,
    lookup,
  });
  row.checks = checks;
  row.purchase_order_id = purchaseOrderId;
  row.status = isBlocked(checks) ? 'recibida' : 'por_aprobar';

  const { net_amount: _generated, ...insert } = row;
  const { error } = await db.from('payable_invoices').insert(insert);
  if (error) {
    if (isUniqueViolation(error)) {
      const again = await findExisting(db, draft, dedupeKey);
      if (again) return { outcome: 'duplicada', invoice: again };
    }
    throw error;
  }
  // La orden de compra que cubre queda «facturada» (su «por pagar» esperado
  // sale del libro: lo reemplaza esta factura). Si algo detiene la factura,
  // la orden espera a que una persona la revise.
  if (purchaseOrderId && row.status !== 'recibida')
    await lookup.markInvoiced(purchaseOrderId, row.id, opts.today);
  row.ledger_movement_id = await syncLedgerRow(db, row, {
    termsDays: supplier.payment_terms_days,
    userId: opts.userId,
  });
  return { outcome: 'creada', invoice: row };
}

/** Volver a revisar (después de cambiar el proveedor, sus retenciones o la orden). */
export async function recheckPayable(
  db: SupabaseClient,
  id: string,
  opts: { today: string },
): Promise<PayableInvoiceRow> {
  const row = await getPayable(db, id);
  if (!row) throw new PayableTransitionError('No encontré esa factura.');
  const supplier = row.supplier_id ? await getSupplier(db, row.supplier_id) : null;
  const { checks, purchaseOrderId } = await computeChecks(db, row, supplier, {
    today: opts.today,
    ourNit: await companyNit(db),
    lookup: purchaseOrderLookup(db),
  });
  const patch: Record<string, unknown> = {
    checks,
    checked_at: new Date().toISOString(),
    purchase_order_id: purchaseOrderId ?? row.purchase_order_id,
    updated_at: new Date().toISOString(),
  };
  if (row.status === 'recibida' && !isBlocked(checks)) patch.status = 'por_aprobar';
  if (row.status === 'por_aprobar' && isBlocked(checks)) patch.status = 'recibida';
  const { error } = await db.from('payable_invoices').update(patch).eq('id', id);
  if (error) throw error;
  return { ...row, ...(patch as Partial<PayableInvoiceRow>) };
}

/** Anotar lo que se revisó en una fuente (para no releerlo y para auditar). */
export async function logIntake(
  db: SupabaseClient,
  entry: {
    channel: PayableSource;
    ref: string;
    outcome: 'creada' | 'duplicada' | 'no_factura' | 'nota' | 'error';
    invoiceId?: string | null;
    detail?: string | null;
  },
): Promise<void> {
  const { error } = await db.from('payable_intake_log').upsert(
    {
      channel: entry.channel,
      ref: entry.ref.slice(0, 300),
      outcome: entry.outcome,
      invoice_id: entry.invoiceId ?? null,
      detail: entry.detail?.slice(0, 500) ?? null,
    },
    { onConflict: 'organization_id,channel,ref' },
  );
  if (error) throw error;
}

/** Las referencias ya revisadas de un canal (de entre las dadas). */
export async function seenRefs(
  db: SupabaseClient,
  channel: PayableSource,
  refs: readonly string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  const list = [...new Set(refs)];
  for (let i = 0; i < list.length; i += 100) {
    const { data, error } = await db
      .from('payable_intake_log')
      .select('ref, outcome')
      .eq('channel', channel)
      .in('ref', list.slice(i, i + 100));
    if (error) throw error;
    // Un error se reintenta en la próxima pasada; lo demás ya quedó.
    for (const r of (data ?? []) as Array<{ ref: string; outcome: string }>)
      if (r.outcome !== 'error') out.add(r.ref);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Decidir
// ---------------------------------------------------------------------------

async function assertCanDecide(
  db: SupabaseClient,
  userId: string,
  rows: readonly PayableInvoiceRow[],
): Promise<void> {
  if (rows.every((r) => r.approver_id && r.approver_id === userId)) return;
  if (await isCompanyManager(db, userId)) return;
  const named = rows.filter((r) => r.approver_id !== userId).map((r) => r.doc_number);
  throw new PayableAccessError(
    `Sólo quien aprueba las facturas de ese proveedor, un dueño o un administrador puede decidir ${named.length === 1 ? `la ${named[0]}` : 'esas facturas'}.`,
  );
}

async function loadMany(db: SupabaseClient, ids: readonly string[]): Promise<PayableInvoiceRow[]> {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const { data, error } = await db
    .from('payable_invoices')
    .select(PAYABLE_COLUMNS)
    .in('id', unique.slice(0, 200));
  if (error) throw error;
  const rows = (data ?? []) as PayableInvoiceRow[];
  if (rows.length < unique.length)
    throw new PayableTransitionError('Alguna de esas facturas ya no existe.');
  return rows;
}

export interface DecisionResult {
  done: Array<{ id: string; docNumber: string; supplierName: string; status: PayableStatus }>;
  skipped: Array<{ id: string; docNumber: string; reason: string }>;
}

async function termsOf(
  db: SupabaseClient,
  rows: readonly PayableInvoiceRow[],
): Promise<Map<string, number | null>> {
  const ids = [...new Set(rows.map((r) => r.supplier_id).filter((x): x is string => Boolean(x)))];
  const out = new Map<string, number | null>();
  if (!ids.length) return out;
  const { data, error } = await db.from('suppliers').select('id, payment_terms_days').in('id', ids);
  if (error) throw error;
  for (const s of (data ?? []) as Array<{ id: string; payment_terms_days: number | null }>)
    out.set(s.id, s.payment_terms_days);
  return out;
}

async function moveMany(
  db: SupabaseClient,
  rows: readonly PayableInvoiceRow[],
  to: PayableStatus,
  patchFor: (row: PayableInvoiceRow) => Record<string, unknown>,
  userId: string,
): Promise<DecisionResult> {
  const result: DecisionResult = { done: [], skipped: [] };
  const terms = await termsOf(db, rows);
  for (const row of rows) {
    try {
      assertMove(row.status, to, row.doc_number);
    } catch (err) {
      result.skipped.push({
        id: row.id,
        docNumber: row.doc_number,
        reason: err instanceof Error ? err.message : 'No se puede.',
      });
      continue;
    }
    const patch = { ...patchFor(row), status: to, updated_at: new Date().toISOString() };
    const { data, error } = await db
      .from('payable_invoices')
      .update(patch)
      .eq('id', row.id)
      .eq('status', row.status)
      .select('id');
    if (error) throw error;
    if (!((data ?? []) as unknown[]).length) {
      result.skipped.push({
        id: row.id,
        docNumber: row.doc_number,
        reason: 'Cambió mientras tanto.',
      });
      continue;
    }
    const next = { ...row, ...(patch as Partial<PayableInvoiceRow>) };
    await syncLedgerRow(db, next, {
      termsDays: row.supplier_id ? terms.get(row.supplier_id) : null,
      userId,
    });
    result.done.push({
      id: row.id,
      docNumber: row.doc_number,
      supplierName: row.supplier_name,
      status: to,
    });
  }
  return result;
}

export async function approvePayables(
  db: SupabaseClient,
  ids: readonly string[],
  opts: { userId: string },
): Promise<DecisionResult> {
  const rows = await loadMany(db, ids);
  await assertCanDecide(db, opts.userId, rows);
  const now = new Date().toISOString();
  return moveMany(
    db,
    rows,
    'aprobada',
    () => ({ approved_by: opts.userId, approved_at: now }),
    opts.userId,
  );
}

export async function rejectPayables(
  db: SupabaseClient,
  ids: readonly string[],
  opts: { userId: string; reason: string },
): Promise<DecisionResult> {
  const rows = await loadMany(db, ids);
  await assertCanDecide(db, opts.userId, rows);
  const now = new Date().toISOString();
  return moveMany(
    db,
    rows,
    'rechazada',
    () => ({
      rejected_by: opts.userId,
      rejected_at: now,
      rejection_reason: opts.reason.slice(0, 500),
    }),
    opts.userId,
  );
}

/** Devolver una rechazada (o una revisada) a «Por aprobar». */
export async function reopenPayables(
  db: SupabaseClient,
  ids: readonly string[],
  opts: { userId: string },
): Promise<DecisionResult> {
  const rows = await loadMany(db, ids);
  await assertCanDecide(db, opts.userId, rows);
  return moveMany(
    db,
    rows,
    'por_aprobar',
    () => ({ rejected_by: null, rejected_at: null, rejection_reason: null }),
    opts.userId,
  );
}

// ---------------------------------------------------------------------------
// Programar contra la caja
// ---------------------------------------------------------------------------

/** La fila del libro que cuenta para cada factura (la suya o la que manda). */
async function primaryMovementIds(
  db: SupabaseClient,
  rows: readonly PayableInvoiceRow[],
): Promise<Map<string, string>> {
  const ids = [
    ...new Set(rows.map((r) => r.ledger_movement_id).filter((x): x is string => Boolean(x))),
  ];
  const byLedger = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await db
      .from('ledger_movements')
      .select('id, duplicate_of')
      .in('id', ids.slice(i, i + 100));
    if (error) throw error;
    for (const r of (data ?? []) as Array<{ id: string; duplicate_of: string | null }>)
      byLedger.set(r.id, r.duplicate_of ?? r.id);
  }
  const out = new Map<string, string>();
  for (const r of rows) {
    const p = r.ledger_movement_id ? byLedger.get(r.ledger_movement_id) : null;
    if (p) out.set(r.id, p);
  }
  return out;
}

export interface ScheduleProposal {
  forecast: ForecastResult;
  suggestions: ScheduleSuggestion[];
}

/** Las fechas que Cortex sugiere para estas facturas, contra la proyección. */
export async function proposeSchedule(
  db: SupabaseClient,
  rows: readonly PayableInvoiceRow[],
  opts: { today: string; currency?: string },
): Promise<ScheduleProposal> {
  const currency = opts.currency ?? 'COP';
  const [{ base }, primary, terms] = await Promise.all([
    runForecast(db, { today: opts.today, currency }),
    primaryMovementIds(db, rows),
    termsOf(db, rows),
  ]);
  const suggestions = suggestPayDates({
    today: opts.today,
    currency,
    weeks: base.weeks,
    minimumCash: base.minimumCash ?? 0,
    candidates: rows.map((r) => ({
      id: r.id,
      amount: num(r.net_amount) ?? num(r.total) ?? 0,
      currency: r.currency,
      dueDate: effectiveDueDate({
        issueDate: r.issue_date,
        dueDate: r.due_date,
        termsDays: r.supplier_id ? terms.get(r.supplier_id) : null,
      }),
      movementId: primary.get(r.id) ?? null,
      label: `${r.supplier_name} ${r.doc_number}`,
    })),
  });
  return { forecast: base, suggestions };
}

export interface ScheduleResult extends DecisionResult {
  suggestions: ScheduleSuggestion[];
}

/**
 * Programar el pago. Sin `date`, el día que sugiere la caja (schedule.ts); con
 * `date`, ese día (y la sugerencia va al lado para que se vea si choca).
 */
export async function schedulePayables(
  db: SupabaseClient,
  ids: readonly string[],
  opts: { userId: string; today: string; date?: string | null; note?: string | null },
): Promise<ScheduleResult> {
  const rows = await loadMany(db, ids);
  await assertCanDecide(db, opts.userId, rows);
  const { suggestions } = await proposeSchedule(db, rows, { today: opts.today });
  const byId = new Map(suggestions.map((s) => [s.id, s]));
  if (opts.date && opts.date < opts.today)
    throw new PayableTransitionError('No se puede programar un pago en el pasado.');
  const result = await moveMany(
    db,
    rows,
    'programada',
    (row) => {
      const s = byId.get(row.id);
      return {
        scheduled_pay_date: opts.date ?? s?.date ?? opts.today,
        scheduled_by: opts.userId,
        schedule_note: (opts.note ?? (opts.date ? null : s?.reason) ?? null)?.slice(0, 500) ?? null,
      };
    },
    opts.userId,
  );
  return { ...result, suggestions };
}

// ---------------------------------------------------------------------------
// Pagada
// ---------------------------------------------------------------------------

export async function markPaid(
  db: SupabaseClient,
  id: string,
  opts: { userId: string; date: string; evidence: Omit<PaidEvidence, 'kind'> },
): Promise<DecisionResult> {
  const rows = await loadMany(db, [id]);
  await assertCanDecide(db, opts.userId, rows);
  if (!opts.evidence.reference?.trim() && !opts.evidence.documentId && !opts.evidence.note?.trim())
    throw new PayableTransitionError(
      'Para marcarla pagada hace falta la evidencia: el número del comprobante, una nota o el soporte.',
    );
  const row = rows[0] as PayableInvoiceRow;
  const now = new Date().toISOString();
  // Una pagada sin aprobación previa: el pago ya pasó, se registra igual y
  // queda dicho quién la marcó.
  const from = row.status;
  if (from === 'pagada')
    return { done: [], skipped: [{ id, docNumber: row.doc_number, reason: 'Ya estaba pagada.' }] };
  if (from === 'rechazada')
    throw new PayableTransitionError(
      `La factura ${row.doc_number} está rechazada; reábrela antes.`,
    );
  const patch = {
    status: 'pagada' as const,
    paid_at: opts.date,
    paid_by: opts.userId,
    paid_evidence: { kind: 'manual', ...opts.evidence },
    approved_at: row.approved_at ?? now,
    approved_by: row.approved_by ?? opts.userId,
    updated_at: now,
  };
  const { error } = await db.from('payable_invoices').update(patch).eq('id', id).eq('status', from);
  if (error) throw error;
  await syncLedgerRow(
    db,
    { ...row, ...(patch as Partial<PayableInvoiceRow>) },
    { userId: opts.userId },
  );
  return {
    done: [{ id, docNumber: row.doc_number, supplierName: row.supplier_name, status: 'pagada' }],
    skipped: [],
  };
}

export interface PaidSyncResult {
  paid: number;
  reopened: number;
}

/**
 * Lo que el banco ya pagó. Tres pasos, idempotentes:
 *   1. La fila del libro que cuenta ya está saldada (payables.ts la ató a una
 *      salida, o el programa contable la trae pagada) → pagada.
 *   2. Si no, se busca la salida del banco por el NETO de retenciones (lo que
 *      de verdad salió) con el mismo emparejador del libro → pagada.
 *   3. Una pagada por el banco cuya salida ya no cuenta → vuelve a abrirse.
 */
export async function syncPaidFromLedger(db: SupabaseClient): Promise<PaidSyncResult> {
  const result: PaidSyncResult = { paid: 0, reopened: 0 };
  const open = await listPayables(db, { statuses: OPEN_STATUSES, limit: 2000 });
  const linked = open.filter((r) => r.ledger_movement_id);
  const primary = await primaryMovementIds(db, linked);
  const primaryIds = [...new Set(primary.values())];
  const rowsById = new Map<string, MovementRow>();
  for (let i = 0; i < primaryIds.length; i += 100) {
    const { data, error } = await db
      .from('ledger_movements')
      .select(MOVEMENT_COLUMNS)
      .in('id', primaryIds.slice(i, i + 100));
    if (error) throw error;
    for (const r of (data ?? []) as MovementRow[]) rowsById.set(r.id, r);
  }

  const markBank = async (
    row: PayableInvoiceRow,
    date: string,
    movementId: string | null,
    kind: PaidEvidence['kind'],
  ) => {
    const now = new Date().toISOString();
    const patch = {
      status: 'pagada',
      paid_at: date,
      paid_evidence: { kind, movementId },
      approved_at: row.approved_at ?? now,
      updated_at: now,
    };
    const { data, error } = await db
      .from('payable_invoices')
      .update(patch)
      .eq('id', row.id)
      .eq('status', row.status)
      .select('id');
    if (error) throw error;
    if (((data ?? []) as unknown[]).length) result.paid += 1;
  };

  const pending: Array<{ row: PayableInvoiceRow; movement: MovementRow }> = [];
  for (const row of linked) {
    const p = primary.get(row.id);
    const m = p ? rowsById.get(p) : null;
    if (!m) continue;
    if (m.status === 'settled' && isCounted({ ...m, status: 'settled' })) {
      await markBank(
        row,
        m.settled_at ?? m.date,
        m.settled_by ?? null,
        m.settled_by ? 'bank' : 'accounting',
      );
      continue;
    }
    if (m.status === 'expected' && isCounted(m)) pending.push({ row, movement: m });
  }

  // 2. Emparejar por el neto contra las salidas del banco.
  if (pending.length) {
    const since = pending.reduce(
      (min, p) => (p.row.issue_date < min ? p.row.issue_date : min),
      pending[0]?.row.issue_date ?? '',
    );
    const [debits, used, claimed] = await Promise.all([
      db
        .from('ledger_movements')
        .select(MOVEMENT_COLUMNS)
        .eq('kind', 'expense')
        .eq('direction', 'out')
        .eq('status', 'settled')
        .eq('source_kind', 'bank')
        .is('duplicate_of', null)
        .gte('date', since)
        .order('date', { ascending: true })
        .limit(3000),
      db.from('ledger_movements').select('settled_by').not('settled_by', 'is', null).limit(3000),
      db
        .from('payable_invoices')
        .select('paid_evidence')
        .eq('status', 'pagada')
        .not('paid_evidence', 'is', null)
        .limit(3000),
    ]);
    if (debits.error) throw debits.error;
    if (used.error) throw used.error;
    if (claimed.error) throw claimed.error;
    const usedIds = new Set<string>();
    for (const r of (used.data ?? []) as Array<{ settled_by: string | null }>)
      if (r.settled_by) usedIds.add(r.settled_by);
    for (const r of (claimed.data ?? []) as Array<{ paid_evidence: PaidEvidence | null }>)
      if (r.paid_evidence?.movementId) usedIds.add(r.paid_evidence.movementId);
    const synthetic = pending.map(({ row, movement }) => ({
      ...movement,
      id: row.id,
      outstanding: num(row.net_amount) ?? num(movement.outstanding),
      due_date: row.scheduled_pay_date ?? movement.due_date,
    }));
    const matches = matchPayables(synthetic, (debits.data ?? []) as MovementRow[], usedIds);
    const byId = new Map(pending.map((p) => [p.row.id, p.row]));
    for (const m of matches) {
      const row = byId.get(m.payableId);
      if (!row) continue;
      await markBank(row, m.date, m.debitId, 'bank');
      // La fila propia del libro también queda saldada (la de un documento la
      // deja su fuente; la proyección ya no la cuenta, overlay.ts).
      await syncLedgerRow(db, { ...row, status: 'pagada', paid_at: m.date });
    }
  }

  // 3. Reabrir lo que pagó una salida que ya no cuenta.
  const { data: paid, error: paidErr } = await db
    .from('payable_invoices')
    .select('id, paid_evidence, scheduled_pay_date')
    .eq('status', 'pagada')
    .limit(3000);
  if (paidErr) throw paidErr;
  const bankPaid = (
    (paid ?? []) as Array<{
      id: string;
      paid_evidence: PaidEvidence | null;
      scheduled_pay_date: string | null;
    }>
  ).filter((r) => r.paid_evidence?.kind === 'bank' && r.paid_evidence.movementId);
  const debitIds = [...new Set(bankPaid.map((r) => r.paid_evidence?.movementId as string))];
  const alive = new Set<string>();
  for (let i = 0; i < debitIds.length; i += 100) {
    const { data, error } = await db
      .from('ledger_movements')
      .select('id, status, duplicate_of, excluded_reason')
      .in('id', debitIds.slice(i, i + 100));
    if (error) throw error;
    for (const d of (data ?? []) as Array<
      Pick<MovementRow, 'id' | 'status' | 'duplicate_of' | 'excluded_reason'>
    >)
      if (isCounted(d)) alive.add(d.id);
  }
  for (const r of bankPaid) {
    if (alive.has(r.paid_evidence?.movementId as string)) continue;
    const { error } = await db
      .from('payable_invoices')
      .update({
        status: r.scheduled_pay_date ? 'programada' : 'aprobada',
        paid_at: null,
        paid_evidence: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', r.id)
      .eq('status', 'pagada');
    if (error) throw error;
    result.reopened += 1;
  }
  return result;
}

// ---------------------------------------------------------------------------
// El programa de pagos
// ---------------------------------------------------------------------------

export interface PayPlan {
  today: string;
  currency: string;
  minimumCash: number;
  weeks: PlanWeek[];
  /** Aprobadas que todavía no tienen día. */
  unscheduled: Array<{
    id: string;
    supplierName: string;
    docNumber: string;
    amount: number;
    currency: string;
    dueDate: string | null;
  }>;
  /** Esperando aprobación, con el total y el primer vencimiento. */
  awaiting: { count: number; amount: number; firstDue: string | null };
}

export async function loadPayPlan(
  db: SupabaseClient,
  opts: { today: string; currency?: string },
): Promise<PayPlan> {
  const currency = opts.currency ?? 'COP';
  const [rows, run] = await Promise.all([
    listPayables(db, { statuses: OPEN_STATUSES, limit: 2000 }),
    runForecast(db, { today: opts.today, currency }),
  ]);
  const scheduled = rows.filter((r) => r.status === 'programada' && r.scheduled_pay_date);
  const minimum = run.base.minimumCash ?? 0;
  const weeks = payPlanByWeek({
    currency,
    weeks: run.base.weeks,
    minimumCash: minimum,
    invoices: scheduled.map((r) => ({
      id: r.id,
      supplierName: r.supplier_name,
      docNumber: r.doc_number,
      amount: num(r.net_amount) ?? num(r.total) ?? 0,
      currency: r.currency,
      date:
        (r.scheduled_pay_date as string) < opts.today
          ? opts.today
          : (r.scheduled_pay_date as string),
      status: r.status,
    })),
  });
  const awaiting = rows.filter((r) => r.status === 'recibida' || r.status === 'por_aprobar');
  const dues = awaiting
    .map((r) => r.due_date)
    .filter((d): d is string => Boolean(d))
    .sort();
  return {
    today: opts.today,
    currency,
    minimumCash: minimum,
    weeks,
    unscheduled: rows
      .filter((r) => r.status === 'aprobada')
      .map((r) => ({
        id: r.id,
        supplierName: r.supplier_name,
        docNumber: r.doc_number,
        amount: num(r.net_amount) ?? num(r.total) ?? 0,
        currency: r.currency,
        dueDate: r.due_date,
      })),
    awaiting: {
      count: awaiting.length,
      amount: round2(
        awaiting
          .filter((r) => r.currency === currency)
          .reduce((s, r) => s + (num(r.net_amount) ?? 0), 0),
      ),
      firstDue: dues[0] ?? null,
    },
  };
}

export { adaptPayable };
