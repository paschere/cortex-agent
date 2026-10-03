'use server';

import type { GridView } from '@/components/datagrid/types';
import { buildToolContext } from '@/lib/agent';
import { deleteGridView, saveGridView } from '@/lib/datagrid/views-store';
import type {
  ClientOption,
  InvoicePreviewView,
  ProductOption,
  SalesActionResult,
  SalesEditorInput,
} from '@/lib/sales/types';
import { previewView } from '@/lib/sales/view';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  acceptSalesQuote,
  cancelSalesDocument,
  convertSalesQuoteToOrder,
  createSalesDocument,
  ensureSalesShareToken,
  getClient,
  getSalesDocumentRow,
  listContacts,
  listSellableProducts,
  previewSalesInvoice,
  rejectSalesQuote,
  runTool,
  salesDocumentInputSchema,
  salesInvoiceEmit,
  salesQuotePublicUrl,
  salesQuoteSend,
  searchClients,
  toolErrorMessage,
  updateSalesDocument,
} from '@cortex/agent-tools';
import type { UUID } from '@cortex/core';
import { revalidatePath } from 'next/cache';

/**
 * LO QUE SE HACE DESDE /ventas (migración 0182).
 *
 * Guardar, aceptar a mano, convertir y anular son escrituras internas de una
 * persona con sesión: van directo al módulo. Lo que SALE de la empresa —mandar
 * la cotización por correo y emitir la factura electrónica— pasa por las
 * mismas herramientas que usa el chat (`runTool`), con la misma validación,
 * la misma idempotencia y la misma fila de auditoría a nombre de quien pulsó.
 * El diálogo de confirmación de la pantalla ES la aprobación (`confirmed`).
 */

const PATH = '/ventas';

async function session() {
  const user = await requireSession();
  return { user, db: getOrgScopedClient(user.organization.id) };
}

async function cortexContext(userId: UUID, organizationId: string) {
  const db = getOrgScopedClient(organizationId);
  const { data } = await db.from('agents').select('id').eq('slug', 'cortex').maybeSingle();
  if (!data?.id) return null;
  return buildToolContext({ userId, agentId: data.id as UUID, organizationId });
}

const NO_AGENT = 'Cortex todavía no está configurado en este espacio de trabajo.';

function fail(err: unknown): SalesActionResult<never> {
  return { ok: false, error: toolErrorMessage(err) };
}

export async function saveSalesDocumentAction(
  id: string | null,
  kind: 'quote' | 'order',
  input: SalesEditorInput,
): Promise<SalesActionResult<{ id: string }>> {
  try {
    const { user, db } = await session();
    const parsed = salesDocumentInputSchema.safeParse({
      ...input,
      clientEmail: input.clientEmail || null,
      lines: input.lines.filter((l) => l.description.trim()),
    });
    if (!parsed.success)
      return {
        ok: false,
        error: parsed.error.issues.some((i) => i.path[0] === 'lines')
          ? 'Revisa las líneas: cada una necesita descripción, cantidad mayor que cero y precio.'
          : parsed.error.issues.some((i) => i.path[0] === 'clientEmail')
            ? 'El correo del cliente no parece válido.'
            : 'Falta el cliente o hay un dato que no cuadra.',
      };
    const doc = id
      ? await updateSalesDocument(db, id, parsed.data, { userId: user.id })
      : await createSalesDocument(db, kind, parsed.data, { userId: user.id });
    revalidatePath(PATH);
    return { ok: true, data: { id: doc.id } };
  } catch (err) {
    return fail(err);
  }
}

export async function quoteLinkAction(id: string): Promise<SalesActionResult<{ url: string }>> {
  try {
    const { db } = await session();
    const doc = await getSalesDocumentRow(db, id);
    if (!doc || doc.kind !== 'quote') return { ok: false, error: 'Esa cotización ya no existe.' };
    const token = await ensureSalesShareToken(db, doc);
    revalidatePath(`${PATH}/${id}`);
    return { ok: true, data: { url: salesQuotePublicUrl(token) } };
  } catch (err) {
    return fail(err);
  }
}

export async function sendQuoteAction(
  id: string,
  to: string[],
  message: string | null,
): Promise<SalesActionResult> {
  try {
    const { user } = await session();
    const ctx = await cortexContext(user.id, user.organization.id);
    if (!ctx) return { ok: false, error: NO_AGENT };
    const out = await runTool(
      salesQuoteSend,
      { quote: id, ...(to.length ? { to } : {}), ...(message?.trim() ? { message } : {}) },
      ctx,
      { confirmed: true },
    );
    revalidatePath(`${PATH}/${id}`);
    return { ok: true, note: out.markdown.replace(/\*\*/g, '') };
  } catch (err) {
    return fail(err);
  }
}

