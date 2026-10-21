import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ensureSyncedCities } from '../../accounting/outbound/cities';
import { z } from 'zod';
import {
  type CreditNotePayload,
  CREDIT_NOTE_REASONS,
  type CustomerPayload,
  OUTBOX_KIND_LABEL,
  type OutboxKind,
  type ReceiptPayload,
  buildCustomerPayload,
  outboxIdempotencyKey,
  round2,
} from '../../accounting/outbound/shape';
import { openAccountingSession, requestAccountingSync } from '../../accounting/store';
import {
  type CreatedProviderDocument,
  type ProviderSession,
  ProviderUncertainError,
  ProviderValidationError,
} from '../../accounting/types';
import type { EmissionDeps } from '../../sales/emit';
import { listAccountingConnections } from '../../accounting/store';
import {
  INVOICE_DRAFT_COLUMNS,
  type InvoiceDraftRow,
  adaptDraftRow,
  approveInvoiceDraft,
  getInvoiceDraft,
  outboxDraftProblems,
  type ApproveOutcome,
  writeBackToRow,
} from './invoice-drafts';
import { describeOutbox } from './outbox-build';

/**
 * APROBAR LO QUE NO ES FACTURA EN «POR ENVIAR A SIIGO» (0232): cliente, recibo
 * de caja y nota crédito. Mismo ciclo que la prefactura: toma única
 * (`pending|error → creating`, compare-and-swap), escritura con llave de
 * idempotencia, resultado en el borrador y número de vuelta a la fila de origen.
 *
 * Una red cortada o un 5xx NO se reintenta solo: el borrador queda `error` con
 * «revisa en Siigo»; volver a aprobar usa la MISMA llave (Siigo no duplica el
 * recibo ni la nota) y, para el cliente, busca por NIT antes de crear.
 *
 * Nunca desde una rutina ni una automatización: lo llaman la bandeja (un clic
 * de una persona) y la herramienta con confirmación.
 */

const STUCK_MS = 10 * 60_000;

export interface OutboxApproveCtx {
  db: SupabaseClient;
  organizationId: string;
  userId: string;
  enqueueJob?: (name: string, data: Record<string, unknown>) => Promise<boolean>;
}

export type OutboxApproveOpts = { sendToDian?: boolean } & EmissionDeps;

/** El único punto de aprobación: factura por Ventas, lo demás aquí. */
export async function approveOutboxItem(
  ctx: OutboxApproveCtx,
  id: string,
  opts: OutboxApproveOpts = {},
): Promise<ApproveOutcome> {
  const draft = await getInvoiceDraft(ctx.db, id);
  if (!draft) throw new NotFoundError('Ese borrador ya no existe.');
  if (draft.kind === 'invoice') return approveInvoiceDraft(ctx, id, opts);
  return approveOtherDraft(ctx, draft, opts);
}

