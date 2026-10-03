'use client';

import type { GridColumn, GridRow } from '@/components/datagrid/types';
import { SalesDetail } from '@/components/sales/SalesDetail';
import { SalesEditor } from '@/components/sales/SalesEditor';
import { SalesList } from '@/components/sales/SalesList';
import { PageHeader } from '@/components/ui/page-header';
import type { ViewBrand } from '@/lib/branding/shape';
import type { InvoicePreviewView, SalesActionResult, SalesDetailView } from '@/lib/sales/types';
import { FilePlus2, Receipt } from 'lucide-react';
import { useEffect } from 'react';

/** Ventas con datos inventados: las acciones contestan en pantalla sin tocar ninguna base. */

const fake = async <T,>(note: string, data?: T): Promise<SalesActionResult<T>> => {
  await new Promise((r) => setTimeout(r, 300));
  return { ok: true, note: `(escaparate) ${note}`, data };
};

const NOUN = {
  quote: { one: 'cotización', many: 'cotizaciones', gender: 'f' as const },
  order: { one: 'pedido', many: 'pedidos', gender: 'm' as const },
  invoice: { one: 'factura', many: 'facturas', gender: 'f' as const },
};

export function VentasFixture(props: {
  dark: boolean;
  pantalla: 'lista' | 'ficha' | 'factura' | 'editor';
  kind: 'quote' | 'order' | 'invoice';
  columns: GridColumn[];
  rows: GridRow[];
  detail: SalesDetailView;
  preview: InvoicePreviewView;
  brand: ViewBrand;
}) {
  useEffect(() => {
    document.documentElement.dataset.theme = props.dark ? 'dark' : 'light';
  }, [props.dark]);

  if (props.pantalla === 'ficha' || props.pantalla === 'factura')
    return (
      <div className="min-h-screen bg-canvas">
        <SalesDetail
          view={props.detail}
          brand={props.brand}
          initialPanel={props.pantalla === 'factura' ? 'invoice' : undefined}
          handlers={{
            link: (id) => fake('Enlace copiado', { url: `https://cortex.app/cotizacion/${id}` }),
            send: () => fake('Cotización enviada'),
            accept: () => fake('Anotada como aceptada'),
            reject: () => fake('Anotada como rechazada'),
            convert: () => fake('Pedido creado'),
            cancel: () => fake('Anulada'),
            preview: () => fake('', props.preview),
            emit: () => fake('Factura emitida'),
          }}
        />
      </div>
    );

  if (props.pantalla === 'editor')
    return (
      <div className="min-h-screen bg-canvas">
        <div className="mx-auto max-w-[1240px] px-4 py-6 sm:px-6 sm:py-8">
          <PageHeader
            title="Nueva cotización"
            subtitle="Precios antes de IVA. Elige los productos del catálogo de tu programa contable para poder facturar electrónicamente después."
            icon={<FilePlus2 className="h-5 w-5" aria-hidden />}
          />
          <SalesEditor
            kind="quote"
            cancelHref="#"
            initial={{
              clientId: props.detail.doc.clientId,
              clientName: props.detail.doc.clientName,
              clientTaxId: props.detail.doc.clientTaxId,
              clientEmail: props.detail.doc.clientEmail,
              contactName: props.detail.doc.contactName,
              validUntil: props.detail.doc.validUntil,
              paymentForm: 'credito',
              paymentDays: 30,
              notes: props.detail.doc.notes,
              terms: null,
              withholdings: { retefuentePct: 1 },
              lines: props.detail.doc.lines.map((l) => ({
                description: l.description,
                quantity: l.quantity,
                unitPrice: l.unitPrice,
                discountPct: l.discountPct,
                taxRate: l.taxRate,
                productRef: l.productRef,
                productCode: l.productCode,
                unit: l.unit,
              })),
            }}
            handlers={{
              save: () => fake('Guardada', { id: props.detail.doc.id }),
              searchClients: async () => [],
              clientDefaults: async () => null,
              searchProducts: async () => [],
            }}
          />
        </div>
      </div>
    );

  return (
    <div className="min-h-screen bg-canvas">
      <div className="mx-auto max-w-[1320px] px-4 py-6 sm:px-6 sm:py-8">
        <PageHeader
          title="Ventas"
          subtitle="Cotiza con tu marca, que el cliente acepte desde un enlace, conviértelo en pedido y emite la factura electrónica por Siigo o Alegra con tu aprobación."
          icon={<Receipt className="h-5 w-5" aria-hidden />}
        />
        <SalesList
          tabs={[
            { id: 'cotizaciones', label: 'Cotizaciones', href: '?tipo=cotizaciones', count: 14 },
            { id: 'pedidos', label: 'Pedidos', href: '?tipo=pedidos', count: 3 },
            { id: 'facturas', label: 'Facturas', href: '?tipo=facturas', count: 5 },
          ]}
          active={
            props.kind === 'quote'
              ? 'cotizaciones'
              : props.kind === 'order'
                ? 'pedidos'
                : 'facturas'
          }
          kindNoun={NOUN[props.kind]}
          columns={props.columns}
          rows={props.rows}
          savedViews={[]}
          newHref={props.kind === 'quote' ? '#' : null}
          summary={[
            { label: 'Cotizado esperando respuesta (4)', value: '$18.420.000', tone: 'primary' },
            { label: 'Aceptado sin facturar (3)', value: '$9.870.000', tone: 'amber' },
            { label: 'Facturado este mes (5)', value: '$31.250.000', tone: 'emerald' },
          ]}
          emptyBody="Crea una aquí o pídesela a Cortex en el chat."
          urlParam={false}
        />
      </div>
    </div>
  );
}
