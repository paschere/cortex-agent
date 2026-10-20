import type { SupabaseClient } from '@supabase/supabase-js';
import { accountingTableSlug } from '../../accounting/tables';
import { listAccountingConnections } from '../../accounting/store';
import { type OpenInvoice, type OutboxKind, OUTBOX_KIND_LABEL, formatNitDigits } from '../../accounting/outbound/shape';
import { bogotaToday } from '../../commitments/shape';
import { orgAdmins } from '../../directory/store';
import { getTrackerBySlug, upsertRow } from '../../trackers/store';
import type { Values } from './match';
import type { TemplateContext } from './engine';
import {
  type CreditNoteAction,
  type CustomerAction,
  type ReceiptAction,
  buildCreditNoteDraft,
  buildCustomerDraft,
  buildReceiptDraft,
  describeOutbox,
  renderField,
  splitInvoiceList,
} from './outbox-build';
import { type InvoiceDraftRow, adaptDraftRow, INVOICE_DRAFT_COLUMNS, INVOICE_DRAFT_STATUS_LABEL } from './invoice-drafts';
import { relatedContext } from './invoice-draft-run';
import { writeBackValues } from './invoice-draft';
import type { AutomationAction } from './spec';

/**
 * LAS ACCIONES `accounting_upsert_customer`, `accounting_draft_receipt` Y
 * `accounting_draft_credit_note` DENTRO DE UNA CORRIDA (0232). Igual que la
 * prefactura: arman el borrador y lo dejan POR REVISAR en «Por enviar a Siigo».
 * Ninguna habla con Siigo para ESCRIBIR; sólo leen lo que Cortex ya sincronizó
 * (facturas con saldo, clientes) para armar el borrador sin red.
 *
 * Idempotentes: una fila + una regla + un tipo = UN borrador (llave única),
 * aunque la regla corra dos veces, se reintente o el borrador se descarte.
 */

export type OutboxAction = CustomerAction | ReceiptAction | CreditNoteAction;
export const OUTBOX_ACTION_KIND: Record<OutboxAction['type'], OutboxKind> = {
  accounting_upsert_customer: 'customer',
  accounting_draft_receipt: 'receipt',
  accounting_draft_credit_note: 'credit_note',
};

export function outboxDraftKey(kind: OutboxKind, automationId: string, rowId: string): string {
  return `outbox:${kind}:${automationId}:${rowId}`;
}

export interface OutboxRunInput {
  db: SupabaseClient;
  organizationId: string;
  app: { id: string; slug: string; name: string };
  automation: { id: string; created_by: string | null };
  runId: string;
  action: OutboxAction;
  ctx: TemplateContext;
  trackerRow: { id: string; slug: string; name: string } | null;
  rowId: string | null;
  baseUrl: string;
  now?: Date;
  notifyMembers: (
    db: SupabaseClient,
    userIds: string[],
    note: { appId: string; title: string; body?: string; href: string; dedupeKey: string },
  ) => Promise<number>;
  currentRowValues: () => Promise<Values | null>;
}

/** Qué programa conectado sabe escribir cada cosa (Siigo todo; Alegra, el cliente). */
const CAN: Record<string, Record<OutboxKind, boolean>> = {
  siigo: { invoice: true, receipt: true, credit_note: true, customer: true },
  alegra: { invoice: true, receipt: false, credit_note: false, customer: true },
  quickbooks: { invoice: false, receipt: false, credit_note: false, customer: false },
};

export async function pickOutboundProvider(
  db: SupabaseClient,
  kind: OutboxKind,
): Promise<{ provider: string; name: string } | { error: string }> {
  const conns = (await listAccountingConnections(db)).filter((c) => c.enabled);
  const hit = conns.find((c) => CAN[c.provider]?.[kind]);
  if (hit) return { provider: hit.provider, name: hit.provider === 'siigo' ? 'Siigo' : hit.provider };
  return {
    error: conns.length
      ? `Ninguno de los programas conectados (${conns.map((c) => c.provider).join(', ')}) sabe crear ${OUTBOX_KIND_LABEL[kind].toLowerCase()} desde Cortex todavía.`
      : 'No hay un programa contable conectado: un administrador conecta Siigo en Integraciones → Programas contables.',
  };
}

async function openInvoices(
  db: SupabaseClient,
  provider: string,
  digits: string,
  requested: readonly string[],
): Promise<OpenInvoice[]> {
  let q = db
    .from('accounting_invoices')
    .select('source_ref, doc_number, balance, due_on, issued_on, client_nit, annulled')
    .eq('source_system', provider)
    .eq('annulled', false)
    .gt('balance', 0)
    .limit(200);
  q = requested.length ? q.in('doc_number', [...requested]) : q.eq('client_nit', digits);
  const { data, error } = await q;
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    number: String(r.doc_number),
    externalId: String(r.source_ref ?? ''),
    balance: Number(r.balance) || 0,
    dueOn: (r.due_on as string | null) ?? null,
    issuedOn: (r.issued_on as string | null) ?? null,
  }));
}

