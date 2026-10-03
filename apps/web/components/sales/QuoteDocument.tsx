import { BrandMark } from '@/components/views/blocks/brand';
// Dentro de la marca (`.cortex-brand`), «primary» es el color de la empresa.
import '@/components/views/views.css';
import type { ViewBrand } from '@/lib/branding/shape';
import type { SalesDocView } from '@/lib/sales/types';
import {
  TAX_RATE_LABEL,
  displayTotal,
  documentTotals,
  formatMoney,
} from '@cortex/agent-tools/src/sales/totals';

/**
 * LA COTIZACIÓN COMO PAPEL: lo mismo que dice el PDF, en la pantalla.
 *
 * La usan el enlace público (/cotizacion/<token>, dentro de la marca de la
 * empresa) y la ficha de /ventas («así la ve el cliente»). Sin estado ni
 * efectos: recibe el documento ya armado. Los totales por tarifa salen de la
 * misma función pura que usan el servidor y el PDF (sales/totals.ts), así que
 * el papel no puede decir otra cifra.
 */

const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

export function longDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d} de ${MONTHS[(m ?? 1) - 1]} de ${y}`;
}

const qty = (n: number) => new Intl.NumberFormat('es-CO', { maximumFractionDigits: 4 }).format(n);

export function QuoteDocument({ doc, brand }: { doc: SalesDocView; brand: ViewBrand }) {
  const totals = documentTotals(
    doc.lines.map((l) => ({
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discountPct: l.discountPct,
      taxRate: l.taxRate,
    })),
    doc.withholdings,
  );
  const shown = displayTotal(totals.total, doc.currency);
  const money = (n: number) => formatMoney(n, doc.currency);
  const title = doc.kind === 'invoice' ? 'Factura (borrador)' : doc.kindLabel;

  return (
    <article className="overflow-hidden rounded-card border border-border bg-surface shadow-card">
      <span aria-hidden className="block h-1.5 bg-primary" />
      <div className="space-y-8 p-5 sm:p-8">
        <header className="flex flex-wrap items-start justify-between gap-5">
          <div className="flex min-w-0 items-center gap-3">
            <BrandMark brand={brand} size="lg" />
            <div className="min-w-0">
              <p className="truncate text-lg font-extrabold tracking-tight text-ink">
                {brand.name}
              </p>
              <p className="text-xs text-ink-muted">Fecha: {longDate(doc.issueDate)}</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-micro font-bold uppercase tracking-[0.14em] text-primary">{title}</p>
            <p className="text-2xl font-extrabold tracking-tight text-ink tabular-nums">
              {doc.number}
            </p>
            {doc.kind === 'quote' && doc.validUntil && (
              <p className="text-xs text-ink-muted">Válida hasta el {longDate(doc.validUntil)}</p>
            )}
          </div>
        </header>

        <section aria-label="Cliente" className="rounded-sm bg-surface-2 px-4 py-3">
          <p className="text-micro font-bold uppercase tracking-[0.12em] text-ink-faint">Para</p>
          <p className="mt-0.5 font-bold text-ink">{doc.clientName}</p>
          <p className="text-sm text-ink-muted">
            {[
              doc.clientTaxId ? `NIT ${doc.clientTaxId}` : null,
              doc.contactName ? `Atención: ${doc.contactName}` : null,
              doc.clientEmail,
            ]
              .filter(Boolean)
              .join(' · ') || 'Sin datos de contacto'}
          </p>
        </section>

        <div className="-mx-5 overflow-x-auto sm:mx-0">
          <table className="w-full min-w-[560px] border-collapse text-sm">
            <thead>
              <tr className="bg-primary text-left text-white">
                <th scope="col" className="px-4 py-2 font-semibold sm:rounded-l-sm">
                  Descripción
                </th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">
                  Cant.
                </th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">
                  Precio unit.
                </th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">
                  IVA
                </th>
                <th scope="col" className="px-4 py-2 text-right font-semibold sm:rounded-r-sm">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {doc.lines.map((l, i) => (
                <tr key={`${i}-${l.description}`} className="border-b border-border align-top">
                  <td className="px-4 py-2.5 text-ink">
                    {l.description}
                    {(l.productCode || l.discountPct > 0) && (
                      <span className="block text-xs text-ink-faint">
                        {[
                          l.productCode ? `Cód. ${l.productCode}` : null,
                          l.discountPct > 0 ? `Descuento ${qty(l.discountPct)} %` : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-ink">
                    {qty(l.quantity)}
                    {l.unit ? ` ${l.unit}` : ''}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-ink">
                    {money(l.unitPrice)}
                  </td>
                  <td className="px-3 py-2.5 text-right text-xs text-ink-muted">
                    {l.taxRate === 'excluido'
                      ? 'Excl.'
                      : TAX_RATE_LABEL[l.taxRate].replace('IVA ', '')}
                  </td>
                  <td className="px-4 py-2.5 text-right font-semibold tabular-nums text-ink">
                    {money(totals.lines[i]?.lineTotal ?? l.lineTotal)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex flex-col-reverse gap-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-md space-y-3 text-sm">
            <div>
              <p className="text-micro font-bold uppercase tracking-[0.12em] text-ink-faint">
                Forma de pago
              </p>
              <p className="text-ink">
                {doc.paymentForm === 'contado'
                  ? 'De contado.'
                  : `A crédito, ${doc.paymentDays} días.`}
              </p>
            </div>
            {doc.notes && (
              <div>
                <p className="text-micro font-bold uppercase tracking-[0.12em] text-ink-faint">
                  Notas
                </p>
                <p className="whitespace-pre-line text-ink">{doc.notes}</p>
              </div>
            )}
            {doc.terms && (
              <div>
                <p className="text-micro font-bold uppercase tracking-[0.12em] text-ink-faint">
                  Condiciones
                </p>
                <p className="whitespace-pre-line text-ink-muted">{doc.terms}</p>
              </div>
            )}
          </div>

          <dl className="w-full space-y-1.5 text-sm sm:w-80">
            <Row label="Subtotal" value={money(totals.subtotal)} />
            {totals.discountTotal > 0 && (
              <Row label="Descuentos" value={`−${money(totals.discountTotal)}`} />
            )}
            {totals.ivaByRate
              .filter((r) => r.rate !== 'excluido')
              .map((r) => (
                <Row
                  key={r.rate}
                  label={`${TAX_RATE_LABEL[r.rate]} sobre ${money(r.base)}`}
                  value={money(r.iva)}
                />
              ))}
            {shown.rounding !== 0 && <Row label="Ajuste al peso" value={money(shown.rounding)} />}
            <div className="flex items-baseline justify-between gap-4 rounded-sm bg-primary-soft px-3 py-2">
              <dt className="font-bold text-primary-ink">Total</dt>
              <dd className="text-xl font-extrabold tabular-nums text-primary-ink">
                {money(shown.value)}
              </dd>
            </div>
            {totals.withholdingTotal > 0 && (
              <>
                {totals.retefuente > 0 && (
                  <Row
                    label="Retención en la fuente (estimada)"
                    value={`−${money(totals.retefuente)}`}
                  />
                )}
                {totals.reteica > 0 && (
                  <Row label="ReteICA (estimada)" value={`−${money(totals.reteica)}`} />
                )}
                {totals.reteiva > 0 && (
                  <Row label="ReteIVA (estimada)" value={`−${money(totals.reteiva)}`} />
                )}
                <Row label="Neto estimado a recibir" value={money(totals.netTotal)} strong />
              </>
            )}
          </dl>
        </div>

        <p className="border-t border-border pt-3 text-micro text-ink-faint">
          {doc.kind === 'quote'
            ? 'Esta cotización no es una factura.'
            : doc.kind === 'invoice'
              ? 'Borrador: la factura electrónica la emite el programa contable.'
              : 'Pedido confirmado.'}
        </p>
      </div>
    </article>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-3">
      <dt className={strong ? 'font-semibold text-ink' : 'text-ink-muted'}>{label}</dt>
      <dd
        className={`whitespace-nowrap tabular-nums ${strong ? 'font-bold text-ink' : 'text-ink'}`}
      >
        {value}
      </dd>
    </div>
  );
}
