import { SalesEditor } from '@/components/sales/SalesEditor';
import { PageHeader } from '@/components/ui/page-header';
import type { SalesEditorInput } from '@/lib/sales/types';
import { docView } from '@/lib/sales/view';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { bogotaToday, getSalesDocument } from '@cortex/agent-tools';
import { Pencil } from 'lucide-react';
import { notFound, redirect } from 'next/navigation';
import {
  clientDefaultsAction,
  saveSalesDocumentAction,
  searchClientsAction,
  searchProductsAction,
} from '../../actions';

/** Editar una cotización o un pedido mientras no haya salido de la empresa. */

export const dynamic = 'force-dynamic';

export default async function EditSalesDocumentPage({
  params,
}: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const detail = await getSalesDocument(db, id);
  if (!detail) notFound();
  const view = docView(detail.doc, detail.lines, bogotaToday());
  if (!view.can.edit || view.kind === 'invoice') redirect(`/ventas/${id}`);
  const kind = view.kind;

  const initial: SalesEditorInput = {
    clientId: view.clientId,
    clientName: view.clientName,
    clientTaxId: view.clientTaxId,
    clientEmail: view.clientEmail,
    contactName: view.contactName,
    validUntil: view.validUntil,
    paymentForm: view.paymentForm,
    paymentDays: view.paymentDays,
    notes: view.notes,
    terms: view.terms,
    withholdings: view.withholdings,
    lines: view.lines.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discountPct: l.discountPct,
      taxRate: l.taxRate,
      productRef: l.productRef,
      productCode: l.productCode,
      unit: l.unit,
    })),
  };

  async function save(input: SalesEditorInput) {
    'use server';
    return saveSalesDocumentAction(id, kind === 'order' ? 'order' : 'quote', input);
  }

  return (
    <div className="mx-auto max-w-[1240px] px-4 py-6 sm:px-6 sm:py-8">
      <PageHeader
        title={`Editar ${view.kindLabel.toLowerCase()} ${view.number}`}
        subtitle="Los totales se recalculan al guardar a partir de las líneas."
        icon={<Pencil className="h-5 w-5" aria-hidden />}
      />
      <SalesEditor
        kind={kind === 'order' ? 'order' : 'quote'}
        initial={initial}
        cancelHref={`/ventas/${id}`}
        handlers={{
          save,
          searchClients: searchClientsAction,
          clientDefaults: clientDefaultsAction,
          searchProducts: searchProductsAction,
        }}
      />
    </div>
  );
}