async function approveOtherDraft(
  ctx: OutboxApproveCtx,
  draft: InvoiceDraftRow,
  opts: OutboxApproveOpts,
): Promise<ApproveOutcome> {
  const { db } = ctx;
  const label = OUTBOX_KIND_LABEL[draft.kind];
  const done = (which: string, number: string | null) =>
    `${which} **${number ?? draft.provider_invoice_id ?? ''}** quedó en Siigo.`;
  if (draft.status === 'created')
    return {
      draft,
      already: true,
      warnings: [],
      markdown: `Ese borrador ya está en Siigo (${draft.provider_number ?? draft.provider_invoice_id ?? label}).`,
    };
  if (draft.status === 'discarded') throw new ValidationError('Ese borrador fue descartado.');
  const stuck = draft.status === 'creating' && Date.now() - Date.parse(draft.updated_at) > STUCK_MS;
  if (draft.status === 'creating' && !stuck)
    throw new ValidationError('Ese borrador se está enviando a Siigo en este momento. Espera un minuto y revisa.');
  const problems = outboxDraftProblems(draft);
  if (problems.length) throw new ValidationError(`Antes de aprobar, corrige: ${problems.join(' ')}`);

  const now = new Date().toISOString();
  const { data: claimed, error: claimError } = await db
    .from('app_invoice_drafts')
    .update({ status: 'creating', decided_by: ctx.userId, decided_at: now, updated_at: now, error: null })
    .eq('id', draft.id)
    .in('status', stuck ? ['creating'] : ['pending', 'error'])
    .select(INVOICE_DRAFT_COLUMNS);
  if (claimError) throw claimError;
  if (!(claimed ?? []).length) throw new ValidationError('Ese borrador cambió mientras lo aprobabas; ábrelo de nuevo.');

  const fail = async (message: string): Promise<never> => {
    await db
      .from('app_invoice_drafts')
      .update({ status: 'error', error: message.slice(0, 2000), updated_at: new Date().toISOString() })
      .eq('id', draft.id)
      .eq('status', 'creating');
    throw new ValidationError(message);
  };

  try {
    const conns = (await listAccountingConnections(db)).filter((c) => c.enabled);
    const conn = conns.find((c) => c.provider === (draft.provider ?? 'siigo')) ?? conns.find((c) => c.provider === 'siigo');
    if (!conn) return await fail('Siigo no está conectado (o está en pausa): conéctalo en Integraciones.');
    const session: ProviderSession = await (opts.openSession ?? openAccountingSession)(db, conn.id);
    const out = session.outbound;
    if (!out) return await fail(`${conn.provider} todavía no sabe recibir ${label.toLowerCase()} desde Cortex.`);
    const key = outboxIdempotencyKey(ctx.organizationId, draft.kind, draft.id);
    let created: CreatedProviderDocument;
    let extra = '';
    if (draft.kind === 'customer') {
      const r = await out.upsertCustomer(draft.payload as unknown as CustomerPayload, { idempotencyKey: key });
      created = { id: r.id, number: null, total: null };
      extra = r.created ? 'El cliente se creó en Siigo.' : 'El cliente ya existía en Siigo: no se tocó nada.';
    } else if (draft.kind === 'receipt') {
      if (!out.createReceipt) return await fail(`${conn.provider} todavía no registra recibos de caja desde Cortex.`);
      created = await out.createReceipt(draft.payload as unknown as ReceiptPayload, {
        idempotencyKey: key,
        paymentTypeId: draft.choices.paymentTypeId,
      });
    } else {
      if (!out.createCreditNote) return await fail(`${conn.provider} todavía no crea notas crédito desde Cortex.`);
      created = await out.createCreditNote(draft.payload as unknown as CreditNotePayload, {
        idempotencyKey: key,
        paymentTypeId: draft.choices.paymentTypeId,
        documentTypeId: draft.choices.documentTypeId,
        stamp: opts.sendToDian === true,
      });
    }
    const { data: fin, error: finError } = await db
      .from('app_invoice_drafts')
      .update({
        status: 'created',
        provider: conn.provider,
        provider_invoice_id: created.id || null,
        provider_number: created.number,
        sent_to_dian: draft.kind === 'credit_note' ? opts.sendToDian === true : null,
        error: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', draft.id)
      .select(INVOICE_DRAFT_COLUMNS)
      .single();
    if (finError) throw finError;
    const final = adaptDraftRow(fin as Record<string, unknown>);
    const warnings = await writeBackToRow(db, final, ctx.userId);
    try {
      const synced = await requestAccountingSync(db, conn.provider);
      await ctx.enqueueJob?.('accounting/run', { organizationId: ctx.organizationId, connectionId: synced.id });
    } catch {
      // La sincronización programada lo trae igual (cada 15 minutos).
    }
    return {
      draft: final,
      already: false,
      warnings,
      markdown: `${draft.kind === 'customer' ? extra : done(label, created.number)}${warnings.length ? ` Ojo: ${warnings.join(' ')}` : ''}`,
    };
  } catch (err) {
    if (err instanceof ValidationError) return fail(err.message);
    if (err instanceof ProviderValidationError) return fail(err.message);
    if (err instanceof ProviderUncertainError) return fail(err.message);
    return fail(`No se pudo enviar a Siigo: ${err instanceof Error ? err.message : 'error desconocido'}`);
  }
}

// ---------------------------------------------------------------------------
// Editar el contenido de un borrador que no es factura
// ---------------------------------------------------------------------------

export const outboxPayloadEditSchema = z.object({
  customer: z
    .object({
      taxId: z.string().trim().min(3).max(30).optional(),
      name: z.string().trim().max(200).optional(),
      email: z.string().trim().max(200).optional(),
      phone: z.string().trim().max(40).optional(),
      address: z.string().trim().max(300).optional(),
      city: z.string().trim().max(120).optional(),
      personType: z.enum(['auto', 'company', 'person']).optional(),
      regime: z.enum(['responsable_iva', 'no_responsable']).optional(),
    })
    .optional(),
  receipt: z
    .object({
      date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      reference: z.string().trim().max(200).optional(),
      bankAccount: z.string().trim().max(120).optional(),
      applications: z
        .array(z.object({ invoiceNumber: z.string().trim().min(1).max(60), amount: z.number().positive().max(1e13) }))
        .min(1)
        .max(50)
        .optional(),
    })
    .optional(),
  creditNote: z
    .object({
      date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      reason: z.number().int().refine((n) => (CREDIT_NOTE_REASONS as readonly number[]).includes(n)).optional(),
      observations: z.string().trim().max(1000).optional(),
      invoiceNumber: z.string().trim().min(1).max(60).optional(),
    })
    .optional(),
  choices: z.object({ paymentTypeId: z.string().trim().max(40).optional(), documentTypeId: z.string().trim().max(40).optional() }).optional(),
});
export type OutboxPayloadEdit = z.infer<typeof outboxPayloadEditSchema>;

/** Aplica una edición al contenido de un recibo, nota o cliente. Puro (devuelve el payload nuevo). */
export function applyPayloadEdit(
  kind: OutboxKind,
  payload: Record<string, unknown>,
  edit: OutboxPayloadEdit,
): { payload: Record<string, unknown>; problems: string[] } {
  if (kind === 'customer' && edit.customer) {
    const cur = payload as unknown as CustomerPayload;
    const e = edit.customer;
    const built = buildCustomerPayload({
      taxId: e.taxId ?? cur.taxId,
      name: e.name ?? cur.name,
      email: e.email ?? cur.email ?? undefined,
      phone: e.phone ?? cur.phone ?? undefined,
      address: e.address ?? cur.address ?? undefined,
      city: e.city ?? cur.city?.cityCode ?? undefined,
      personType: e.personType ?? (cur.personType === 'Company' ? 'company' : 'person'),
      regime: e.regime ?? (cur.vatResponsible ? 'responsable_iva' : 'no_responsable'),
    });
    if (!built.payload) throw new ValidationError(built.problems.join(' '));
    return { payload: built.payload as unknown as Record<string, unknown>, problems: built.problems };
  }
  if (kind === 'receipt' && edit.receipt) {
    const cur = payload as unknown as ReceiptPayload;
    const e = edit.receipt;
    const applications = e.applications
      ? e.applications.map((a) => {
          const old = cur.applications.find((x) => x.invoiceNumber === a.invoiceNumber);
          return {
            invoiceNumber: a.invoiceNumber.toUpperCase(),
            invoiceExternalId: old?.invoiceExternalId ?? null,
            invoiceDate: old?.invoiceDate ?? null,
            amount: round2(a.amount),
          };
        })
      : cur.applications;
    const next: ReceiptPayload = {
      ...cur,
      date: e.date ?? cur.date,
      reference: e.reference ?? cur.reference,
      bankAccount: e.bankAccount ?? cur.bankAccount,
      applications,
      amount: round2(applications.reduce((s, a) => s + a.amount, 0)),
    };
    return { payload: next as unknown as Record<string, unknown>, problems: [] };
  }
  if (kind === 'credit_note' && edit.creditNote) {
    const cur = payload as unknown as CreditNotePayload;
    const e = edit.creditNote;
    const next: CreditNotePayload = {
      ...cur,
      date: e.date ?? cur.date,
      reason: (e.reason ?? cur.reason) as CreditNotePayload['reason'],
      observations: e.observations ?? cur.observations,
      invoiceNumber: e.invoiceNumber ? e.invoiceNumber.toUpperCase() : cur.invoiceNumber,
      invoiceExternalId: e.invoiceNumber && e.invoiceNumber.toUpperCase() !== cur.invoiceNumber ? null : cur.invoiceExternalId,
    };
    return { payload: next as unknown as Record<string, unknown>, problems: [] };
  }
  return { payload, problems: [] };
}

export async function updateOutboxPayload(db: SupabaseClient, id: string, raw: unknown): Promise<InvoiceDraftRow> {
  const edit = outboxPayloadEditSchema.parse(raw);
  const current = await getInvoiceDraft(db, id);
  if (!current) throw new NotFoundError('Ese borrador ya no existe.');
  if (current.kind === 'invoice') throw new ValidationError('Las prefacturas se editan con sus líneas.');
  if (current.status !== 'pending' && current.status !== 'error')
    throw new ValidationError('Ese borrador ya no se edita.');
  if (current.kind === 'customer') await ensureSyncedCities(db);
  const { payload } = applyPayloadEdit(current.kind, current.payload, edit);
  const patch: Record<string, unknown> = { payload, updated_at: new Date().toISOString() };
  const p = payload as { amount?: number; taxId?: string; customerTaxId?: string; name?: string };
  if (current.kind === 'receipt') patch.total = p.amount ?? current.total;
  if (current.kind === 'customer') {
    patch.customer_tax_id = p.taxId ?? current.customer_tax_id;
    patch.customer_name = p.name ?? current.customer_name;
  }
  if (edit.choices) patch.choices = { ...current.choices, ...edit.choices };
  const { data, error } = await db
    .from('app_invoice_drafts')
    .update(patch)
    .eq('id', id)
    .in('status', ['pending', 'error'])
    .select(INVOICE_DRAFT_COLUMNS);
  if (error) throw error;
  const row = (data ?? [])[0];
  if (!row) throw new ValidationError('El borrador cambió mientras lo editabas; ábrelo de nuevo.');
  return adaptDraftRow(row as Record<string, unknown>);
}

/** Una línea para el chat y las notificaciones. */
export function describeDraft(d: Pick<InvoiceDraftRow, 'kind' | 'payload'>): string {
  return describeOutbox(d.kind, d.payload);
}
