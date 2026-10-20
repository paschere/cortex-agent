import { ForbiddenError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { isCompanyManager } from '../../directory/store';
import { registerTool } from '../../index';
import { formatMoney } from '../../sales/totals';
import {
  INVOICE_DRAFT_STATUS_LABEL,
  type InvoiceDraftRow,
  type InvoiceDraftStatus,
  approveInvoiceDraft,
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
  const problems = draftProblems(d);
  return `- [${d.customer_name || `NIT ${d.customer_tax_id ?? '?'}`}](${draftHref(d.id)}) \`${d.id}\` · ${formatMoney(d.total)} (con IVA, estimado) · ${INVOICE_DRAFT_STATUS_LABEL[d.status]}${d.row_label ? ` · de «${d.row_label}»` : ''}${d.provider_number ? ` · factura ${d.provider_number}` : ''}${d.error ? ` · ${d.error.slice(0, 160)}` : ''}${problems.length && (d.status === 'pending' || d.status === 'error') ? ` · falta: ${problems.join(' ')}` : ''}`;
}

export const accountingInvoiceDraftsList = registerTool({
  id: 'accounting.invoice_drafts_list',
  description:
    'List the pre-invoices (prefacturas) prepared by automations and waiting for a person to review before anything is created in Siigo (inbox "Prefacturas por revisar", /prefacturas). Default: the ones to review (pending or with error). Read-only; company owners/admins only.',
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
    'APPROVE a pre-invoice prepared by an automation: creates the invoice in Siigo (through Sales: order -> invoice). By default it is created in Siigo WITHOUT sending it to the DIAN (the person sends it from Siigo); set sendToDian=true only if the person explicitly asked to stamp it. Always requires a person to approve; never runs from a routine or an automation. Show the pre-invoice first (accounting.invoice_drafts_list) and relay Siigo validation errors in Spanish. Writes the invoice number back to the source row if the rule asked for it.',
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
    const out = await approveInvoiceDraft(
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

export const accountingInvoiceDraftDiscard = registerTool({
  id: 'accounting.invoice_draft_discard',
  description:
    'DISCARD a pre-invoice that should not be invoiced (nothing was created in Siigo). The source row will not generate another one for the same rule. Requires confirmation; company owners/admins only.',
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