async function customerKnown(db: SupabaseClient, provider: string, digits: string): Promise<boolean> {
  try {
    const tracker = await getTrackerBySlug(db, accountingTableSlug(provider, 'customers'));
    if (!tracker) return false;
    const { data, error } = await db
      .from('tracker_rows')
      .select('id, values')
      .eq('tracker_id', tracker.id)
      .like('values->>nit', `${digits}%`)
      .limit(5);
    if (error) return false;
    return ((data ?? []) as Array<{ values: Record<string, unknown> }>).some(
      (r) => String(r.values?.nit ?? '').replace(/\D/g, '').startsWith(digits),
    );
  } catch {
    return false;
  }
}

export interface BuiltOutbox {
  kind: OutboxKind;
  provider: string;
  providerName: string;
  payload: Record<string, unknown>;
  problems: string[];
  customerTax: string | null;
  customerName: string;
  total: number;
  summary: string;
}

/** Arma el contenido del borrador (lee sólo lo ya sincronizado). Devuelve `{skip}` si no hace falta. */
export async function buildOutbox(
  db: SupabaseClient,
  action: OutboxAction,
  ctx: TemplateContext,
  customerCtx: TemplateContext | undefined,
  today: string,
): Promise<BuiltOutbox | { skip: string }> {
  const kind = OUTBOX_ACTION_KIND[action.type];
  const picked = await pickOutboundProvider(db, kind);
  if ('error' in picked) throw new Error(picked.error);
  let payload: Record<string, unknown>;
  let problems: string[] = [];
  let customerTax: string | null = null;
  let customerName = '';
  let total = 0;
  let summary = '';
  if (action.type === 'accounting_upsert_customer') {
    const built = buildCustomerDraft({ action, ctx, customerCtx });
    if (!built.ok) throw new Error(`No se armó el cliente: ${built.reason}`);
    if (await customerKnown(db, picked.provider, built.payload.taxId))
      return { skip: `${built.payload.name || `NIT ${built.payload.taxId}`} ya está en ${picked.name}: no se creó otro.` };
    payload = built.payload as unknown as Record<string, unknown>;
    problems = built.problems;
    customerTax = built.payload.taxId;
    customerName = built.payload.name;
    summary = describeOutbox('customer', payload);
  } else if (action.type === 'accounting_draft_receipt') {
    const requested = action.invoices ? splitInvoiceList(renderList(action.invoices, ctx)) : [];
    const taxProbe = buildCustomerNit(action, ctx, customerCtx);
    if (typeof taxProbe !== 'string') throw new Error(`No se armó el recibo: ${taxProbe.error}`);
    const open = await openInvoices(db, picked.provider, taxProbe, requested);
    const built = buildReceiptDraft({ action, ctx, customerCtx, today, open, requested });
    if (!built.ok) throw new Error(`No se armó el recibo: ${built.reason}`);
    payload = built.payload as unknown as Record<string, unknown>;
    problems = built.problems;
    customerTax = built.payload.customerTaxId;
    customerName = built.payload.customerName;
    total = built.payload.amount;
    summary = describeOutbox('receipt', payload);
  } else {
    const number = splitInvoiceList(renderList(action.invoice, ctx))[0] ?? '';
    let invoice: { externalId: string; customerTaxId: string | null } | null = null;
    if (number) {
      const { data } = await db
        .from('accounting_invoices')
        .select('source_ref, client_nit, counterparty_name, total')
        .eq('source_system', picked.provider)
        .eq('doc_number', number)
        .limit(1);
      const r = (data ?? [])[0] as Record<string, unknown> | undefined;
      if (r) {
        invoice = { externalId: String(r.source_ref ?? ''), customerTaxId: (r.client_nit as string | null) ?? null };
        customerName = String(r.counterparty_name ?? '');
        total = Number(r.total) || 0;
      }
    }
    const built = buildCreditNoteDraft({ action, ctx, today, invoice });
    if (!built.ok) throw new Error(`No se armó la nota crédito: ${built.reason}`);
    payload = built.payload as unknown as Record<string, unknown>;
    problems = built.problems;
    customerTax = built.payload.customerTaxId;
    if (!invoice) problems = [...problems, `La factura ${number} todavía no está en las tablas de Cortex (¿falta sincronizar?): Siigo la busca por su número al aprobar.`];
    summary = describeOutbox('credit_note', payload);
  }

  return { kind, provider: picked.provider, providerName: picked.name, payload, problems, customerTax, customerName, total, summary };
}

