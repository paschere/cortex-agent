import { ForbiddenError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { isCompanyManager } from '../../directory/store';
import { registerTool } from '../../index';
import { formatMoney } from '../../sales/totals';
import { OUTBOX_KIND_LABEL, OUTBOX_KINDS } from '../../accounting/outbound/shape';
import { bogotaToday } from '../../commitments/shape';
import { randomUUID } from 'node:crypto';
import { approveOutboxItem } from './outbox-approve';
import { describeOutbox, cleanInvoiceNumber, splitInvoiceList } from './outbox-build';
import { buildOutbox, type OutboxAction } from './outbox-run';
import { outboxDraftProblems } from './invoice-drafts';
import {
  INVOICE_DRAFT_STATUS_LABEL,
  type InvoiceDraftRow,
  type InvoiceDraftStatus,
  discardInvoiceDraft,
  draftProblems,
  getInvoiceDraft,
  listInvoiceDrafts,
} from './invoice-drafts';

/**
 * LA BANDEJA «PREFACTURAS POR REVISAR» DESDE EL CHAT. Aprobar es la única
 * puerta a Siigo: pide confirmación a una persona y nunca corre desde una
 * rutina ni desde una automatización.
 */

async function requireManager(ctx: { db: SupabaseClient; userId: string }): Promise<void> {
  if (!(await isCompanyManager(ctx.db, ctx.userId)))
    throw new ForbiddenError('Sólo quien administra la empresa o es su dueño revisa las prefacturas.');
}

export function draftHref(id: string): string {
  return `/prefacturas?abrir=${id}`;
}

function line(d: InvoiceDraftRow): string {
  const problems = outboxDraftProblems(d);
  const kind = d.kind === 'invoice' ? '' : `${OUTBOX_KIND_LABEL[d.kind]}: ${describeOutbox(d.kind, d.payload)} · `;
  return `- ${kind}[${d.customer_name || `NIT ${d.customer_tax_id ?? '?'}`}](${draftHref(d.id)}) \`${d.id}\` · ${formatMoney(d.total)}${d.kind === 'invoice' ? ' (con IVA, estimado)' : ''} · ${INVOICE_DRAFT_STATUS_LABEL[d.status]}${d.row_label ? ` · de «${d.row_label}»` : ''}${d.provider_number ? ` · factura ${d.provider_number}` : ''}${d.error ? ` · ${d.error.slice(0, 160)}` : ''}${problems.length && (d.status === 'pending' || d.status === 'error') ? ` · falta: ${problems.join(' ')}` : ''}`;
}

export const accountingInvoiceDraftsList = registerTool({
  id: 'accounting.invoice_drafts_list',
  description:
    'List what is waiting in the inbox "Por enviar a Siigo" (/prefacturas) for a person to review before anything is created in Siigo: pre-invoices, cash receipts (recibos de caja), credit notes and new customers, prepared by automations or by accounting.outbox_prepare. Default: the ones to review (pending or with error). Read-only; company owners/admins only.',
  inputSchema: z.object({
    status: z
      .enum(['pending', 'error', 'created', 'discarded', 'all'])
      .default('pending')
      .describe('pending = por revisar (also includes those with error); all = everything.'),
  }),
  outputSchema: z.object({ count: z.number(), markdown: z.string() }),
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    await requireManager(ctx);
    const statuses: InvoiceDraftStatus[] | undefined =
      input.status === 'all'
        ? undefined
        : input.status === 'pending'
          ? ['pending', 'error', 'creating']
          : [input.status as InvoiceDraftStatus];
    const rows = await listInvoiceDrafts(ctx.db, { statuses, limit: 50 });
    return {
      count: rows.length,
      markdown: rows.length
        ? `${rows.length} prefactura${rows.length === 1 ? '' : 's'}:\n${rows.map(line).join('\n')}`
        : 'No hay prefacturas en ese estado.',
    };
  },
});

