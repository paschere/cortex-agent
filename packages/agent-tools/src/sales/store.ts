import { randomBytes } from 'node:crypto';
import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { getClient, listContacts } from '../clients/store';
import { bogotaToday } from '../commitments/shape';
import { addDaysIso } from './einvoice';
import {
  type SalesDocumentRow,
  type SalesEventKind,
  type SalesEventRow,
  type SalesKind,
  type SalesLineRow,
  documentNumber,
  isEditable,
} from './shape';
import { TAX_RATES, type Withholdings, documentTotals } from './totals';

/**
 * LAS COTIZACIONES, PEDIDOS Y FACTURAS EN LA BASE (migración 0182).
 *
 * Todo pasa por el handle con alcance de la empresa (el de la herramienta o el
 * de la pantalla): ninguna función de aquí recibe un `organization_id`, porque
 * el handle ES la empresa. La única lectura sin alcance —buscar una cotización
 * por el token de su enlace— vive en apps/web/lib/sales/public.ts.
 *
 * Los totales se calculan SIEMPRE aquí, con sales/totals.ts, a partir de las
 * líneas: nadie de afuera (ni el modelo, ni el navegador) puede escribir un
 * total que no salga de sus líneas.
 *
 * Las lecturas miran `error`: una tabla que no responde es un error que se
 * dice, no una lista vacía que se cree.
 */

export const DOC_COLUMNS =
  'id, organization_id, kind, number, status, source_id, client_id, client_name, client_tax_id, client_email, contact_name, issue_date, valid_until, due_date, currency, payment_form, payment_days, notes, terms, withholdings, subtotal, discount_total, tax_base, iva_total, total, withholding_total, net_total, share_token, share_views, sent_at, sent_to, accepted_at, accepted_by_name, rejected_at, rejection_reason, provider, provider_invoice_id, provider_number, cufe, einvoice_status, provider_url, provider_error, emission_uncertain, emission_attempted_at, emitted_at, created_by, updated_by, created_at, updated_at';

const LINE_COLUMNS =
  'id, document_id, position, description, product_ref, product_code, unit, quantity, unit_price, discount_pct, tax_rate, gross, discount, base, iva, line_total';

const EVENT_COLUMNS = 'id, document_id, kind, detail, actor_user_id, actor_label, created_at';

/** Días de validez de una cotización si nadie dice otra cosa. */
export const DEFAULT_VALID_DAYS = 15;

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

const money = z.coerce.number().finite().min(0).max(1e13);

export const salesLineInputSchema = z.object({
  description: z.string().trim().min(1).max(1000),
  quantity: z.coerce.number().finite().positive().max(1e9),
  unitPrice: money.describe('Unit price BEFORE IVA, in the document currency'),
  discountPct: z.coerce.number().finite().min(0).max(100).optional(),
  taxRate: z
    .enum(TAX_RATES as unknown as [string, ...string[]])
    .optional()
    .describe('iva_19 (default), iva_5, iva_0 (exento) or excluido'),
  productRef: z.string().trim().max(120).nullish(),
  productCode: z.string().trim().max(120).nullish(),
  unit: z.string().trim().max(40).nullish(),
});

export const withholdingsSchema = z.object({
  retefuentePct: z.coerce.number().min(0).max(20).optional(),
  reteicaPerMil: z.coerce.number().min(0).max(20).optional(),
  reteivaPct: z.coerce.number().min(0).max(100).optional(),
});

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const salesDocumentInputSchema = z.object({
  clientId: z.string().uuid().nullish(),
  clientName: z.string().trim().min(1).max(200),
  clientTaxId: z.string().trim().max(20).nullish(),
  clientEmail: z.string().trim().email().max(320).nullish().or(z.literal('')),
  contactName: z.string().trim().max(200).nullish(),
  issueDate: isoDay.optional(),
  validUntil: isoDay.nullish(),
  dueDate: isoDay.nullish(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  paymentForm: z.enum(['contado', 'credito']).optional(),
  paymentDays: z.coerce.number().int().min(0).max(365).optional(),
  notes: z.string().max(4000).nullish(),
  terms: z.string().max(4000).nullish(),
  withholdings: withholdingsSchema.optional(),
  lines: z.array(salesLineInputSchema).min(1).max(200),
});

export type SalesLineInput = z.infer<typeof salesLineInputSchema>;
export type SalesDocumentInput = z.infer<typeof salesDocumentInputSchema>;

/** Sólo dígitos, sin el dígito de verificación si viene con guion. */
export function cleanTaxId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const [main] = raw.split('-');
  const digits = (main ?? '').replace(/\D/g, '');
  return digits.length >= 3 && digits.length <= 15 ? digits : null;
}

