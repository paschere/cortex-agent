import { SalesEditor } from '@/components/sales/SalesEditor';
import { PageHeader } from '@/components/ui/page-header';
import type { SalesEditorInput } from '@/lib/sales/types';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { bogotaToday, getClient, listContacts } from '@cortex/agent-tools';
import { FilePlus2 } from 'lucide-react';
import {
  clientDefaultsAction,
  saveSalesDocumentAction,
  searchClientsAction,
  searchProductsAction,
} from '../actions';

/**
 * Una cotización nueva. Desde la ficha del cliente llega con `?cliente=<id>` y
 * el editor arranca con su nombre, NIT, correo del contacto principal y días
 * de pago.
 */

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Nueva cotización · Cortex' };

const VALID_DAYS = 15;

export default async function NewQuotePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const q = await searchParams;
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const clientId =
    typeof q.cliente === 'string' && /^[0-9a-f-]{36}$/i.test(q.cliente) ? q.cliente : null;
  const client = clientId ? await getClient(db, clientId).catch(() => null) : null;
  const contacts = client ? await listContacts(db, client.id).catch(() => []) : [];
  const primary =
    contacts.find((c) => c.is_primary && c.email && c.status !== 'left') ??
    contacts.find((c) => c.email && c.status !== 'left');
  const today = bogotaToday();
  const validUntil = new Date(Date.parse(`${today}T12:00:00Z`) + VALID_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const paymentDays = client?.payment_terms_days ?? 30;

  const initial: SalesEditorInput = {
    clientId: client?.id ?? null,
    clientName: client?.name ?? '',
    clientTaxId: client?.tax_id ?? null,
    clientEmail: primary?.email ?? null,
    contactName: primary?.full_name ?? null,
    validUntil,
    paymentForm: paymentDays === 0 ? 'contado' : 'credito',
    paymentDays,
    notes: null,
    terms: null,
    withholdings: {},
    lines: [],
  };

  async function save(input: SalesEditorInput) {
    'use server';
    return saveSalesDocumentAction(null, 'quote', input);
  }

  return (
    <div className="mx-auto max-w-[1240px] px-4 py-6 sm:px-6 sm:py-8">
      <PageHeader
        title="Nueva cotización"
        subtitle="Precios antes de IVA. Elige los productos del catálogo de tu programa contable para poder facturar electrónicamente después."
        icon={<FilePlus2 className="h-5 w-5" aria-hidden />}
      />
      <SalesEditor
        kind="quote"
        initial={initial}
        cancelHref="/ventas"
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
