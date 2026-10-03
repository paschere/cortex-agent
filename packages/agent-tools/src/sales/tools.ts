import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { searchClients } from '../clients/store';
import { bogotaToday } from '../commitments/shape';
import { gmailFetch } from '../gmail/client';
import { b64url, buildRfc822 } from '../gmail/draft';
import { registerTool } from '../index';
import { GRAPH_SCOPES, graphFetch } from '../msgraph/client';
import { appBaseUrl } from '../reports/store';
import type { ToolContext } from '../types';
import { NO_PROVIDER_GUIDANCE, emitInvoice, previewInvoice } from './emit';
import { type SellableProduct, listSellableProducts, pickProduct } from './products';
import {
  EVENT_LABEL,
  KIND_LABEL,
  STATUS_LABEL,
  type SalesDocumentRow,
  type SalesKind,
  canInvoice,
  documentNumber,
  effectiveStatus,
  parseDocumentNumber,
} from './shape';
import {
  DOC_COLUMNS,
  createSalesDocument,
  ensureShareToken,
  findSalesDocumentByNumber,
  getSalesDocument,
  getSalesDocumentRow,
  listSalesDocuments,
  markQuoteSent,
  salesLineInputSchema,
  withholdingsSchema,
} from './store';
import { TAX_RATE_LABEL, displayTotal, formatMoney } from './totals';

/**
 * VENTAS DESDE EL CHAT (migración 0182): cotizar, mandar la cotización,
 * facturar y consultar. Ver la cabecera de infra/supabase/migrations/0182_sales_documents.sql.
 *
 *   sales.quote_create   «hazle una cotización a Nexa de 10 fletes Bogotá–Cali a
 *                        $1.2M». Pide confirmación: crea un documento con número.
 *   sales.quote_send     manda el enlace de la cotización por Gmail u Outlook.
 *                        Pide confirmación (sale de la empresa).
 *   sales.invoice_emit   emite la factura electrónica en Siigo o Alegra desde
 *                        una cotización aceptada o un pedido. Confirmación
 *                        OBLIGATORIA siempre (security/mandatory-confirmation)
 *                        y nunca desde una rutina.
 *   sales.list           lista, o el detalle de uno con su línea de tiempo y la
 *                        vista previa de la factura que saldría. Sólo lectura.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function salesDocumentHref(id: string): string {
  return `/ventas/${id}`;
}

export function quotePublicUrl(token: string): string {
  return `${appBaseUrl()}/cotizacion/${token}`;
}

/** «COT-12», un uuid, o el número legal de la factura («FV-2-22»). */
export async function resolveSalesDocument(
  db: SupabaseClient,
  ref: string,
): Promise<SalesDocumentRow> {
  const clean = ref.trim();
  if (UUID_RE.test(clean)) {
    const doc = await getSalesDocumentRow(db, clean);
    if (doc) return doc;
  }
  const parsed = parseDocumentNumber(clean);
  if (parsed) {
    const doc = await findSalesDocumentByNumber(db, parsed.kind, parsed.number);
    if (doc) return doc;
  }
  const { data, error } = await db
    .from('sales_documents')
    .select('id')
    .eq('provider_number', clean)
    .limit(1);
  if (error) throw error;
  const id = (data?.[0] as { id?: string } | undefined)?.id;
  if (id) {
    const doc = await getSalesDocumentRow(db, id);
    if (doc) return doc;
  }
  throw new NotFoundError(
    `No encuentro «${clean}». Dime el número (COT-12, PED-3) o búscalo con sales.list.`,
  );
}

async function companyName(db: SupabaseClient): Promise<string> {
  const { data, error } = await db.from('company_branding').select('display_name').maybeSingle();
  if (error) return '';
  return ((data as { display_name?: string | null } | null)?.display_name ?? '').trim();
}

// ---------------------------------------------------------------------------
// sales.quote_create
// ---------------------------------------------------------------------------