export const accountingInvoiceDraftApprove = registerTool({
  id: 'accounting.invoice_draft_approve',
  description:
    'APPROVE an item of the inbox "Por enviar a Siigo" (any kind: pre-invoice, cash receipt, credit note or customer). Pre-invoice: creates the invoice in Siigo (through Sales: order -> invoice). Receipt: registers the cash receipt against the invoices listed. Credit note: creates it against the invoice (sendToDian stamps it). Customer: creates the third party if it does not exist (never overwrites). By default it is created in Siigo WITHOUT sending it to the DIAN (the person sends it from Siigo); set sendToDian=true only if the person explicitly asked to stamp it. Always requires a person to approve; never runs from a routine or an automation. Show the pre-invoice first (accounting.invoice_drafts_list) and relay Siigo validation errors in Spanish. Writes the invoice number back to the source row if the rule asked for it.',
  inputSchema: z.object({
    id: z.string().uuid().describe('Pre-invoice id (from accounting.invoice_drafts_list).'),
    sendToDian: z
      .boolean()
      .default(false)
      .describe('true = also stamp it with the DIAN; default false = created in Siigo without sending.'),
  }),
  outputSchema: z.object({
    status: z.enum(['created', 'already_created']),
    providerNumber: z.string().nullable(),
    markdown: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 4 },
  handler: async (input, ctx) => {
    if (ctx.surface === 'schedule')
      throw new ValidationError('Una prefactura nunca se aprueba desde una rutina: pídemelo en el chat o en /prefacturas.');
    await requireManager(ctx);
    const out = await approveOutboxItem(
      { db: ctx.db, organizationId: ctx.organizationId, userId: ctx.userId, enqueueJob: ctx.enqueueJob },
      input.id,
      { sendToDian: input.sendToDian },
    );
    return {
      status: out.already ? 'already_created' : 'created',
      providerNumber: out.draft.provider_number,
      markdown: out.markdown,
    };
  },
});

const prepareInput = z.object({
  kind: z.enum(['receipt', 'credit_note', 'customer']),
  customer: z
    .object({
      taxId: z.string().trim().min(3).max(30),
      name: z.string().trim().max(200).optional(),
      email: z.string().trim().max(200).optional(),
      phone: z.string().trim().max(40).optional(),
      address: z.string().trim().max(300).optional(),
      city: z.string().trim().max(120).optional(),
      personType: z.enum(['auto', 'company', 'person']).default('auto'),
      regime: z.enum(['responsable_iva', 'no_responsable']).default('no_responsable'),
    })
    .optional()
    .describe('customer: the third party (NIT or cedula, with or without check digit; the digit is computed). For receipt only taxId is needed.'),
  receipt: z
    .object({
      amount: z.number().positive().max(1e13),
      date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      invoices: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
      reference: z.string().trim().max(200).optional(),
      bankAccount: z.string().trim().max(120).optional(),
    })
    .optional()
    .describe('receipt: payment received. invoices omitted = applied to the customer open invoices, oldest due date first.'),
  creditNote: z
    .object({
      invoiceNumber: z.string().trim().min(1).max(40),
      reason: z.number().int().default(2).describe('DIAN reason: 1 partial return, 2 annulment, 3 rebate, 4 price adjustment, 6 early payment, 7 volume.'),
      observations: z.string().trim().max(1000).optional(),
      date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    })
    .optional()
    .describe('creditNote: always for the WHOLE invoice (copies its lines); partial notes are done by an automation with items.'),
});

export const accountingOutboxPrepare = registerTool({
  id: 'accounting.outbox_prepare',
  description:
    'PREPARE (never send) something to write in Siigo: a customer (third party; created only if the NIT does not exist), a cash receipt against the customer open invoices, or a credit note for a whole invoice. It leaves a DRAFT in the inbox "Por enviar a Siigo" (/prefacturas); nothing reaches Siigo until a person approves it there or with accounting.invoice_draft_approve. Show the draft and what is missing (list it with accounting.invoice_drafts_list). Company owners/admins only.',
  inputSchema: prepareInput,
  outputSchema: z.object({ id: z.string().nullable(), markdown: z.string() }),
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    await requireManager(ctx);
    const today = bogotaToday();
    let action: OutboxAction;
    if (input.kind === 'customer') {
      const c = input.customer;
      if (!c?.name) throw new ValidationError('Para crear un cliente hace falta customer con taxId y name.');
      action = {
        type: 'accounting_upsert_customer',
        taxId: c.taxId,
        name: c.name,
        ...(c.email ? { email: c.email } : {}),
        ...(c.phone ? { phone: c.phone } : {}),
        ...(c.address ? { address: c.address } : {}),
        ...(c.city ? { city: c.city } : {}),
        personType: c.personType ?? 'auto',
        regime: c.regime ?? 'no_responsable',
        notifyRoles: [],
        notifyAdmins: false,
      };
    } else if (input.kind === 'receipt') {
      if (!input.customer || !input.receipt) throw new ValidationError('Para un recibo hace falta customer (taxId) y receipt (amount).');
      action = {
        type: 'accounting_draft_receipt',
        customer: { taxId: input.customer.taxId, ...(input.customer.name ? { name: input.customer.name } : {}) },
        amount: input.receipt.amount,
        ...(input.receipt.date ? { date: input.receipt.date } : {}),
        ...(input.receipt.invoices?.length ? { invoices: input.receipt.invoices.join(', ') } : {}),
        ...(input.receipt.reference ? { reference: input.receipt.reference } : {}),
        ...(input.receipt.bankAccount ? { bankAccount: input.receipt.bankAccount } : {}),
        notifyRoles: [],
        notifyAdmins: false,
      };
    } else {
      if (!input.creditNote) throw new ValidationError('Para una nota crédito hace falta creditNote (invoiceNumber).');
      action = {
        type: 'accounting_draft_credit_note',
        invoice: cleanInvoiceNumber(input.creditNote.invoiceNumber),
        mode: 'total',
        reason: input.creditNote.reason ?? 2,
        ...(input.creditNote.observations ? { observations: input.creditNote.observations } : {}),
        ...(input.creditNote.date ? { date: input.creditNote.date } : {}),
        notifyRoles: [],
        notifyAdmins: false,
      };
    }
    const built = await buildOutbox(ctx.db, action, { after: {} }, undefined, today);
    if ('skip' in built) return { id: null, markdown: built.skip };
    const { data, error } = await ctx.db
      .from('app_invoice_drafts')
      .insert({
        organization_id: ctx.organizationId,
        idempotency_key: `outbox:${built.kind}:chat:${randomUUID()}`,
        kind: built.kind,
        payload: built.payload,
        lines: [],
        customer_tax_id: built.customerTax,
        customer_name: built.customerName,
        currency: 'COP',
        observations: '',
        choices: {},
        write_back: {},
        provider: built.provider,
        total: built.total,
        row_label: 'Preparado desde el chat',
      })
      .select('id')
      .single();
    if (error) throw error;
    const id = (data as { id: string }).id;
    return {
      id,
      markdown: `${built.summary}: [por revisar](${draftHref(id)}) \`${id}\`.${built.problems.length ? ` Falta: ${built.problems.join(' ')}` : ''} Nada se envió a ${built.providerName}; apruébalo en la bandeja o con accounting.invoice_draft_approve.`,
    };
  },
});

export const accountingInvoiceDraftDiscard = registerTool({
  id: 'accounting.invoice_draft_discard',
  description:
    'DISCARD an item of the inbox "Por enviar a Siigo" (pre-invoice, receipt, credit note or customer) that should not be sent (nothing was created in Siigo). The source row will not generate another one for the same rule. Requires confirmation; company owners/admins only.',
  inputSchema: z.object({ id: z.string().uuid() }),
  outputSchema: z.object({ markdown: z.string() }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    await requireManager(ctx);
    const before = await getInvoiceDraft(ctx.db, input.id);
    const d = await discardInvoiceDraft(ctx.db, input.id, ctx.userId);
    return {
      markdown: `Prefactura de ${before?.customer_name || d.customer_name || 'ese cliente'} descartada: no se creó nada en Siigo.`,
    };
  },
});