function withholdingsJson(w: Withholdings | undefined) {
  const out: Record<string, number> = {};
  if (w?.retefuentePct) out.retefuente_pct = w.retefuentePct;
  if (w?.reteicaPerMil) out.reteica_per_mil = w.reteicaPerMil;
  if (w?.reteivaPct) out.reteiva_pct = w.reteivaPct;
  return out;
}

export function withholdingsOf(doc: Pick<SalesDocumentRow, 'withholdings'>): Withholdings {
  const w = doc.withholdings ?? {};
  return {
    retefuentePct: Number(w.retefuente_pct ?? 0) || undefined,
    reteicaPerMil: Number(w.reteica_per_mil ?? 0) || undefined,
    reteivaPct: Number(w.reteiva_pct ?? 0) || undefined,
  };
}

/** Las líneas y los totales, como se guardan. */
export function computeRows(input: Pick<SalesDocumentInput, 'lines' | 'withholdings'>) {
  const totals = documentTotals(
    input.lines.map((l) => ({
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discountPct: l.discountPct,
      taxRate: (l.taxRate ?? 'iva_19') as (typeof TAX_RATES)[number],
    })),
    input.withholdings ?? {},
  );
  const lines = input.lines.map((l, i) => {
    const t = totals.lines[i];
    return {
      position: i + 1,
      description: l.description,
      product_ref: l.productRef || null,
      product_code: l.productCode || null,
      unit: l.unit || null,
      quantity: l.quantity,
      unit_price: l.unitPrice,
      discount_pct: l.discountPct ?? 0,
      tax_rate: l.taxRate ?? 'iva_19',
      gross: t?.gross ?? 0,
      discount: t?.discount ?? 0,
      base: t?.base ?? 0,
      iva: t?.iva ?? 0,
      line_total: t?.lineTotal ?? 0,
    };
  });
  return {
    lines,
    totals,
    columns: {
      subtotal: totals.subtotal,
      discount_total: totals.discountTotal,
      tax_base: totals.taxBase,
      iva_total: totals.ivaTotal,
      total: totals.total,
      withholding_total: totals.withholdingTotal,
      net_total: totals.netTotal,
    },
  };
}

// ---------------------------------------------------------------------------
// Lecturas
// ---------------------------------------------------------------------------

function adaptDoc(raw: Record<string, unknown>): SalesDocumentRow {
  const num = (k: string) => Number(raw[k] ?? 0);
  return {
    ...(raw as unknown as SalesDocumentRow),
    number: num('number'),
    payment_days: num('payment_days'),
    subtotal: num('subtotal'),
    discount_total: num('discount_total'),
    tax_base: num('tax_base'),
    iva_total: num('iva_total'),
    total: num('total'),
    withholding_total: num('withholding_total'),
    net_total: num('net_total'),
    share_views: num('share_views'),
    withholdings: (raw.withholdings as SalesDocumentRow['withholdings']) ?? {},
  };
}

function adaptLine(raw: Record<string, unknown>): SalesLineRow {
  const num = (k: string) => Number(raw[k] ?? 0);
  return {
    ...(raw as unknown as SalesLineRow),
    position: num('position'),
    quantity: num('quantity'),
    unit_price: num('unit_price'),
    discount_pct: num('discount_pct'),
    gross: num('gross'),
    discount: num('discount'),
    base: num('base'),
    iva: num('iva'),
    line_total: num('line_total'),
  };
}

export interface SalesDocumentDetail {
  doc: SalesDocumentRow;
  lines: SalesLineRow[];
  events: SalesEventRow[];
  /** El documento de origen y los que salieron de éste (la cadena del negocio). */
  related: SalesDocumentRow[];
}

