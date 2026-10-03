import { SalesDetail } from '@/components/sales/SalesDetail';
import { loadSessionBrand } from '@/lib/branding/store';
import { loadTeam } from '@/lib/clients/read';
import { detailView } from '@/lib/sales/view';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { bogotaToday, getSalesDocument, salesQuotePublicUrl } from '@cortex/agent-tools';
import { notFound } from 'next/navigation';
import {
  acceptQuoteAction,
  cancelSalesDocumentAction,
  convertToOrderAction,
  emitInvoiceAction,
  previewInvoiceAction,
  quoteLinkAction,
  rejectQuoteAction,
  sendQuoteAction,
} from '../actions';

/** La ficha de una cotización, un pedido o una factura (0182). */

export const dynamic = 'force-dynamic';

export default async function SalesDocumentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, q] = await Promise.all([params, searchParams]);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const [detail, team, brand] = await Promise.all([
    getSalesDocument(db, id),
    loadTeam(db).catch(() => []),
    loadSessionBrand(db, user.organization.name),
  ]);
  if (!detail) notFound();
  const view = detailView(detail, {
    today: bogotaToday(),
    people: new Map(team.map((m) => [m.id, m.name])),
    publicUrl: detail.doc.share_token ? salesQuotePublicUrl(detail.doc.share_token) : null,
  });

  return (
    <SalesDetail
      view={view}
      brand={brand}
      initialPanel={q.facturar === '1' && view.doc.can.invoice ? 'invoice' : undefined}
      handlers={{
        link: quoteLinkAction,
        send: sendQuoteAction,
        accept: acceptQuoteAction,
        reject: rejectQuoteAction,
        convert: convertToOrderAction,
        cancel: cancelSalesDocumentAction,
        preview: previewInvoiceAction,
        emit: emitInvoiceAction,
      }}
    />
  );
}
