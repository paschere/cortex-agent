import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { type EmissionDeps, emitInvoice } from '../../sales/emit';
import { createSalesDocument } from '../../sales/store';
import { documentTotals, formatMoney } from '../../sales/totals';
import { getTrackerById, upsertRow } from '../../trackers/store';
import { OUTBOX_KIND_LABEL, type OutboxKind } from '../../accounting/outbound/shape';
import { outboxPayloadProblems } from './outbox-build';
import { type DraftLine, type InvoiceDraftData, writeBackValues } from './invoice-draft';
import { INVOICE_TAX_RATES, type InvoiceWriteBack } from './invoice-draft-spec';

/**
 * LA BANDEJA «PREFACTURAS POR REVISAR» (migración 0230).
 *
 * Una prefactura nace `pending` cuando la regla la arma, y SÓLO sale de ahí
 * porque una persona la aprueba (o la descarta). Aprobar:
 *
 *   1. toma la prefactura (`pending|error → creating`, compare-and-swap): dos
 *      clics o dos personas no crean dos facturas;
 *   2. crea (una sola vez) el PEDIDO en Ventas con sus líneas en pesos y lo
 *      guarda en `sales_document_id`: un reintento tras un error reutiliza el
 *      mismo pedido en vez de duplicarlo;
 *   3. emite con `emitInvoice` (el camino de `sales.invoice_emit`: catálogo de
 *      Siigo, cliente por NIT, problemas en español, llave de idempotencia,
 *      pedido → «facturada»). La persona elige si además se envía a la DIAN o si
 *      queda creada en Siigo sin enviar;
 *   4. guarda en la prefactura el id y el número de Siigo y escribe el número
 *      (y el estado) de vuelta en la fila de origen.
 *
 * Nunca se llama desde una corrida ni desde una rutina: lo llaman la bandeja
 * (un clic de una persona) y la herramienta con confirmación.
 */

export const INVOICE_DRAFT_COLUMNS =
  'id, organization_id, app_id, automation_id, run_id, tracker_id, row_id, row_label, idempotency_key, status, customer_tax_id, customer_name, currency, trm, lines, observations, payment_form, payment_days, choices, write_back, total, sales_document_id, provider, provider_invoice_id, provider_number, sent_to_dian, error, decided_by, decided_at, created_at, updated_at, kind, payload';

export type InvoiceDraftStatus = 'pending' | 'creating' | 'created' | 'discarded' | 'error';

export const INVOICE_DRAFT_STATUS_LABEL: Record<InvoiceDraftStatus, string> = {
  pending: 'Por revisar',
  creating: 'Creándose en Siigo',
  created: 'Creada en Siigo',
  discarded: 'Descartada',
  error: 'Con error',
};

export interface InvoiceDraftChoices {
  documentTypeId?: string;
  sellerId?: string;
  paymentTypeId?: string;
}

export interface InvoiceDraftRow {
  id: string;
  /** Qué se enviará a Siigo al aprobar (0232). `invoice` = prefactura. */
  kind: OutboxKind;
  /** Lo que se manda cuando no es factura (recibo, nota, cliente). */
  payload: Record<string, unknown>;
  app_id: string | null;
  automation_id: string | null;
  run_id: string | null;
  tracker_id: string | null;
  row_id: string | null;
  row_label: string;
  status: InvoiceDraftStatus;
  customer_tax_id: string | null;
  customer_name: string;
  currency: string;
  trm: number | null;
  lines: DraftLine[];
  observations: string;
  payment_form: 'contado' | 'credito';
  payment_days: number;
  choices: InvoiceDraftChoices;
  write_back: InvoiceWriteBack;
  total: number;
  sales_document_id: string | null;
  provider: string | null;
  provider_invoice_id: string | null;
  provider_number: string | null;
  sent_to_dian: boolean | null;
  error: string | null;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
}

