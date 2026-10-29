import { ambientTrm } from '../../trackers/trm';
import { ensureTrm } from '../../trackers/trm-store';
import { formatMoney } from '../../format/display';
import type { SupabaseClient } from '@supabase/supabase-js';
import { orgAdmins } from '../../directory/store';
import { getTrackerBySlug, upsertRow } from '../../trackers/store';
import { relationParts } from '../../trackers/computed';
import type { Values } from './match';
import { type TemplateContext, renderTemplate } from './engine';
import { loadListPrices } from '../../accounting/price-lists';
import { buildInvoiceDraft, invoiceDraftKey, writeBackValues } from './invoice-draft';
import type { EmissionDeps } from '../../sales/emit';
import {
  approveInvoiceDraft,
  createInvoiceDraft,
  INVOICE_DRAFT_STATUS_LABEL,
  type InvoiceDraftRow,
} from './invoice-drafts';
import { type RuleAttribution, recordRuleChange } from './related';
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
  /** Quién causó el suceso (con `siigo_sin_dian`, quien aprobó es la persona que firma la factura). */
  actor?: { kind: string; id?: string | null };
  /** Nombre de la regla y motivo, para dejar rastro en el Historial de la fila. */
  rule?: RuleAttribution;
  emission?: EmissionDeps;
  enqueueJob?: (name: string, data: Record<string, unknown>) => Promise<boolean>;
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
  if (existing && action.send === 'siigo_sin_dian') {
    const e = existing as { id: string; status: InvoiceDraftRow['status']; provider_number: string | null };
    // Un intento anterior que falló (o quedó por revisar) se reintenta con el MISMO pedido y la misma llave.
    if (e.status === 'error' || e.status === 'pending') return sendWithoutDian(a, e.id);
    if (e.status === 'created') return `Ya existía la factura de esta fila en Siigo (${e.provider_number ?? 'creada'}): no se creó otra.`;
    return `Ya existía una prefactura de esta fila (${INVOICE_DRAFT_STATUS_LABEL[e.status].toLowerCase()}): no se creó otra factura.`;
  }
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
  const wantsLists = action.items.some((i) => i.priceList && i.productCode);
  const listPrice = wantsLists
    ? await loadListPrices(
        db,
        action.items
          .filter((i) => i.priceList && i.productCode)
          .map((i) => renderTemplate(i.productCode as string, ctx)),
      )
    : undefined;
  if (typeof action.trm === 'string' && /^\s*oficial/i.test(action.trm)) await ensureTrm(db);
  const built = buildInvoiceDraft({
    customer: action.customer,
    items: action.items,
    currency: action.currency,
    trm: action.trm,
    trmTable: typeof action.trm === 'string' && /^\s*oficial/i.test(action.trm) ? ambientTrm() : undefined,
    observations: action.observations,
    paymentForm: action.paymentForm,
    paymentDays: action.paymentDays,
    ctx,
    customerCtx,
    listPrice,
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

  if (action.send === 'siigo_sin_dian') return sendWithoutDian(a, draft.id);

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

/** Quién recibe el aviso: administradores, roles de la app y (opcional) quien causó el cambio. */
async function recipients(a: InvoiceDraftRunInput): Promise<string[]> {
  const { db, action } = a;
  const ids = new Set<string>();
  try {
    if (action.notifyAdmins) for (const id of await orgAdmins(db, 20)) ids.add(id);
    if (action.notifyRoles.length) {
      const { data } = await db
        .from('custom_app_members')
        .select('user_id')
        .eq('app_id', a.app.id)
        .in('role_key', action.notifyRoles);
      for (const m of (data ?? []) as Array<{ user_id: string }>) ids.add(m.user_id);
    }
  } catch {
    // El aviso es un extra.
  }
  if (action.notifyActor && a.actor?.kind === 'member' && a.actor.id) ids.add(a.actor.id);
  return [...ids];
}

/** Cambios que NO se pueden deshacer desde Cortex (la factura ya existe en Siigo): sin `from`. */
async function traceExternal(
  a: InvoiceDraftRunInput,
  values: Record<string, string>,
  reason: string,
): Promise<void> {
  if (!a.rowId || !Object.keys(values).length) return;
  await recordRuleChange(a.db, {
    rowId: a.rowId,
    changes: Object.entries(values).map(([field, to]) => ({ field, from: undefined, to })),
    rule: { name: a.rule?.name ?? 'Regla', reason },
  });
}

async function writeState(
  a: InvoiceDraftRunInput,
  values: Record<string, string>,
): Promise<string> {
  if (!Object.keys(values).length || !a.trackerRow || !a.rowId) return '';
  try {
    const current = await a.currentRowValues();
    const tracker = await getTrackerBySlug(a.db, a.trackerRow.slug);
    if (tracker && current)
      await upsertRow(a.db, {
        tracker,
        rowId: a.rowId,
        values: { ...current, ...values },
        userId: a.automation.created_by,
        lenient: true,
        only: new Set(Object.keys(values)),
      });
    return '';
  } catch (err) {
    return ` (no se pudo marcar la fila: ${err instanceof Error ? err.message : 'error'})`;
  }
}

/**
 * `send: 'siigo_sin_dian'`: la regla crea la factura en Siigo (sin enviarla a la DIAN) con el
 * mismo camino que la aprobación de la bandeja. Aprueba quien causó el cambio (o el dueño de
 * la regla si fue un horario). Falla con motivo: la fila queda en el estado de error y la
 * corrida termina fallida; reintentar es volver a disparar la regla (misma llave: no duplica).
 */
async function sendWithoutDian(a: InvoiceDraftRunInput, draftId: string): Promise<string> {
  const { db } = a;
  const userId = (a.actor?.kind === 'member' && a.actor.id) || a.automation.created_by;
  if (!userId) throw new Error('No hay quién firme la factura: la regla no tiene dueño.');
  const who = a.actor?.kind === 'member' && a.actor.id ? 'quien aprobó' : 'el dueño de la regla';
  try {
    const out = await approveInvoiceDraft(
      { db, organizationId: a.organizationId, userId, enqueueJob: a.enqueueJob },
      draftId,
      { sendToDian: false, ...(a.emission ?? {}) },
    );
    const d = out.draft;
    const number = d.provider_number ?? d.provider_invoice_id ?? '';
    const cleared = writeBackValues(a.action.writeBack, 'created', number);
    await traceExternal(
      a,
      cleared,
      `Se creó la factura ${number} en Siigo SIN enviar a la DIAN (la firmó ${who}). Es un hecho externo: no se deshace desde Cortex; si hay que anularla, se hace en Siigo con nota crédito.`,
    );
    const ids = await recipients(a);
    let belled = 0;
    if (ids.length)
      try {
        belled = await a.notifyMembers(db, ids, {
          appId: a.app.id,
          title: `Factura ${number} creada en Siigo: ${d.customer_name || `NIT ${d.customer_tax_id}`}`,
          body: `${a.ctx.label ?? 'Una fila'}: ${formatMoney(d.total)} con IVA. Quedó SIN enviar a la DIAN; el contador la revisa y la timbra en Siigo.`,
          href: inboxHref(a.baseUrl, d.id),
          dedupeKey: `invsent:${d.id}`,
        });
      } catch {
        // El aviso es un extra.
      }
    return `Factura ${number} creada en Siigo para ${d.customer_name || `NIT ${d.customer_tax_id}`} (${formatMoney(d.total)}), SIN enviar a la DIAN${belled ? `; aviso a ${belled}` : ''}.${out.warnings.length ? ` Ojo: ${out.warnings.join(' ')}` : ''}`;
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'error desconocido';
    const failed = writeBackValues(a.action.writeBack, 'error', null, reason);
    const warn = await writeState(a, failed);
    await traceExternal(a, failed, `Siigo no aceptó la factura: ${reason}`);
    const ids = await recipients(a);
    if (ids.length)
      try {
        await a.notifyMembers(db, ids, {
          appId: a.app.id,
          title: `No se pudo enviar a Siigo: ${a.ctx.label ?? 'una fila'}`,
          body: reason.slice(0, 300),
          href: inboxHref(a.baseUrl, draftId),
          dedupeKey: `invfail:${draftId}:${Date.now()}`,
        });
      } catch {
        // El aviso es un extra.
      }
    throw new Error(`Siigo no aceptó la factura: ${reason}${warn}`);
  }
}