const quoteLineSchema = salesLineInputSchema.extend({
  unitPrice: z.coerce
    .number()
    .finite()
    .min(0)
    .max(1e13)
    .optional()
    .describe(
      'Unit price BEFORE IVA in COP. «$1.2M» = 1200000. Omit only when the product catalog has the price.',
    ),
});

async function resolveClient(
  db: SupabaseClient,
  input: { client: string; clientId?: string | null },
) {
  if (input.clientId) return { clientId: input.clientId, clientName: input.client, note: null };
  const hits = await searchClients(db, input.client, 5);
  const exact = hits.filter(
    (h) =>
      h.matchedOn === 'nit' || h.client.name.toLowerCase() === input.client.trim().toLowerCase(),
  );
  const chosen = exact.length === 1 ? exact[0] : hits.length === 1 ? hits[0] : null;
  if (chosen) return { clientId: chosen.client.id, clientName: chosen.client.name, note: null };
  if (hits.length > 1)
    throw new ValidationError(
      `Hay varios clientes que se parecen a «${input.client}»: ${hits
        .map((h) => h.client.name)
        .join(', ')}. ¿Para cuál es la cotización?`,
    );
  return {
    clientId: null,
    clientName: input.client.trim(),
    note: `«${input.client.trim()}» no está en Clientes: la cotización queda a ese nombre, sin NIT.`,
  };
}

function withCatalog(
  lines: z.infer<typeof quoteLineSchema>[],
  products: SellableProduct[],
): { lines: z.infer<typeof salesLineInputSchema>[]; matched: number } {
  let matched = 0;
  const out = lines.map((line) => {
    const byCode = line.productCode
      ? products.find((p) => p.code === line.productCode || p.ref === line.productCode)
      : null;
    const product = byCode ?? (line.productRef ? null : pickProduct(products, line.description));
    if (product) matched += 1;
    const unitPrice = line.unitPrice ?? product?.price ?? undefined;
    if (unitPrice === undefined)
      throw new ValidationError(
        `Falta el precio de «${line.description}». Dime cuánto vale cada uno (antes de IVA).`,
      );
    return {
      ...line,
      unitPrice,
      productRef: line.productRef ?? product?.ref ?? null,
      productCode: line.productCode ?? product?.code ?? null,
      unit: line.unit ?? product?.unit ?? null,
    };
  });
  return { lines: out, matched };
}

function totalsLine(doc: SalesDocumentRow): string {
  const shown = displayTotal(doc.total, doc.currency);
  const parts = [
    `subtotal ${formatMoney(doc.tax_base, doc.currency)}`,
    doc.iva_total > 0 ? `IVA ${formatMoney(doc.iva_total, doc.currency)}` : 'sin IVA',
    `**total ${formatMoney(shown.value, doc.currency)}**`,
  ];
  if (doc.withholding_total > 0)
    parts.push(`neto estimado a recibir ${formatMoney(doc.net_total, doc.currency)}`);
  return parts.join(' · ');
}

