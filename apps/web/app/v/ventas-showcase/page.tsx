import { QuoteResponse } from '@/app/cotizacion/[token]/QuoteResponse';
import { PublicShell } from '@/app/v/[token]/PublicShell';
import { QuoteDocument } from '@/components/sales/QuoteDocument';
import type { ViewBrand } from '@/lib/branding/shape';
import { detailView, docView, previewView, salesColumns, salesGridRow } from '@/lib/sales/view';
import type { SalesDocumentRow, SalesKind, SalesLineRow } from '@cortex/agent-tools';
import { notFound } from 'next/navigation';
import { VentasFixture } from './Showcase';

/**
 * VENTAS CON DATOS INVENTADOS. SÓLO EN DESARROLLO.
 *
 * /ventas y /cotizacion/<token> piden sesión o un token real; aquí se pintan
 * los mismos componentes con una empresa de mentira (Transportes Andinos) y su
 * cliente Nexa. `?pantalla=lista|ficha|factura|editor|publica`, `?modo=oscuro`.
 * En producción responde 404.
 */

export const dynamic = 'force-dynamic';

const TODAY = '2026-10-03';
const BRAND: ViewBrand = {
  name: 'Transportes Andinos',
  logoUrl: null,
  primary: '#0f766e',
  secondary: null,
};

function doc(over: Partial<SalesDocumentRow>): SalesDocumentRow {
  return {
    id: '00000000-0000-4000-a000-000000000001',
    organization_id: 'org',
    kind: 'quote',
    number: 12,
    status: 'enviada',
    source_id: null,
    client_id: '00000000-0000-4000-a000-0000000000aa',
    client_name: 'Nexa Logística S.A.S.',
    client_tax_id: '900123456',
    client_email: 'compras@nexa.co',
    contact_name: 'Carlos Peña',
    issue_date: '2026-10-01',
    valid_until: '2026-10-16',
    due_date: null,
    currency: 'COP',
    payment_form: 'credito',
    payment_days: 30,
    notes: 'Incluye cargue y descargue en bodega. Seguro de mercancía hasta $200 millones.',
    terms: 'Precios en pesos colombianos antes de IVA. Tiempo de tránsito 24 horas.',
    withholdings: { retefuente_pct: 1, reteica_per_mil: 4.14 },
    subtotal: 12_300_000,
    discount_total: 15_000,
    tax_base: 12_285_000,
    iva_total: 2_280_000,
    total: 14_565_000,
    withholding_total: 173_710.9,
    net_total: 14_391_289.1,
    share_token: 'x'.repeat(32),
    share_views: 3,
    sent_at: '2026-10-01T15:20:00Z',
    sent_to: 'compras@nexa.co',
    accepted_at: null,
    accepted_by_name: null,
    rejected_at: null,
    rejection_reason: null,
    provider: null,
    provider_invoice_id: null,
    provider_number: null,
    cufe: null,
    einvoice_status: null,
    provider_url: null,
    provider_error: null,
    emission_uncertain: false,
    emission_attempted_at: null,
    emitted_at: null,
    created_by: 'u1',
    updated_by: 'u1',
    created_at: '2026-10-01T15:00:00Z',
    updated_at: '2026-10-01T15:00:00Z',
    ...over,
  };
}

const LINES: SalesLineRow[] = [
  {
    id: 'l1',
    document_id: 'd',
    position: 1,
    description: 'Flete Bogotá–Cali, tractomula carpada',
    product_ref: '501',
    product_code: 'FLT-BC',
    unit: 'viaje',
    quantity: 10,
    unit_price: 1_200_000,
    discount_pct: 0,
    tax_rate: 'iva_19',
    gross: 12_000_000,
    discount: 0,
    base: 12_000_000,
    iva: 2_280_000,
    line_total: 14_280_000,
  },
  {
    id: 'l2',
    document_id: 'd',
    position: 2,
    description: 'Seguro de mercancía',
    product_ref: '502',
    product_code: 'SEG',
    unit: null,
    quantity: 1,
    unit_price: 150_000,
    discount_pct: 10,
    tax_rate: 'excluido',
    gross: 150_000,
    discount: 15_000,
    base: 135_000,
    iva: 0,
    line_total: 135_000,
  },
  {
    id: 'l3',
    document_id: 'd',
    position: 3,
    description: 'Cargue y descargue',
    product_ref: null,
    product_code: null,
    unit: null,
    quantity: 1,
    unit_price: 150_000,
    discount_pct: 0,
    tax_rate: 'excluido',
    gross: 150_000,
    discount: 0,
    base: 150_000,
    iva: 0,
    line_total: 150_000,
  },
];

