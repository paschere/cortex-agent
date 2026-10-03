import type { GridView } from '@/components/datagrid/types';
import { SalesList } from '@/components/sales/SalesList';
import { PageHeader } from '@/components/ui/page-header';
import { listGridViews } from '@/lib/datagrid/views-store';
import {
  KIND_SLUG,
  SALES_VIEW_SCOPE,
  kindFromSlug,
  salesColumns,
  salesGridRow,
} from '@/lib/sales/view';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  type SalesDocumentRow,
  type SalesKind,
  bogotaToday,
  listSalesDocuments,
  salesEffectiveStatus,
} from '@cortex/agent-tools';
import { formatMoney } from '@cortex/agent-tools/src/sales/totals';
import { Receipt } from 'lucide-react';
import { deleteSalesView, saveSalesView } from './actions';

/**
 * VENTAS (migración 0182): cotizaciones → pedidos → facturas electrónicas.
 *
 * Una pestaña por clase, cada una en la grilla compartida con vistas guardadas
 * del equipo (alcance `sales`). Arriba, las tres cifras que se preguntan:
 * cuánto hay cotizado esperando respuesta, cuánto se aceptó sin facturar y
 * cuánto se facturó este mes.
 */

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Ventas · Cortex' };

const NOUN: Record<SalesKind, { one: string; many: string; gender: 'm' | 'f' }> = {
  quote: { one: 'cotización', many: 'cotizaciones', gender: 'f' },
  order: { one: 'pedido', many: 'pedidos', gender: 'm' },
  invoice: { one: 'factura', many: 'facturas', gender: 'f' },
};

const EMPTY: Record<SalesKind, string> = {
  quote:
    'Crea una aquí o pídesela a Cortex en el chat: «hazle una cotización a Nexa de 10 fletes Bogotá–Cali a $1.2M».',
  order: 'Un pedido nace de una cotización aceptada («Convertir en pedido»).',
  invoice:
    'Una factura sale de una cotización aceptada o de un pedido («Facturar»), y la emite Siigo o Alegra.',
};

export default async function SalesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const q = await searchParams;
  const kind = kindFromSlug(typeof q.tipo === 'string' ? q.tipo : undefined);
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const today = bogotaToday();

  const [all, savedViews] = await Promise.all([
    listSalesDocuments(db, { limit: 1000 }).catch((): SalesDocumentRow[] | null => null),
    listGridViews(SALES_VIEW_SCOPE).catch((): GridView[] => []),
  ]);
  const docs = all ?? [];
  const byKind = (k: SalesKind) => docs.filter((d) => d.kind === k);
  const month = today.slice(0, 7);
  const sum = (list: SalesDocumentRow[]) => list.reduce((s, d) => s + d.total, 0);
  const waiting = byKind('quote').filter((d) => salesEffectiveStatus(d, today) === 'enviada');
  const accepted = byKind('quote').filter((d) => d.status === 'aceptada');
  const orders = byKind('order').filter((d) => d.status === 'pedido');
  const invoicedThisMonth = byKind('invoice').filter(
    (d) => d.status === 'emitida' && (d.emitted_at ?? '').slice(0, 7) === month,
  );

  return (
    <div className="mx-auto max-w-[1320px] px-4 py-6 sm:px-6 sm:py-8">
      <PageHeader
        title="Ventas"
        subtitle="Cotiza con tu marca, que el cliente acepte desde un enlace, conviértelo en pedido y emite la factura electrónica por Siigo o Alegra con tu aprobación."
        icon={<Receipt className="h-5 w-5" aria-hidden />}
      />
      {all === null && (
        <p role="alert" className="mb-4 rounded-sm bg-rose-soft px-3 py-2 text-sm text-rose">
          No se pudieron leer las ventas. Si es la primera vez, falta aplicar la migración 0182.
        </p>
      )}
      <SalesList
        tabs={(['quote', 'order', 'invoice'] as SalesKind[]).map((k) => ({
          id: KIND_SLUG[k],
          label: NOUN[k].many.charAt(0).toUpperCase() + NOUN[k].many.slice(1),
          href: `/ventas?tipo=${KIND_SLUG[k]}`,
          count: byKind(k).filter((d) => d.status !== 'anulada').length,
        }))}
        active={KIND_SLUG[kind]}
        kindNoun={NOUN[kind]}
        columns={salesColumns(kind)}
        rows={byKind(kind).map((d) => salesGridRow(d, today))}
        savedViews={savedViews}
        onSaveView={saveSalesView}
        onDeleteView={deleteSalesView}
        newHref={kind === 'quote' ? '/ventas/nueva' : null}
        summary={[
          {
            label: `Cotizado esperando respuesta (${waiting.length})`,
            value: formatMoney(sum(waiting)),
            tone: 'primary',
          },
          {
            label: `Aceptado sin facturar (${accepted.length + orders.length})`,
            value: formatMoney(sum(accepted) + sum(orders)),
            tone: 'amber',
          },
          {
            label: `Facturado este mes (${invoicedThisMonth.length})`,
            value: formatMoney(sum(invoicedThisMonth)),
            tone: 'emerald',
          },
        ]}
        emptyBody={EMPTY[kind]}
      />
    </div>
  );
}
