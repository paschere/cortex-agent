import { formatMoney } from '../../format/display';
import type { SupabaseClient } from '@supabase/supabase-js';
import { orgAdmins } from '../../directory/store';
import { getTrackerBySlug, upsertRow } from '../../trackers/store';
import { relationParts } from '../../trackers/computed';
import type { Values } from './match';
import { type TemplateContext } from './engine';
import { buildInvoiceDraft, invoiceDraftKey, writeBackValues } from './invoice-draft';
import { createInvoiceDraft, INVOICE_DRAFT_STATUS_LABEL, type InvoiceDraftRow } from './invoice-drafts';
import type { AutomationAction } from './spec';

/**
 * LA ACCIÓN `accounting_draft_invoice` DENTRO DE UNA CORRIDA: arma la
 * prefactura de la fila y la deja POR REVISAR. No habla con Siigo: lo único
 * que escribe es la prefactura (y, si la regla lo pide, el estado de la fila).
 * Crear la factura en Siigo es de la bandeja, con una persona aprobando.
 *
 * Idempotente: una fila + una regla = UNA prefactura (llave única en la base),
 * aunque la regla corra dos veces, se reintente o la prefactura se descarte.
 */

type DraftAction = Extract<AutomationAction, { type: 'accounting_draft_invoice' }>;

export interface InvoiceDraftRunInput {
  db: SupabaseClient;
  organizationId: string;
  app: { id: string; slug: string; name: string };
  automation: { id: string; created_by: string | null };
  runId: string;
  runKey: string;
  action: DraftAction;
  ctx: TemplateContext;
  trackerRow: { id: string; slug: string; name: string } | null;
  rowId: string | null;
  baseUrl: string;
  notifyMembers: (
    db: SupabaseClient,
    userIds: string[],
    note: { appId: string; title: string; body?: string; href: string; dedupeKey: string },
  ) => Promise<number>;
  /** La fila completa de la tabla (para escribir el estado «pendiente» sin pisar nada). */
  currentRowValues: () => Promise<Values | null>;
}

export async function relatedContext(
  db: SupabaseClient,
  via: string,
  ctx: TemplateContext,
): Promise<{ ctx: TemplateContext } | { error: string }> {
  const rel = relationParts(ctx.after[via] as string | undefined);
  if (!rel?.id) return { error: `La fila no apunta a nada por «${via}»: no hay de dónde sacar el cliente.` };
  const { data, error } = await db
    .from('tracker_rows')
    .select('id, label, values, tracker_id')
    .eq('id', rel.id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { error: `La fila relacionada por «${via}» ya no existe.` };
  const row = data as { label: string; values: Values; tracker_id: string };
  const { data: t } = await db.from('trackers').select('fields').eq('id', row.tracker_id).maybeSingle();
  const fields = ((t as { fields?: Array<{ key: string; label: string }> } | null)?.fields ?? []) as Array<{
    key: string;
    label: string;
  }>;
  return {
    ctx: {
      ...ctx,
      after: row.values ?? {},
      before: null,
      label: row.label,
      labels: Object.fromEntries(fields.map((f) => [f.key, f.label])),
    },
  };
}

export function inboxHref(baseUrl: string, id?: string): string {
  return `${baseUrl}/prefacturas${id ? `?abrir=${id}` : ''}`;
}

export async function runDraftInvoiceAction(a: InvoiceDraftRunInput): Promise<string> {
  const { db, action, ctx } = a;
  if (!a.rowId || !a.trackerRow) throw new Error('Sin fila de donde armar la prefactura.');
  const key = invoiceDraftKey(a.automation.id, a.rowId);

  // ¿Ya existe? Entonces no se arma de nuevo: ni aunque la fila haya cambiado.
  const { data: existing, error: existingError } = await db
    .from('app_invoice_drafts')
    .select('id, status, provider_number')
    .eq('idempotency_key', key)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing) {
    const e = existing as { status: InvoiceDraftRow['status']; provider_number: string | null };
    return `Ya existía una prefactura de esta fila (${INVOICE_DRAFT_STATUS_LABEL[e.status].toLowerCase()}${e.provider_number ? `, factura ${e.provider_number}` : ''}): no se armó otra.`;
  }

  let customerCtx: TemplateContext | undefined;
  if (action.customer.via) {
    const rel = await relatedContext(db, action.customer.via, ctx);
    if ('error' in rel) throw new Error(rel.error);
    customerCtx = rel.ctx;
  }
  const built = buildInvoiceDraft({
    customer: action.customer,
    items: action.items,
    currency: action.currency,
    trm: action.trm,
    observations: action.observations,
    paymentForm: action.paymentForm,
    paymentDays: action.paymentDays,
    ctx,
    customerCtx,
  });
  if (!built.ok) throw new Error(`No se armó la prefactura: ${built.reason}`);

  const { draft, created } = await createInvoiceDraft(db, {
    organizationId: a.organizationId,
    appId: a.app.id,
    automationId: a.automation.id,
    runId: a.runId,
    trackerId: a.trackerRow.id,
    rowId: a.rowId,
    rowLabel: ctx.label ?? '',
    idempotencyKey: key,
    draft: built.draft,
    choices: {
      documentTypeId: action.documentTypeId,
      sellerId: action.sellerId,
      paymentTypeId: action.paymentTypeId,
    },
    writeBack: action.writeBack,
  });
  if (!created)
    return `Ya existía una prefactura de esta fila (${INVOICE_DRAFT_STATUS_LABEL[draft.status].toLowerCase()}): no se armó otra.`;

  // Estado «pendiente» en la fila (si la regla lo pide); un fallo aquí no deshace la prefactura.
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

  // Aviso de que hay algo por revisar.
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
        title: `Prefactura por revisar: ${built.draft.customerName || `NIT ${built.draft.customerTaxId}`}`,
        body: `${ctx.label ?? 'Una fila'} cerró y la prefactura quedó lista para tu revisión. Nada se ha enviado a Siigo.`,
        href: inboxHref(a.baseUrl, draft.id),
        dedupeKey: `invdraft:${draft.id}`,
      });
  } catch {
    // El aviso es un extra: la prefactura ya está en la bandeja.
  }
  const total = formatMoney(built.draft.total);
  return `Prefactura por revisar para ${built.draft.customerName || `NIT ${built.draft.customerTaxId}`}: ${built.draft.lines.length} línea${built.draft.lines.length === 1 ? '' : 's'}, ${total} con IVA (estimado)${built.draft.skipped.length ? `; sin ${built.draft.skipped.join(' ')}` : ''}. Nada se envió a Siigo; falta la aprobación de una persona${belled ? ` (aviso a ${belled})` : ''}.${warning}`;
}