function listDocs(): SalesDocumentRow[] {
  const clients = [
    'Nexa Logística S.A.S.',
    'Coltrans S.A.S.',
    'Agroandes Ltda.',
    'Ferretería El Tornillo',
    'Distribuidora Caribe',
  ];
  const statuses = [
    'enviada',
    'aceptada',
    'borrador',
    'rechazada',
    'enviada',
    'pedido',
    'facturada',
  ] as const;
  return Array.from({ length: 14 }, (_, i) =>
    doc({
      id: `00000000-0000-4000-a000-${String(i + 10).padStart(12, '0')}`,
      number: 20 - i,
      client_name: clients[i % clients.length] as string,
      status: statuses[i % statuses.length],
      issue_date: `2026-09-${String(28 - i).padStart(2, '0')}`,
      valid_until: i === 4 ? '2026-09-30' : `2026-10-${String(13 - (i % 10)).padStart(2, '0')}`,
      total: 1_000_000 + i * 870_000,
      iva_total: Math.round((1_000_000 + i * 870_000) * 0.16),
      net_total: 1_000_000 + i * 850_000,
      share_views: i % 4,
    }),
  );
}

export default async function VentasShowcasePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : null);
  const pantalla = one('pantalla') ?? 'lista';
  const dark = one('modo') === 'oscuro';

  if (pantalla === 'publica') {
    const view = docView(doc({}), LINES, TODAY);
    return (
      <PublicShell brand={BRAND}>
        <div className="mx-auto max-w-4xl space-y-5">
          <QuoteResponse
            token={'x'.repeat(32)}
            state={one('estado') === 'aceptada' ? 'accepted' : 'open'}
            number={view.number}
            companyName={BRAND.name}
            acceptedBy="Carlos Peña"
            acceptedAt="2026-10-02T14:05:00Z"
            pdfUrl="#"
          />
          <QuoteDocument doc={view} brand={BRAND} />
        </div>
      </PublicShell>
    );
  }

  const kind: SalesKind =
    one('tipo') === 'facturas' ? 'invoice' : one('tipo') === 'pedidos' ? 'order' : 'quote';
  const docs = listDocs().map((d) => ({ ...d, kind }));
  const invoice = pantalla === 'factura';
  const base = invoice
    ? doc({
        status: 'aceptada',
        accepted_at: '2026-10-02T14:05:00Z',
        accepted_by_name: 'Carlos Peña',
      })
    : doc({});
  const detail = detailView(
    {
      doc: base,
      lines: LINES,
      events: [
        {
          id: 'e1',
          document_id: 'd',
          kind: 'created',
          detail: null,
          actor_user_id: 'u1',
          actor_label: null,
          created_at: '2026-10-01T15:00:00Z',
        },
        {
          id: 'e2',
          document_id: 'd',
          kind: 'sent',
          detail: 'A compras@nexa.co',
          actor_user_id: 'u1',
          actor_label: null,
          created_at: '2026-10-01T15:20:00Z',
        },
        {
          id: 'e3',
          document_id: 'd',
          kind: 'viewed',
          detail: null,
          actor_user_id: null,
          actor_label: 'El cliente, desde el enlace',
          created_at: '2026-10-01T18:02:00Z',
        },
        ...(invoice
          ? [
              {
                id: 'e4',
                document_id: 'd',
                kind: 'accepted' as const,
                detail: null,
                actor_user_id: null,
                actor_label: 'Carlos Peña (desde el enlace)',
                created_at: '2026-10-02T14:05:00Z',
              },
            ]
          : []),
      ],
      related: [],
    },
    {
      today: TODAY,
      people: new Map([['u1', 'Laura Gómez']]),
      publicUrl: 'https://cortex.app/cotizacion/xxxxxxxx',
    },
  );
  const preview = previewView({
    providerName: 'Siigo',
    guidance: null,
    draft: {
      provider: 'siigo',
      payload: {},
      problems: [
        'La línea 3 («Cargue y descargue») no tiene un producto de Siigo: elígelo del catálogo.',
      ],
      notes: [
        'Las retenciones estimadas ($173.710,90) no van en la factura: el cliente las practica al pagar y se registran en el recibo de caja.',
        'Siigo le manda la factura al correo del cliente registrado en Siigo.',
      ],
      summary: {
        documentType: 'FV-2 Factura electrónica',
        seller: 'Laura Gómez',
        payment: 'Crédito',
        date: TODAY,
        dueDate: '2026-11-02',
        customer: 'Nexa Logística S.A.S. · NIT 900123456',
        lines: LINES.map((l) => ({
          description: l.description,
          code: l.product_code,
          quantity: l.quantity,
          unitPrice: l.unit_price,
          discountPct: l.discount_pct,
          tax: l.tax_rate === 'iva_19' ? 'IVA 19%' : 'Excluido',
          total: l.line_total,
        })),
        subtotal: 12_285_000,
        iva: 2_280_000,
        total: 14_565_000,
      },
    },
  });

  return (
    <VentasFixture
      dark={dark}
      pantalla={
        pantalla === 'ficha' || pantalla === 'factura' || pantalla === 'editor' ? pantalla : 'lista'
      }
      kind={kind}
      columns={salesColumns(kind)}
      rows={docs.map((d) => salesGridRow(d, TODAY))}
      detail={detail}
      preview={preview}
      brand={BRAND}
    />
  );
}
