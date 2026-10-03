import { PublicShell } from '@/app/v/[token]/PublicShell';
import { QuoteDocument } from '@/components/sales/QuoteDocument';
import { readBranding, toViewBrand } from '@/lib/branding/store';
import { openPublicQuote } from '@/lib/sales/public';
import { docView } from '@/lib/sales/view';
import { bogotaToday, countSalesQuoteView, getSalesLines } from '@cortex/agent-tools';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { QuoteResponse } from './QuoteResponse';

/**
 * UNA COTIZACIÓN, VISTA POR EL CLIENTE (migración 0182).
 *
 * Fuera del shell de la app a propósito, igual que /v/<token>: quien abre esto
 * es el cliente y ve la marca de la empresa (logo, nombre, color), la
 * cotización como papel, el PDF para bajar y «Aceptar cotización». El token es
 * la credencial (lib/sales/public.ts); uno que no abre es 404 sin explicación.
 *
 * Abrirla cuenta una vista (la primera deja huella en la línea de tiempo:
 * «El cliente la abrió»). Aceptarla avisa en la campana a quien la creó.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Cotización',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default async function PublicQuotePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const opened = await openPublicQuote(token);
  if (!opened) notFound();
  const { doc, db, organizationName } = opened;
  const today = bogotaToday();
  const [lines, branding] = await Promise.all([getSalesLines(db, doc.id), readBranding(db)]);
  const brand = toViewBrand(
    branding,
    organizationName,
    (v) => `/api/sales/public/logo?token=${encodeURIComponent(token)}&v=${v}`,
  );
  const view = docView(doc, lines, today);
  void countSalesQuoteView(db, doc).catch(() => undefined);

  const state =
    doc.status === 'aceptada' || doc.status === 'pedido' || doc.status === 'facturada'
      ? 'accepted'
      : doc.status === 'rechazada'
        ? 'rejected'
        : view.status === 'vencida'
          ? 'expired'
          : 'open';

  return (
    <PublicShell brand={brand}>
      <div className="mx-auto max-w-4xl space-y-5">
        <QuoteResponse
          token={token}
          state={state}
          number={view.number}
          companyName={brand.name}
          acceptedBy={doc.accepted_by_name}
          acceptedAt={doc.accepted_at}
          pdfUrl={`/api/sales/public/pdf?token=${encodeURIComponent(token)}`}
        />
        <QuoteDocument doc={view} brand={brand} />
      </div>
    </PublicShell>
  );
}
