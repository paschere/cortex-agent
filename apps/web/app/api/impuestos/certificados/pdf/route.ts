import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  CERTIFICATE_KINDS,
  type CertificateKind,
  ICA_CITY_LABEL,
  bogotaToday,
  certificateFileName,
  loadCertificates,
  loadPoBrand,
  readTaxProfile,
  renderCertificatePdf,
} from '@cortex/agent-tools';

/**
 * El PDF de un certificado de retención (0197) para un proveedor, calculado
 * con las facturas de proveedor de la empresa de la sesión. Descargarlo no lo
 * manda a nadie: eso es `tax.certificates`, con confirmación.
 *
 * `?tipo=renta|iva|ica&anio=2025&bimestre=3&proveedor=<NIT o nombre>`.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const notFound = () =>
  new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });

export async function GET(req: Request) {
  const url = new URL(req.url);
  const kind = url.searchParams.get('tipo') as CertificateKind | null;
  const year = Number(url.searchParams.get('anio'));
  const bim = Number(url.searchParams.get('bimestre'));
  const who = url.searchParams.get('proveedor') ?? '';
  if (
    !kind ||
    !(CERTIFICATE_KINDS as readonly string[]).includes(kind) ||
    !(year >= 2020 && year <= 2100) ||
    !who
  )
    return notFound();
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const period = kind === 'iva' && bim >= 1 && bim <= 6 ? bim : null;
  const certs = await loadCertificates(db, { kind, year, period });
  const cert = certs.find((c) => (c.supplierNit ?? c.supplierName) === who);
  if (!cert) return notFound();
  const [brand, profile] = await Promise.all([
    loadPoBrand(db, user.organization.id),
    readTaxProfile(db),
  ]);
  const pdf = renderCertificatePdf(cert, brand, {
    nit: profile?.nit ?? null,
    dv: profile?.dv ?? null,
    city: profile?.icaCity && profile.icaCity !== 'otra' ? ICA_CITY_LABEL[profile.icaCity] : null,
    issuedOn: bogotaToday(),
  });
  return new Response(new Uint8Array(pdf), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${certificateFileName(cert)}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