function adapt(r: Record<string, unknown>): InvoiceDraftRow {
  return {
    ...(r as unknown as InvoiceDraftRow),
    trm: r.trm === null || r.trm === undefined ? null : Number(r.trm),
    total: Number(r.total ?? 0),
    lines: ((r.lines as DraftLine[]) ?? []).map((l) => ({
      ...l,
      quantity: Number(l.quantity),
      unitPrice: Number(l.unitPrice),
      discountPct: Number(l.discountPct ?? 0),
    })),
    choices: (r.choices as InvoiceDraftChoices) ?? {},
    write_back: (r.write_back as InvoiceWriteBack) ?? {},
    kind: ((r.kind as OutboxKind | undefined) ?? 'invoice'),
    payload: (r.payload as Record<string, unknown> | undefined) ?? {},
  };
}

/** `adapt` para los otros módulos de la bandeja (outbox-run, outbox-approve). */
export const adaptDraftRow = adapt;

/** Los problemas de CUALQUIER borrador antes de aprobar, según lo que sea. Puro. */
export function outboxDraftProblems(
  d: Pick<InvoiceDraftRow, 'kind' | 'payload' | 'customer_tax_id' | 'lines' | 'currency'>,
): string[] {
  return d.kind === 'invoice' ? draftProblems(d) : outboxPayloadProblems(d.kind, d.payload);
}

/** «Recibo de caja», «Nota crédito»… para títulos y avisos. */
export function draftKindLabel(kind: OutboxKind): string {
  return OUTBOX_KIND_LABEL[kind];
}

/** Problemas que se ven ANTES de aprobar (el resto lo dice Siigo al crear). Puro. */
export function draftProblems(d: Pick<InvoiceDraftRow, 'customer_tax_id' | 'lines' | 'currency'>): string[] {
  const out: string[] = [];
  if (!d.customer_tax_id) out.push('Falta el NIT del cliente.');
  d.lines.forEach((l, i) => {
    if (!l.productCode) out.push(`La línea ${i + 1} («${l.description.slice(0, 50)}») no tiene código de producto de Siigo.`);
    if (!(l.quantity > 0)) out.push(`La línea ${i + 1} no tiene cantidad.`);
    if (!(l.unitPrice >= 0)) out.push(`La línea ${i + 1} no tiene precio.`);
  });
  return out;
}

export function draftTotal(lines: DraftLine[]): number {
  return documentTotals(
    lines.map((l) => ({
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discountPct: l.discountPct,
      taxRate: l.taxRate,
    })),
  ).total;
}

// ---------------------------------------------------------------------------
// Crear (la regla) · listar · editar · descartar
// ---------------------------------------------------------------------------

export interface CreateDraftInput {
  organizationId: string;
  appId: string;
  automationId: string;
  runId: string | null;
  trackerId: string | null;
  rowId: string | null;
  rowLabel: string;
  idempotencyKey: string;
  draft: InvoiceDraftData;
  choices: InvoiceDraftChoices;
  writeBack?: InvoiceWriteBack;
}

/** Inserta la prefactura; si ya existe una para esa llave devuelve la existente (`created: false`). */
export async function createInvoiceDraft(
  db: SupabaseClient,
  input: CreateDraftInput,
): Promise<{ draft: InvoiceDraftRow; created: boolean }> {
  const { data, error } = await db
    .from('app_invoice_drafts')
    .upsert(
      {
        organization_id: input.organizationId,
        app_id: input.appId,
        automation_id: input.automationId,
        run_id: input.runId,
        tracker_id: input.trackerId,
        row_id: input.rowId,
        row_label: input.rowLabel.slice(0, 200),
        idempotency_key: input.idempotencyKey,
        customer_tax_id: input.draft.customerTaxId,
        customer_name: input.draft.customerName,
        currency: input.draft.currency,
        trm: input.draft.trm,
        lines: input.draft.lines,
        observations: input.draft.observations,
        payment_form: input.draft.paymentForm,
        payment_days: input.draft.paymentDays,
        choices: input.choices,
        write_back: input.writeBack ?? {},
        total: input.draft.total,
      },
      { onConflict: 'idempotency_key', ignoreDuplicates: true },
    )
    .select(INVOICE_DRAFT_COLUMNS);
  if (error) throw error;
  const inserted = (data ?? [])[0] as Record<string, unknown> | undefined;
  if (inserted) return { draft: adapt(inserted), created: true };
  const { data: existing, error: readError } = await db
    .from('app_invoice_drafts')
    .select(INVOICE_DRAFT_COLUMNS)
    .eq('idempotency_key', input.idempotencyKey)
    .single();
  if (readError) throw readError;
  return { draft: adapt(existing as Record<string, unknown>), created: false };
}