export const salesQuoteCreate = registerTool({
  id: 'sales.quote_create',
  description:
    'Create a sales quote (cotización) for a client: «hazle una cotización a Nexa de 10 fletes Bogotá–Cali a $1.2M», «cotízale a Coltrans 3 meses de soporte». Resolves the client from Clientes by name or NIT, matches each line to the accounting program product catalog when it can (needed later for the electronic invoice), computes IVA (19 % by default; 5 %, 0 % exento or excluido per line), discounts and optional retenciones, and numbers it COT-n. Requires confirmation. It does NOT send it — offer sales.quote_send after. Prices are BEFORE IVA unless the person says otherwise (then divide by 1.19).',
  inputSchema: z.object({
    client: z.string().trim().min(2).max(200).describe('Client name or NIT as the person said it'),
    clientId: z.string().uuid().optional().describe('Client id from clients.search, if known'),
    lines: z.array(quoteLineSchema).min(1).max(100),
    validDays: z.coerce.number().int().min(1).max(180).optional().describe('Default 15'),
    paymentDays: z.coerce
      .number()
      .int()
      .min(0)
      .max(365)
      .optional()
      .describe('Credit days; 0 = contado. Default: the client terms, else 30'),
    notes: z.string().max(2000).optional(),
    terms: z.string().max(2000).optional(),
    withholdings: withholdingsSchema
      .optional()
      .describe('Only if the person mentions retenciones (retefuente %, ICA por mil, ReteIVA %)'),
  }),
  outputSchema: z.object({
    documentId: z.string(),
    number: z.string(),
    total: z.number(),
    href: z.string(),
    markdown: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const client = await resolveClient(ctx.db, input);
    const products = await listSellableProducts(ctx.db).catch(() => []);
    const { lines, matched } = withCatalog(input.lines, products);
    const today = bogotaToday();
    const doc = await createSalesDocument(
      ctx.db,
      'quote',
      {
        clientId: client.clientId,
        clientName: client.clientName,
        validUntil: input.validDays
          ? new Date(Date.parse(`${today}T12:00:00Z`) + input.validDays * 86_400_000)
              .toISOString()
              .slice(0, 10)
          : undefined,
        paymentDays: input.paymentDays,
        notes: input.notes,
        terms: input.terms,
        withholdings: input.withholdings,
        lines,
      },
      { userId: ctx.userId, today },
    );
    const number = documentNumber(doc);
    const markdown = [
      `Cotización **${number}** para ${doc.client_name}: ${totalsLine(doc)}. Válida hasta ${doc.valid_until}.`,
      client.note,
      products.length && matched < lines.length
        ? `${lines.length - matched} de ${lines.length} líneas no tienen producto del programa contable: se puede cotizar, pero para facturar electrónicamente hay que elegirlo en /ventas.`
        : null,
      `Ábrela en [${number}](${salesDocumentHref(doc.id)}). ¿Se la mando al cliente?`,
    ]
      .filter(Boolean)
      .join('\n');
    return {
      documentId: doc.id,
      number,
      total: doc.total,
      href: salesDocumentHref(doc.id),
      markdown,
    };
  },
});

// ---------------------------------------------------------------------------
// sales.quote_send
// ---------------------------------------------------------------------------

export function quoteEmail(input: {
  doc: SalesDocumentRow;
  link: string;
  company: string;
  message?: string | null;
}): { subject: string; body: string } {
  const { doc, link } = input;
  const number = documentNumber(doc);
  const company = input.company || 'nuestra empresa';
  const total = displayTotal(doc.total, doc.currency).value;
  const greeting = doc.contact_name ? `Hola ${doc.contact_name.split(' ')[0]},` : 'Hola,';
  const body = [
    greeting,
    '',
    input.message?.trim() ||
      `Te comparto la cotización ${number} de ${company} por ${formatMoney(total, doc.currency)}${doc.iva_total > 0 ? ' (IVA incluido)' : ''}.`,
    '',
    `Puedes verla, descargarla en PDF y aceptarla aquí:\n${link}`,
    doc.valid_until ? `\nEs válida hasta el ${doc.valid_until}.` : '',
    '',
    'Quedo atento a cualquier pregunta.',
  ]
    .filter((line) => line !== null)
    .join('\n');
  return { subject: `Cotización ${number} — ${company}`.slice(0, 300), body };
}

async function sendMail(
  ctx: ToolContext,
  mail: { to: string[]; subject: string; body: string },
): Promise<'gmail' | 'outlook'> {
  const gmail = await ctx.integrations
    .hasScopes('google', ['https://www.googleapis.com/auth/gmail.compose'])
    .catch(() => false);
  if (gmail) {
    await gmailFetch(ctx, '/messages/send', {
      method: 'POST',
      body: JSON.stringify({ raw: b64url(buildRfc822(mail)) }),
    });
    return 'gmail';
  }
  const outlook = await ctx.integrations
    .hasScopes('microsoft', [GRAPH_SCOPES.MAIL_SEND])
    .catch(() => false);
  if (outlook) {
    await graphFetch<void>(ctx, '/me/sendMail', {
      method: 'POST',
      body: JSON.stringify({
        message: {
          subject: mail.subject,
          body: { contentType: 'Text', content: mail.body },
          toRecipients: mail.to.map((address) => ({ emailAddress: { address } })),
        },
        saveToSentItems: true,
      }),
    });
    return 'outlook';
  }
  throw new ValidationError(
    'Para mandar la cotización por correo conecta Gmail u Outlook en Integraciones. Mientras tanto puedes copiar el enlace desde /ventas y mandarlo tú.',
  );
}

export const salesQuoteSend = registerTool({
  id: 'sales.quote_send',
  description:
    "Email a quote to the client from the user's Gmail or Outlook: the email carries a private link where the client sees the branded quote, downloads the PDF and clicks «Aceptar cotización». Requires confirmation. `to` defaults to the client's email on the quote; ask for it if the quote has none. Marks the quote as sent.",
  inputSchema: z.object({
    quote: z.string().trim().min(1).max(80).describe('Quote number (COT-12) or id'),
    to: z.array(z.string().email()).min(1).max(5).optional(),
    message: z
      .string()
      .max(2000)
      .optional()
      .describe('Optional first paragraph instead of the default one'),
  }),
  outputSchema: z.object({
    sentTo: z.array(z.string()),
    via: z.enum(['gmail', 'outlook']),
    link: z.string(),
    markdown: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 6 },
  handler: async (input, ctx) => {
    const doc = await resolveSalesDocument(ctx.db, input.quote);
    if (doc.kind !== 'quote')
      throw new ValidationError(`${documentNumber(doc)} no es una cotización.`);
    if (!['borrador', 'enviada', 'aceptada'].includes(doc.status))
      throw new ValidationError(
        `${documentNumber(doc)} está ${STATUS_LABEL[doc.status].toLowerCase()}: no tiene sentido mandarla.`,
      );
    const to = input.to?.length ? input.to : doc.client_email ? [doc.client_email] : [];
    if (!to.length)
      throw new ValidationError(
        `${documentNumber(doc)} no tiene correo del cliente. ¿A qué correo la mando?`,
      );
    const token = await ensureShareToken(ctx.db, doc);
    const link = quotePublicUrl(token);
    const mail = quoteEmail({
      doc,
      link,
      company: await companyName(ctx.db),
      message: input.message,
    });
    const via = await sendMail(ctx, { to, ...mail });
    await markQuoteSent(ctx.db, doc, to.join(', '), ctx.userId);
    return {
      sentTo: to,
      via,
      link,
      markdown: `Listo: le mandé ${documentNumber(doc)} a ${to.join(', ')} desde tu ${via === 'gmail' ? 'Gmail' : 'Outlook'}. Cuando el cliente la acepte desde el enlace te aviso en la campana.`,
    };
  },
});

// ---------------------------------------------------------------------------
// sales.invoice_emit
// ---------------------------------------------------------------------------

export const salesInvoiceEmit = registerTool({
  id: 'sales.invoice_emit',
  description:
    'Issue the ELECTRONIC INVOICE (factura electrónica) for an accepted quote or an order, in the connected accounting program (Siigo or Alegra), which stamps it with the DIAN. Always requires a person to approve; never runs from a routine. Before calling it, show the preview from sales.list with `document` (lines, totals, customer, problems). If no program is connected it prepares the invoice in Cortex and says how to connect one — it is NOT stamped then; never say it was. Provider validation errors come back in Spanish: relay them and what to fix.',
  inputSchema: z.object({
    document: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .describe('Accepted quote (COT-12), order (PED-3) or prepared invoice (FAC-2) number or id'),
    provider: z
      .enum(['siigo', 'alegra'])
      .optional()
      .describe('Only when both Siigo and Alegra are connected'),
    retryUncertain: z
      .boolean()
      .optional()
      .describe(
        'Only after the person checked Alegra and the invoice from a cut-off attempt is NOT there',
      ),
  }),
  outputSchema: z.object({
    status: z.enum(['emitted', 'already_emitted']),
    invoiceId: z.string(),
    providerNumber: z.string().nullable(),
    cufe: z.string().nullable(),
    href: z.string(),
    markdown: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 4 },
  handler: async (input, ctx) => {
    // Una factura electrónica es un documento legal ante la DIAN: nunca sale
    // sin una persona mirando, aunque una rutina tenga permiso de escribir.
    if (ctx.surface === 'schedule')
      throw new ValidationError(
        'La factura electrónica nunca se emite desde una rutina: pídemelo en el chat o en /ventas.',
      );
    const doc = await resolveSalesDocument(ctx.db, input.document);
    const outcome = await emitInvoice(
      {
        db: ctx.db,
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        enqueueJob: ctx.enqueueJob,
      },
      doc.id,
      { provider: input.provider, retryUncertain: input.retryUncertain },
    );
    return {
      status: outcome.status,
      invoiceId: outcome.invoice.id,
      providerNumber: outcome.invoice.provider_number,
      cufe: outcome.invoice.cufe,
      href: salesDocumentHref(outcome.invoice.id),
      markdown: outcome.markdown,
    };
  },
});

// ---------------------------------------------------------------------------
// sales.list
// ---------------------------------------------------------------------------

function rowLine(doc: SalesDocumentRow, today: string): string {
  const status = STATUS_LABEL[effectiveStatus(doc, today)];
  return `- [${documentNumber(doc)}](${salesDocumentHref(doc.id)}) · ${doc.client_name} · ${formatMoney(displayTotal(doc.total, doc.currency).value, doc.currency)} · ${status} · ${doc.issue_date}`;
}

async function detailMarkdown(ctx: ToolContext, ref: string): Promise<string> {
  const base = await resolveSalesDocument(ctx.db, ref);
  const detail = await getSalesDocument(ctx.db, base.id);
  if (!detail) throw new NotFoundError('Ese documento ya no existe.');
  const { doc, lines, events, related } = detail;
  const today = bogotaToday();
  const out = [
    `**${KIND_LABEL[doc.kind].one} ${documentNumber(doc)}** — ${doc.client_name}${doc.client_tax_id ? ` (NIT ${doc.client_tax_id})` : ''} · ${STATUS_LABEL[effectiveStatus(doc, today)]}`,
    ...lines.map(
      (l) =>
        `- ${l.description}${l.product_code ? ` [${l.product_code}]` : ''}: ${l.quantity} × ${formatMoney(l.unit_price, doc.currency)}${l.discount_pct ? ` −${l.discount_pct} %` : ''} · ${TAX_RATE_LABEL[l.tax_rate]} = ${formatMoney(l.line_total, doc.currency)}`,
    ),
    totalsLine(doc),
  ];
  if (doc.kind === 'invoice' && doc.status === 'emitida')
    out.push(
      `Emitida en ${doc.provider === 'siigo' ? 'Siigo' : 'Alegra'}: ${doc.provider_number ?? doc.provider_invoice_id}${doc.cufe ? ` · CUFE ${doc.cufe}` : ''}${doc.einvoice_status ? ` · DIAN: ${doc.einvoice_status}` : ''}.`,
    );
  if (doc.provider_error) out.push(`Último error del programa: ${doc.provider_error}`);
  if (related.length)
    out.push(
      `Relacionados: ${related.map((r) => `[${documentNumber(r)}](${salesDocumentHref(r.id)}) (${STATUS_LABEL[r.status]})`).join(', ')}`,
    );
  if (events.length)
    out.push(
      `Historia: ${events
        .slice(-8)
        .map(
          (e) =>
            `${e.created_at.slice(0, 10)} ${EVENT_LABEL[e.kind]}${e.detail ? ` (${e.detail})` : ''}`,
        )
        .join(' → ')}`,
    );
  if (canInvoice(doc)) {
    try {
      const preview = await previewInvoice(ctx.db, doc.id);
      if (!preview.draft)
        out.push(`\nFactura electrónica: ${preview.guidance ?? NO_PROVIDER_GUIDANCE}`);
      else {
        const s = preview.draft.summary;
        out.push(
          `\n**Vista previa de la factura en ${preview.providerName}** — ${s.customer} · ${s.documentType ?? 'numeración por defecto'} · ${s.payment}, vence ${s.dueDate} · total ${formatMoney(s.total)}`,
        );
        if (preview.draft.problems.length)
          out.push(`No se puede emitir todavía: ${preview.draft.problems.join(' ')}`);
        else out.push('Lista para emitir (pide aprobación con sales.invoice_emit).');
        if (preview.draft.notes.length) out.push(preview.draft.notes.join(' '));
      }
    } catch (err) {
      out.push(
        `\nNo pude armar la vista previa de la factura: ${err instanceof Error ? err.message : 'error desconocido'}`,
      );
    }
  }
  return out.join('\n');
}

export const salesList = registerTool({
  id: 'sales.list',
  description:
    'List quotes (cotizaciones), orders (pedidos) and invoices (facturas) made in Cortex, or show ONE in detail with its lines, totals, history and — if it can be invoiced — the preview of the electronic invoice that would be sent to Siigo/Alegra (and what blocks it). Read-only. Use it for «¿qué cotizaciones tengo pendientes?», «¿Nexa aceptó?», «muéstrame la COT-12», and before sales.invoice_emit.',
  inputSchema: z.object({
    document: z
      .string()
      .trim()
      .max(80)
      .optional()
      .describe('One document: COT-12, PED-3, FAC-2 or id'),
    kind: z.enum(['quote', 'order', 'invoice']).optional(),
    client: z.string().trim().max(200).optional().describe('Client name or NIT'),
    status: z
      .string()
      .trim()
      .max(20)
      .optional()
      .describe('borrador, enviada, aceptada, pedido, facturada, emitida…'),
    limit: z.coerce.number().int().min(1).max(50).default(15),
  }),
  outputSchema: z.object({ markdown: z.string(), count: z.number().int() }),
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    if (input.document) return { markdown: await detailMarkdown(ctx, input.document), count: 1 };
    let clientId: string | undefined;
    if (input.client) {
      const hits = await searchClients(ctx.db, input.client, 3);
      if (!hits.length)
        return { markdown: `No hay ningún cliente que se parezca a «${input.client}».`, count: 0 };
      clientId = hits[0]?.client.id;
    }
    const today = bogotaToday();
    const rows = (
      await listSalesDocuments(ctx.db, {
        kind: input.kind as SalesKind | undefined,
        clientId,
        limit: 200,
      })
    ).filter((d) => !input.status || effectiveStatus(d, today) === input.status);
    const shown = rows.slice(0, input.limit ?? 15);
    if (!shown.length)
      return {
        markdown:
          'No hay documentos de venta con esos filtros. Se crea una cotización con sales.quote_create o en /ventas.',
        count: 0,
      };
    const pending = rows.filter(
      (d) => d.kind === 'quote' && effectiveStatus(d, today) === 'enviada',
    );
    return {
      count: rows.length,
      markdown: [
        ...shown.map((d) => rowLine(d, today)),
        rows.length > shown.length ? `…y ${rows.length - shown.length} más en /ventas.` : null,
        pending.length
          ? `\n${pending.length} cotización(es) enviada(s) esperando respuesta por ${formatMoney(pending.reduce((s, d) => s + d.total, 0))}.`
          : null,
      ]
        .filter(Boolean)
        .join('\n'),
    };
  },
});