export async function getSalesDocumentRow(
  db: SupabaseClient,
  id: string,
): Promise<SalesDocumentRow | null> {
  const { data, error } = await db
    .from('sales_documents')
    .select(DOC_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data ? adaptDoc(data as Record<string, unknown>) : null;
}

export async function getSalesLines(
  db: SupabaseClient,
  documentId: string,
): Promise<SalesLineRow[]> {
  const { data, error } = await db
    .from('sales_document_lines')
    .select(LINE_COLUMNS)
    .eq('document_id', documentId)
    .order('position', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map(adaptLine);
}

export async function getSalesDocument(
  db: SupabaseClient,
  id: string,
): Promise<SalesDocumentDetail | null> {
  const doc = await getSalesDocumentRow(db, id);
  if (!doc) return null;
  const [lines, eventsRes, childrenRes, source] = await Promise.all([
    getSalesLines(db, id),
    db
      .from('sales_document_events')
      .select(EVENT_COLUMNS)
      .eq('document_id', id)
      .order('created_at', { ascending: true })
      .limit(200),
    db.from('sales_documents').select(DOC_COLUMNS).eq('source_id', id).limit(20),
    doc.source_id ? getSalesDocumentRow(db, doc.source_id) : Promise.resolve(null),
  ]);
  if (eventsRes.error) throw eventsRes.error;
  if (childrenRes.error) throw childrenRes.error;
  const children = ((childrenRes.data ?? []) as Record<string, unknown>[]).map(adaptDoc);
  return {
    doc,
    lines,
    events: (eventsRes.data ?? []) as SalesEventRow[],
    related: [...(source ? [source] : []), ...children],
  };
}

export interface ListSalesOptions {
  kind?: SalesKind;
  clientId?: string;
  status?: string;
  limit?: number;
}

export async function listSalesDocuments(
  db: SupabaseClient,
  opts: ListSalesOptions = {},
): Promise<SalesDocumentRow[]> {
  let q = db.from('sales_documents').select(DOC_COLUMNS);
  if (opts.kind) q = q.eq('kind', opts.kind);
  if (opts.clientId) q = q.eq('client_id', opts.clientId);
  if (opts.status) q = q.eq('status', opts.status);
  const { data, error } = await q
    .order('created_at', { ascending: false })
    .limit(Math.min(opts.limit ?? 500, 1000));
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map(adaptDoc);
}

export async function findSalesDocumentByNumber(
  db: SupabaseClient,
  kind: SalesKind,
  number: number,
): Promise<SalesDocumentRow | null> {
  const { data, error } = await db
    .from('sales_documents')
    .select(DOC_COLUMNS)
    .eq('kind', kind)
    .eq('number', number)
    .maybeSingle();
  if (error) throw error;
  return data ? adaptDoc(data as Record<string, unknown>) : null;
}

// ---------------------------------------------------------------------------
// Escrituras
// ---------------------------------------------------------------------------

export async function recordSalesEvent(
  db: SupabaseClient,
  documentId: string,
  kind: SalesEventKind,
  opts: { detail?: string | null; userId?: string | null; actorLabel?: string | null } = {},
): Promise<void> {
  const { error } = await db.from('sales_document_events').insert({
    document_id: documentId,
    kind,
    detail: opts.detail?.slice(0, 2000) ?? null,
    actor_user_id: opts.userId ?? null,
    actor_label: opts.actorLabel?.slice(0, 200) ?? null,
  });
  if (error) throw error;
}

async function nextNumber(db: SupabaseClient, kind: SalesKind): Promise<number> {
  const { data, error } = await db.rpc('sales_next_number', { p_kind: kind });
  if (error) throw error;
  const n = Number(data);
  if (!Number.isInteger(n) || n < 1) throw new Error('No se pudo reservar el consecutivo.');
  return n;
}

/**
 * Completa lo que el cliente del hub ya sabe: nombre, NIT, días de pago y el
 * correo del contacto principal. Lo que se escribió a mano gana.
 */
async function withClientDefaults(
  db: SupabaseClient,
  input: SalesDocumentInput,
): Promise<SalesDocumentInput> {
  if (!input.clientId) return input;
  const client = await getClient(db, input.clientId);
  if (!client) throw new ValidationError('Ese cliente ya no existe.');
  let email = input.clientEmail || null;
  let contact = input.contactName ?? null;
  if (!email) {
    const contacts = await listContacts(db, client.id).catch(() => []);
    const primary =
      contacts.find((c) => c.is_primary && c.email && c.status !== 'left') ??
      contacts.find((c) => c.email && c.status !== 'left');
    if (primary) {
      email = primary.email;
      contact ??= primary.full_name;
    }
  }
  return {
    ...input,
    clientName: input.clientName || client.name,
    clientTaxId: input.clientTaxId || client.tax_id,
    clientEmail: email,
    contactName: contact,
    paymentDays: input.paymentDays ?? client.payment_terms_days ?? undefined,
  };
}

function docColumns(input: SalesDocumentInput, today: string) {
  const computed = computeRows(input);
  const paymentDays = input.paymentDays ?? 30;
  return {
    computed,
    row: {
      client_id: input.clientId ?? null,
      client_name: input.clientName.trim(),
      client_tax_id: cleanTaxId(input.clientTaxId),
      client_email: input.clientEmail || null,
      contact_name: input.contactName || null,
      issue_date: input.issueDate ?? today,
      currency: input.currency ?? 'COP',
      payment_form: input.paymentForm ?? (paymentDays === 0 ? 'contado' : 'credito'),
      payment_days: paymentDays,
      notes: input.notes || null,
      terms: input.terms || null,
      withholdings: withholdingsJson(input.withholdings),
      ...computed.columns,
    },
  };
}

async function insertLines(
  db: SupabaseClient,
  documentId: string,
  lines: ReturnType<typeof computeRows>['lines'],
) {
  const { error } = await db
    .from('sales_document_lines')
    .insert(lines.map((l) => ({ ...l, document_id: documentId })));
  if (error) throw error;
}

export async function createSalesDocument(
  db: SupabaseClient,
  kind: Exclude<SalesKind, 'invoice'>,
  raw: SalesDocumentInput,
  opts: { userId: string; sourceId?: string | null; today?: string },
): Promise<SalesDocumentRow> {
  const input = await withClientDefaults(db, salesDocumentInputSchema.parse(raw));
  const today = opts.today ?? bogotaToday();
  const { computed, row } = docColumns(input, today);
  const number = await nextNumber(db, kind);
  const { data, error } = await db
    .from('sales_documents')
    .insert({
      ...row,
      kind,
      number,
      status: kind === 'quote' ? 'borrador' : 'pedido',
      source_id: opts.sourceId ?? null,
      valid_until:
        kind === 'quote'
          ? (input.validUntil ?? addDaysIso(row.issue_date, DEFAULT_VALID_DAYS))
          : null,
      due_date: input.dueDate ?? null,
      created_by: opts.userId,
      updated_by: opts.userId,
    })
    .select(DOC_COLUMNS)
    .single();
  if (error) throw error;
  const doc = adaptDoc(data as Record<string, unknown>);
  try {
    await insertLines(db, doc.id, computed.lines);
  } catch (err) {
    // Sin líneas el documento no sirve: se quita y el número queda como hueco.
    await db.from('sales_documents').delete().eq('id', doc.id);
    throw err;
  }
  await recordSalesEvent(db, doc.id, 'created', { userId: opts.userId });
  return doc;
}

export async function updateSalesDocument(
  db: SupabaseClient,
  id: string,
  raw: SalesDocumentInput,
  opts: { userId: string; today?: string },
): Promise<SalesDocumentRow> {
  const current = await getSalesDocumentRow(db, id);
  if (!current) throw new NotFoundError('Ese documento ya no existe.');
  if (!isEditable(current))
    throw new ValidationError(
      `${documentNumber(current)} ya no se puede editar (está ${current.status}). Crea uno nuevo si cambió el negocio.`,
    );
  const input = await withClientDefaults(db, salesDocumentInputSchema.parse(raw));
  const { computed, row } = docColumns(input, opts.today ?? bogotaToday());
  const { data, error } = await db
    .from('sales_documents')
    .update({
      ...row,
      valid_until: current.kind === 'quote' ? (input.validUntil ?? current.valid_until) : null,
      due_date: input.dueDate ?? current.due_date,
      updated_by: opts.userId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .select(DOC_COLUMNS)
    .single();
  if (error) throw error;
  const { error: delError } = await db.from('sales_document_lines').delete().eq('document_id', id);
  if (delError) throw delError;
  await insertLines(db, id, computed.lines);
  await recordSalesEvent(db, id, 'updated', { userId: opts.userId });
  return adaptDoc(data as Record<string, unknown>);
}

/** Cambia el estado sólo si sigue en uno de los esperados (nadie lo movió entretanto). */
export async function transitionStatus(
  db: SupabaseClient,
  id: string,
  from: string[],
  patch: Record<string, unknown> & { status: string },
): Promise<SalesDocumentRow | null> {
  const { data, error } = await db
    .from('sales_documents')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
    .in('status', from)
    .select(DOC_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  return data ? adaptDoc(data as Record<string, unknown>) : null;
}

/** El token del enlace público; se crea la primera vez y después se reusa. */
export async function ensureShareToken(db: SupabaseClient, doc: SalesDocumentRow): Promise<string> {
  if (doc.share_token) return doc.share_token;
  const token = randomBytes(24).toString('base64url');
  const { data, error } = await db
    .from('sales_documents')
    .update({ share_token: token })
    .eq('id', doc.id)
    .is('share_token', null)
    .select('share_token')
    .maybeSingle();
  if (error) throw error;
  if (data?.share_token) return data.share_token as string;
  // Otro lo creó entretanto: se usa el suyo.
  const again = await getSalesDocumentRow(db, doc.id);
  if (!again?.share_token) throw new Error('No se pudo crear el enlace de la cotización.');
  return again.share_token;
}

export async function markQuoteSent(
  db: SupabaseClient,
  doc: SalesDocumentRow,
  to: string,
  userId: string,
): Promise<void> {
  if (doc.status === 'borrador')
    await transitionStatus(db, doc.id, ['borrador'], {
      status: 'enviada',
      sent_at: new Date().toISOString(),
      sent_to: to.slice(0, 320),
      updated_by: userId,
    });
  else {
    const { error } = await db
      .from('sales_documents')
      .update({ sent_at: new Date().toISOString(), sent_to: to.slice(0, 320) })
      .eq('id', doc.id);
    if (error) throw error;
  }
  await recordSalesEvent(db, doc.id, 'sent', { userId, detail: `A ${to}` });
}

/**
 * La aceptación del cliente desde el enlace (o de alguien del equipo que la
 * recibió por otro lado). Sólo una cotización viva y sin vencer se acepta.
 */
export async function acceptQuote(
  db: SupabaseClient,
  doc: SalesDocumentRow,
  opts: { name: string; userId?: string | null; today?: string },
): Promise<SalesDocumentRow> {
  if (doc.kind !== 'quote') throw new ValidationError('Sólo una cotización se acepta.');
  if (doc.status === 'aceptada' || doc.status === 'pedido' || doc.status === 'facturada')
    return doc;
  const today = opts.today ?? bogotaToday();
  if (doc.valid_until && doc.valid_until < today)
    throw new ValidationError('Esta cotización ya venció. Pide una actualizada.');
  const next = await transitionStatus(db, doc.id, ['borrador', 'enviada'], {
    status: 'aceptada',
    accepted_at: new Date().toISOString(),
    accepted_by_name: opts.name.trim().slice(0, 200),
  });
  if (!next) throw new ValidationError('Esta cotización ya no se puede aceptar.');
  await recordSalesEvent(db, doc.id, 'accepted', {
    userId: opts.userId ?? null,
    actorLabel: opts.userId ? null : `${opts.name.trim().slice(0, 150)} (desde el enlace)`,
  });
  return next;
}

export async function rejectQuote(
  db: SupabaseClient,
  doc: SalesDocumentRow,
  opts: { reason?: string | null; name?: string | null; userId?: string | null },
): Promise<SalesDocumentRow> {
  const next = await transitionStatus(db, doc.id, ['borrador', 'enviada'], {
    status: 'rechazada',
    rejected_at: new Date().toISOString(),
    rejection_reason: opts.reason?.trim().slice(0, 1000) || null,
  });
  if (!next) throw new ValidationError('Esta cotización ya no se puede rechazar.');
  await recordSalesEvent(db, doc.id, 'rejected', {
    userId: opts.userId ?? null,
    actorLabel: opts.userId
      ? null
      : `${(opts.name ?? 'El cliente').slice(0, 150)} (desde el enlace)`,
    detail: opts.reason ?? null,
  });
  return next;
}

/** Lo que tiene un documento, como entrada para copiarlo a otro. */
export function inputFromDocument(
  doc: SalesDocumentRow,
  lines: SalesLineRow[],
): SalesDocumentInput {
  const w = withholdingsOf(doc);
  return {
    clientId: doc.client_id,
    clientName: doc.client_name,
    clientTaxId: doc.client_tax_id,
    clientEmail: doc.client_email,
    contactName: doc.contact_name,
    currency: doc.currency,
    paymentForm: doc.payment_form,
    paymentDays: doc.payment_days,
    notes: doc.notes,
    terms: doc.terms,
    withholdings: w,
    lines: lines.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unit_price,
      discountPct: l.discount_pct,
      taxRate: l.tax_rate,
      productRef: l.product_ref,
      productCode: l.product_code,
      unit: l.unit,
    })),
  };
}

/** Cotización aceptada → pedido. Si ya tenía pedido, devuelve ése. */
export async function convertQuoteToOrder(
  db: SupabaseClient,
  quoteId: string,
  userId: string,
): Promise<SalesDocumentRow> {
  const quote = await getSalesDocumentRow(db, quoteId);
  if (!quote || quote.kind !== 'quote') throw new NotFoundError('Esa cotización ya no existe.');
  const { data: existing, error: exError } = await db
    .from('sales_documents')
    .select(DOC_COLUMNS)
    .eq('source_id', quote.id)
    .eq('kind', 'order')
    .neq('status', 'anulada')
    .maybeSingle();
  if (exError) throw exError;
  if (existing) return adaptDoc(existing as Record<string, unknown>);
  if (quote.status !== 'aceptada' && quote.status !== 'enviada' && quote.status !== 'borrador')
    throw new ValidationError(
      `${documentNumber(quote)} está ${quote.status}: no se puede convertir en pedido.`,
    );
  const lines = await getSalesLines(db, quote.id);
  const order = await createSalesDocument(db, 'order', inputFromDocument(quote, lines), {
    userId,
    sourceId: quote.id,
  });
  await transitionStatus(db, quote.id, ['borrador', 'enviada', 'aceptada'], {
    status: 'pedido',
    updated_by: userId,
  });
  await recordSalesEvent(db, quote.id, 'converted', {
    userId,
    detail: `Pedido ${documentNumber(order)}`,
  });
  return order;
}

/**
 * La factura de un documento (cotización aceptada o pedido): la que ya existe
 * para ese origen, o una nueva en borrador con sus mismas líneas. Un índice
 * único (una factura viva por origen) impide dos a la vez.
 */
export async function prepareInvoice(
  db: SupabaseClient,
  source: SalesDocumentRow,
  userId: string,
): Promise<SalesDocumentRow> {
  if (source.kind === 'invoice') return source;
  const find = async () => {
    const { data, error } = await db
      .from('sales_documents')
      .select(DOC_COLUMNS)
      .eq('source_id', source.id)
      .eq('kind', 'invoice')
      .neq('status', 'anulada')
      .maybeSingle();
    if (error) throw error;
    return data ? adaptDoc(data as Record<string, unknown>) : null;
  };
  const existing = await find();
  if (existing) return existing;
  const lines = await getSalesLines(db, source.id);
  const input = salesDocumentInputSchema.parse(inputFromDocument(source, lines));
  const today = bogotaToday();
  const { computed, row } = docColumns(input, today);
  const number = await nextNumber(db, 'invoice');
  const { data, error } = await db
    .from('sales_documents')
    .insert({
      ...row,
      kind: 'invoice',
      number,
      status: 'borrador',
      source_id: source.id,
      due_date: row.payment_form === 'contado' ? today : addDaysIso(today, row.payment_days),
      created_by: userId,
      updated_by: userId,
    })
    .select(DOC_COLUMNS)
    .single();
  if (error) {
    // Otro la creó entretanto (el índice único): se usa ésa.
    if ((error as { code?: string }).code === '23505') {
      const raced = await find();
      if (raced) return raced;
    }
    throw error;
  }
  const invoice = adaptDoc(data as Record<string, unknown>);
  await insertLines(db, invoice.id, computed.lines);
  await recordSalesEvent(db, invoice.id, 'invoice_prepared', {
    userId,
    detail: `Desde ${documentNumber(source)}`,
  });
  return invoice;
}

export async function cancelSalesDocument(
  db: SupabaseClient,
  doc: SalesDocumentRow,
  userId: string,
): Promise<SalesDocumentRow> {
  if (doc.kind === 'invoice' && (doc.status === 'emitida' || doc.status === 'emitiendo'))
    throw new ValidationError(
      'Una factura electrónica emitida no se anula desde Cortex: se anula con una nota crédito en el programa contable.',
    );
  const next = await transitionStatus(
    db,
    doc.id,
    ['borrador', 'enviada', 'aceptada', 'rechazada', 'vencida', 'pedido', 'error'],
    { status: 'anulada', updated_by: userId },
  );
  if (!next) throw new ValidationError('Este documento ya no se puede anular.');
  await recordSalesEvent(db, doc.id, 'cancelled', { userId });
  return next;
}

/** Suma uno a las veces que el cliente abrió el enlace; la primera deja huella. */
export async function countQuoteView(db: SupabaseClient, doc: SalesDocumentRow): Promise<void> {
  const { error } = await db
    .from('sales_documents')
    .update({ share_views: doc.share_views + 1 })
    .eq('id', doc.id);
  if (error) throw error;
  if (doc.share_views === 0)
    await recordSalesEvent(db, doc.id, 'viewed', { actorLabel: 'El cliente, desde el enlace' });
}