export async function runOutboxAction(a: OutboxRunInput): Promise<string> {
  const { db, action, ctx } = a;
  const kind = OUTBOX_ACTION_KIND[action.type];
  if (!a.rowId || !a.trackerRow) throw new Error(`Sin fila de donde armar ${OUTBOX_KIND_LABEL[kind].toLowerCase()}.`);
  const key = outboxDraftKey(kind, a.automation.id, a.rowId);

  const { data: existing, error: existingError } = await db
    .from('app_invoice_drafts')
    .select('id, status, provider_number')
    .eq('idempotency_key', key)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing) {
    const e = existing as { status: InvoiceDraftRow['status']; provider_number: string | null };
    return `Ya existía un borrador de ${OUTBOX_KIND_LABEL[kind].toLowerCase()} de esta fila (${INVOICE_DRAFT_STATUS_LABEL[e.status].toLowerCase()}${e.provider_number ? `, ${e.provider_number}` : ''}): no se armó otro.`;
  }
  const today = bogotaToday(a.now ?? new Date());
  const viaKey = 'customer' in action ? action.customer.via : (action as CustomerAction).via;
  let customerCtx: TemplateContext | undefined;
  if (viaKey) {
    const rel = await relatedContext(db, viaKey, ctx);
    if ('error' in rel) throw new Error(rel.error);
    customerCtx = rel.ctx;
  }
  const built = await buildOutbox(db, action, ctx, customerCtx, today);
  if ('skip' in built) return built.skip;
  const { payload, problems, customerTax, customerName, total, summary } = built;
  const picked = { provider: built.provider, name: built.providerName };

  const { data: inserted, error } = await db
    .from('app_invoice_drafts')
    .upsert(
      {
        organization_id: a.organizationId,
        app_id: a.app.id,
        automation_id: a.automation.id,
        run_id: a.runId,
        tracker_id: a.trackerRow.id,
        row_id: a.rowId,
        row_label: (ctx.label ?? '').slice(0, 200),
        idempotency_key: key,
        kind,
        payload,
        lines: [],
        customer_tax_id: customerTax,
        customer_name: customerName,
        currency: 'COP',
        observations: '',
        choices: 'paymentTypeId' in action && action.paymentTypeId ? { paymentTypeId: action.paymentTypeId } : {},
        write_back: action.writeBack ?? {},
        provider: picked.provider,
        total,
      },
      { onConflict: 'idempotency_key', ignoreDuplicates: true },
    )
    .select(INVOICE_DRAFT_COLUMNS);
  if (error) throw error;
  const row = (inserted ?? [])[0] as Record<string, unknown> | undefined;
  if (!row) return `Ya existía un borrador de ${OUTBOX_KIND_LABEL[kind].toLowerCase()} de esta fila: no se armó otro.`;
  const draft = adaptDraftRow(row);

  let warning = '';
  const pending = writeBackValues(action.writeBack, 'pending');
  if (Object.keys(pending).length) {
    try {
      const values = await a.currentRowValues();
      const tracker = await getTrackerBySlug(db, a.trackerRow.slug);
      if (tracker && values)
        await upsertRow(db, {
          tracker,
          rowId: a.rowId,
          values: { ...values, ...pending },
          userId: a.automation.created_by,
          lenient: true,
          only: new Set(Object.keys(pending)),
        });
    } catch (err) {
      warning = ` (no se pudo marcar la fila: ${err instanceof Error ? err.message : 'error'})`;
    }
  }

  let belled = 0;
  try {
    const ids = new Set<string>();
    if (action.notifyAdmins) for (const id of await orgAdmins(db, 20)) ids.add(id);
    if (action.notifyRoles.length) {
      const { data } = await db
        .from('custom_app_members')
        .select('user_id')
        .eq('app_id', a.app.id)
        .in('role_key', action.notifyRoles);
      for (const m of (data ?? []) as Array<{ user_id: string }>) ids.add(m.user_id);
    }
    if (ids.size)
      belled = await a.notifyMembers(db, [...ids], {
        appId: a.app.id,
        title: `${OUTBOX_KIND_LABEL[kind]} por revisar: ${customerName || (customerTax ? `NIT ${customerTax}` : (ctx.label ?? ''))}`,
        body: `${summary}. Nada se ha enviado a ${picked.name}.`,
        href: `${a.baseUrl}/prefacturas?abrir=${draft.id}`,
        dedupeKey: `outbox:${draft.id}`,
      });
  } catch {
    // El aviso es un extra: el borrador ya está en la bandeja.
  }
  return `${summary}: por revisar${problems.length ? ` (falta: ${problems.slice(0, 2).join(' ')})` : ''}. Nada se envió a ${picked.name}; falta la aprobación de una persona${belled ? ` (aviso a ${belled})` : ''}.${warning}`;
}

const renderList = renderField;

function buildCustomerNit(
  action: ReceiptAction,
  ctx: TemplateContext,
  customerCtx?: TemplateContext,
): string | { error: string } {
  const c = customerCtx ?? ctx;
  const raw = renderField(action.customer.taxId, c);
  const digits = formatNitDigits(raw);
  return digits ? digits : { error: 'El NIT del cliente está vacío en la fila.' };
}

export type { AutomationAction };