export async function getInvoiceDraft(db: SupabaseClient, id: string): Promise<InvoiceDraftRow | null> {
  const { data, error } = await db.from('app_invoice_drafts').select(INVOICE_DRAFT_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? adapt(data as Record<string, unknown>) : null;
}

export async function listInvoiceDrafts(
  db: SupabaseClient,
  opts: { statuses?: InvoiceDraftStatus[]; kinds?: OutboxKind[]; limit?: number } = {},
): Promise<InvoiceDraftRow[]> {
  let q = db
    .from('app_invoice_drafts')
    .select(INVOICE_DRAFT_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(opts.limit ?? 100);
  if (opts.statuses?.length) q = q.in('status', opts.statuses);
  if (opts.kinds?.length) q = q.in('kind', opts.kinds);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []).map((r) => adapt(r as Record<string, unknown>));
}

/** Prefacturas (de cualquier estado) de una fila: «¿esta atención ya tiene prefactura?». */
export async function draftsForRow(db: SupabaseClient, rowId: string): Promise<InvoiceDraftRow[]> {
  const { data, error } = await db
    .from('app_invoice_drafts')
    .select(INVOICE_DRAFT_COLUMNS)
    .eq('row_id', rowId)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw error;
  return (data ?? []).map((r) => adapt(r as Record<string, unknown>));
}

export const invoiceDraftEditSchema = z.object({
  customerTaxId: z.string().trim().min(3).max(20).optional(),
  customerName: z.string().trim().max(200).optional(),
  observations: z.string().trim().max(4000).optional(),
  paymentForm: z.enum(['contado', 'credito']).optional(),
  paymentDays: z.number().int().min(0).max(365).optional(),
  choices: z
    .object({
      documentTypeId: z.string().trim().max(40).optional(),
      sellerId: z.string().trim().max(40).optional(),
      paymentTypeId: z.string().trim().max(40).optional(),
    })
    .optional(),
  lines: z
    .array(
      z.object({
        description: z.string().trim().min(1).max(500),
        productCode: z.string().trim().max(60).nullable().optional(),
        quantity: z.number().finite().positive().max(1e9),
        unitPrice: z.number().finite().min(0).max(1e13),
        taxRate: z.enum(INVOICE_TAX_RATES),
        unit: z.string().trim().max(40).nullable().optional(),
        discountPct: z.number().min(0).max(100).optional(),
      }),
    )
    .min(1)
    .max(50)
    .optional(),
});
export type InvoiceDraftEdit = z.infer<typeof invoiceDraftEditSchema>;

export async function updateInvoiceDraft(
  db: SupabaseClient,
  id: string,
  raw: unknown,
): Promise<InvoiceDraftRow> {
  const edit = invoiceDraftEditSchema.parse(raw);
  const current = await getInvoiceDraft(db, id);
  if (!current) throw new NotFoundError('Esa prefactura ya no existe.');
  if (current.status !== 'pending' && current.status !== 'error')
    throw new ValidationError(`Esa prefactura está «${INVOICE_DRAFT_STATUS_LABEL[current.status].toLowerCase()}»: ya no se edita.`);
  const lines: DraftLine[] | undefined = edit.lines?.map((l, i) => ({
    description: l.description,
    productCode: l.productCode?.trim() || null,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    taxRate: l.taxRate,
    unit: l.unit?.trim() || null,
    discountPct: l.discountPct ?? 0,
    ...(current.lines[i]?.sourceUnitPrice !== undefined && current.lines[i]?.unitPrice === l.unitPrice
      ? { sourceUnitPrice: current.lines[i]?.sourceUnitPrice }
      : {}),
  }));
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (lines) {
    patch.lines = lines;
    patch.total = draftTotal(lines);
  }
  if (edit.customerTaxId !== undefined) patch.customer_tax_id = edit.customerTaxId.replace(/\D/g, '') || null;
  if (edit.customerName !== undefined) patch.customer_name = edit.customerName;
  if (edit.observations !== undefined) patch.observations = edit.observations;
  if (edit.paymentForm !== undefined) patch.payment_form = edit.paymentForm;
  if (edit.paymentDays !== undefined) patch.payment_days = edit.paymentDays;
  if (edit.choices) patch.choices = { ...current.choices, ...edit.choices };
  const { data, error } = await db
    .from('app_invoice_drafts')
    .update(patch)
    .eq('id', id)
    .in('status', ['pending', 'error'])
    .select(INVOICE_DRAFT_COLUMNS);
  if (error) throw error;
  const row = (data ?? [])[0];
  if (!row) throw new ValidationError('La prefactura cambió mientras la editabas; ábrela de nuevo.');
  return adapt(row as Record<string, unknown>);
}

export async function discardInvoiceDraft(
  db: SupabaseClient,
  id: string,
  userId: string,
): Promise<InvoiceDraftRow> {
  const { data, error } = await db
    .from('app_invoice_drafts')
    .update({ status: 'discarded', decided_by: userId, decided_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id)
    .in('status', ['pending', 'error'])
    .select(INVOICE_DRAFT_COLUMNS);
  if (error) throw error;
  const row = (data ?? [])[0];
  if (row) return adapt(row as Record<string, unknown>);
  const current = await getInvoiceDraft(db, id);
  if (!current) throw new NotFoundError('Esa prefactura ya no existe.');
  if (current.status === 'discarded') return current;
  throw new ValidationError(
    current.status === 'created'
      ? `Esa prefactura ya está creada en Siigo (${current.provider_number ?? current.provider_invoice_id}): no se descarta.`
      : 'Esa prefactura se está creando en Siigo en este momento.',
  );
}

// ---------------------------------------------------------------------------
// Aprobar
// ---------------------------------------------------------------------------

const STUCK_MS = 10 * 60_000;

export interface ApproveOutcome {
  draft: InvoiceDraftRow;
  already: boolean;
  /** Algo que no impidió crear la factura (p. ej. no se pudo escribir en la fila). */
  warnings: string[];
  markdown: string;
}

export async function approveInvoiceDraft(
  ctx: {
    db: SupabaseClient;
    organizationId: string;
    userId: string;
    enqueueJob?: (name: string, data: Record<string, unknown>) => Promise<boolean>;
  },
  id: string,
  opts: { sendToDian?: boolean } & EmissionDeps = {},
): Promise<ApproveOutcome> {
  const { db } = ctx;
  const draft = await getInvoiceDraft(db, id);
  if (!draft) throw new NotFoundError('Esa prefactura ya no existe.');
  if (draft.status === 'created')
    return {
      draft,
      already: true,
      warnings: [],
      markdown: `Esa prefactura ya está creada en Siigo: **${draft.provider_number ?? draft.provider_invoice_id}**.`,
    };
  if (draft.status === 'discarded') throw new ValidationError('Esa prefactura fue descartada.');
  const stuck = draft.status === 'creating' && Date.now() - Date.parse(draft.updated_at) > STUCK_MS;
  if (draft.status === 'creating' && !stuck)
    throw new ValidationError('Esa prefactura se está creando en Siigo en este momento. Espera un minuto y revisa.');
  const problems = draftProblems(draft);
  if (problems.length) throw new ValidationError(`Antes de aprobar, edita la prefactura: ${problems.join(' ')}`);

  const sendToDian = opts.sendToDian === true;
  const now = new Date().toISOString();
  const { data: claimed, error: claimError } = await db
    .from('app_invoice_drafts')
    .update({ status: 'creating', decided_by: ctx.userId, decided_at: now, updated_at: now, error: null })
    .eq('id', id)
    .in('status', stuck ? ['creating'] : ['pending', 'error'])
    .select(INVOICE_DRAFT_COLUMNS);
  if (claimError) throw claimError;
  if (!(claimed ?? []).length) throw new ValidationError('Esa prefactura cambió mientras la aprobabas; ábrela de nuevo.');

  const fail = async (message: string): Promise<never> => {
    await db
      .from('app_invoice_drafts')
      .update({ status: 'error', error: message.slice(0, 2000), updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('status', 'creating');
    throw new ValidationError(message);
  };

  try {
    let salesDocumentId = draft.sales_document_id;
    if (!salesDocumentId) {
      const order = await createSalesDocument(
        db,
        'order',
        {
          clientName: draft.customer_name || `NIT ${draft.customer_tax_id}`,
          clientTaxId: draft.customer_tax_id,
          currency: 'COP',
          paymentForm: draft.payment_form,
          paymentDays: draft.payment_days,
          notes: draft.observations || null,
          lines: draft.lines.map((l) => ({
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            discountPct: l.discountPct || undefined,
            taxRate: l.taxRate,
            productCode: l.productCode,
            unit: l.unit,
          })),
        },
        { userId: ctx.userId },
      );
      salesDocumentId = order.id;
      await db
        .from('app_invoice_drafts')
        .update({ sales_document_id: salesDocumentId })
        .eq('id', id);
    }
    const outcome = await emitInvoice(
      { db, organizationId: ctx.organizationId, userId: ctx.userId, enqueueJob: ctx.enqueueJob },
      salesDocumentId,
      {
        choices: { ...draft.choices, stamp: sendToDian },
        provider: 'siigo',
        today: opts.today,
        openSession: opts.openSession,
      },
    );
    const invoice = outcome.invoice;
    const { data: done, error: doneError } = await db
      .from('app_invoice_drafts')
      .update({
        status: 'created',
        provider: invoice.provider,
        provider_invoice_id: invoice.provider_invoice_id,
        provider_number: invoice.provider_number,
        sent_to_dian: sendToDian,
        error: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select(INVOICE_DRAFT_COLUMNS)
      .single();
    if (doneError) throw doneError;
    const final = adapt(done as Record<string, unknown>);
    const warnings = await writeBackToRow(db, final, ctx.userId);
    return {
      draft: final,
      already: outcome.status === 'already_emitted',
      warnings,
      markdown: `Prefactura aprobada: la factura **${invoice.provider_number ?? invoice.provider_invoice_id}** por ${formatMoney(invoice.total, invoice.currency)} quedó creada en Siigo${sendToDian ? ' y enviada a la DIAN' : ' SIN enviar a la DIAN (se envía desde Siigo)'}.${warnings.length ? ` Ojo: ${warnings.join(' ')}` : ''}`,
    };
  } catch (err) {
    if (err instanceof ValidationError) return fail(err.message);
    return fail(`No se pudo crear la factura: ${err instanceof Error ? err.message : 'error desconocido'}`);
  }
}

/** Escribe el número de factura (y el estado) en la fila de origen. Nunca tumba la aprobación. */
export async function writeBackToRow(db: SupabaseClient, d: InvoiceDraftRow, userId: string): Promise<string[]> {
  const values = writeBackValues(d.write_back, 'created', d.provider_number ?? d.provider_invoice_id);
  if (!Object.keys(values).length) return [];
  if (!d.tracker_id || !d.row_id) return ['La prefactura no viene de una fila: no hay dónde escribir el número.'];
  try {
    const tracker = await getTrackerById(db, d.tracker_id);
    if (!tracker) return ['La tabla de origen ya no existe: el número no se escribió en la fila.'];
    const { data: row } = await db.from('tracker_rows').select('id, values').eq('id', d.row_id).eq('tracker_id', tracker.id).maybeSingle();
    if (!row) return ['La fila de origen ya no existe: el número no se escribió en ella.'];
    await upsertRow(db, {
      tracker,
      rowId: d.row_id,
      values: { ...((row as { values: Record<string, unknown> }).values ?? {}), ...values },
      userId,
      lenient: true,
      only: new Set(Object.keys(values)),
    });
    return [];
  } catch (err) {
    return [`No se pudo escribir en la fila: ${err instanceof Error ? err.message : 'error'}.`];
  }
}