export async function acceptQuoteAction(id: string, name: string): Promise<SalesActionResult> {
  try {
    const { user, db } = await session();
    const doc = await getSalesDocumentRow(db, id);
    if (!doc) return { ok: false, error: 'Esa cotización ya no existe.' };
    await acceptSalesQuote(db, doc, { name: name.trim() || doc.client_name, userId: user.id });
    revalidatePath(`${PATH}/${id}`);
    return { ok: true, note: 'Anotada como aceptada.' };
  } catch (err) {
    return fail(err);
  }
}

export async function rejectQuoteAction(id: string, reason: string): Promise<SalesActionResult> {
  try {
    const { user, db } = await session();
    const doc = await getSalesDocumentRow(db, id);
    if (!doc) return { ok: false, error: 'Esa cotización ya no existe.' };
    await rejectSalesQuote(db, doc, { reason, userId: user.id });
    revalidatePath(`${PATH}/${id}`);
    return { ok: true, note: 'Anotada como rechazada.' };
  } catch (err) {
    return fail(err);
  }
}

export async function convertToOrderAction(id: string): Promise<SalesActionResult<{ id: string }>> {
  try {
    const { user, db } = await session();
    const order = await convertSalesQuoteToOrder(db, id, user.id);
    revalidatePath(PATH);
    return { ok: true, data: { id: order.id } };
  } catch (err) {
    return fail(err);
  }
}

export async function cancelSalesDocumentAction(id: string): Promise<SalesActionResult> {
  try {
    const { user, db } = await session();
    const doc = await getSalesDocumentRow(db, id);
    if (!doc) return { ok: false, error: 'Ese documento ya no existe.' };
    await cancelSalesDocument(db, doc, user.id);
    revalidatePath(PATH);
    return { ok: true, note: 'Anulado.' };
  } catch (err) {
    return fail(err);
  }
}

export async function previewInvoiceAction(
  id: string,
): Promise<SalesActionResult<InvoicePreviewView>> {
  try {
    const { db } = await session();
    return { ok: true, data: previewView(await previewSalesInvoice(db, id)) };
  } catch (err) {
    return fail(err);
  }
}

export async function emitInvoiceAction(
  id: string,
  retryUncertain = false,
): Promise<SalesActionResult<{ invoiceId: string }>> {
  try {
    const { user } = await session();
    const ctx = await cortexContext(user.id, user.organization.id);
    if (!ctx) return { ok: false, error: NO_AGENT };
    const out = await runTool(
      salesInvoiceEmit,
      { document: id, ...(retryUncertain ? { retryUncertain: true } : {}) },
      ctx,
      { confirmed: true },
    );
    revalidatePath(PATH);
    return {
      ok: true,
      note: out.markdown.replace(/\*\*/g, ''),
      data: { invoiceId: out.invoiceId },
    };
  } catch (err) {
    revalidatePath(PATH);
    return fail(err);
  }
}

export async function searchClientsAction(query: string): Promise<ClientOption[]> {
  const { db } = await session();
  if (query.trim().length < 2) return [];
  const hits = await searchClients(db, query, 8).catch(() => []);
  return hits.map((h) => ({
    id: h.client.id,
    name: h.client.name,
    nit: h.client.tax_id,
    email: null,
    contact: null,
    paymentDays: h.client.payment_terms_days,
  }));
}

/** El correo y el contacto principal de un cliente, para llenar el editor. */
export async function clientDefaultsAction(id: string): Promise<ClientOption | null> {
  const { db } = await session();
  const client = await getClient(db, id).catch(() => null);
  if (!client) return null;
  const contacts = await listContacts(db, id).catch(() => []);
  const primary =
    contacts.find((c) => c.is_primary && c.email && c.status !== 'left') ??
    contacts.find((c) => c.email && c.status !== 'left');
  return {
    id: client.id,
    name: client.name,
    nit: client.tax_id,
    email: primary?.email ?? null,
    contact: primary?.full_name ?? null,
    paymentDays: client.payment_terms_days,
  };
}

export async function searchProductsAction(query: string): Promise<ProductOption[]> {
  const { db } = await session();
  const products = await listSellableProducts(db, { query, limit: 12 }).catch(() => []);
  return products.map((p) => ({
    ref: p.ref,
    code: p.code,
    name: p.name,
    price: p.price,
    unit: p.unit,
    provider: p.provider,
  }));
}

export async function saveSalesView(view: GridView): Promise<GridView> {
  return saveGridView('sales', view);
}

export async function deleteSalesView(id: string): Promise<void> {
  return deleteGridView(id);
}
