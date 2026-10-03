import { CertificatesView } from '@/components/tax/CertificatesView';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { buildCertificatesScreen } from '@/lib/tax/certificates-screen';
import { taxTabLinks } from '@/lib/tax/tabs';
import { workspaceHref } from '@/lib/workspace-context';
import {
  CERTIFICATE_KINDS,
  type CertificateKind,
  type CertificateRecord,
  bogotaToday,
  canMarkTaxObligations,
  listCertificateRecords,
  loadCertificates,
  readTaxProfile,
} from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';
import { sendCertificatesAction, setSupplierConceptAction } from '../actions';

export const dynamic = 'force-dynamic';

/**
 * CERTIFICADOS DE RETENCIÓN A PROVEEDORES (0197): calculados con las facturas
 * de proveedor del año (o del bimestre, para IVA). Descargar es de cualquiera
 * de la empresa; mandarlos por correo pide confirmar y lo hace quien responde
 * por los impuestos o administra (la herramienta `tax.certificates`).
 *
 * Parámetros: `?anio=2025&tipo=renta|iva|ica&bimestre=1..6`.
 */

async function supplierInfo(
  db: SupabaseClient,
  ids: string[],
): Promise<Map<string, { email: string | null; concept: string | null }>> {
  const out = new Map<string, { email: string | null; concept: string | null }>();
  if (!ids.length) return out;
  const { data, error } = await db
    .from('suppliers')
    .select('id, email, withholding_concept')
    .in('id', ids);
  if (error) throw error;
  for (const r of (data ?? []) as Array<{
    id: string;
    email: string | null;
    withholding_concept: string | null;
  }>)
    out.set(r.id, { email: r.email, concept: r.withholding_concept });
  return out;
}

export default async function CertificatesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const href = (path: string) => workspaceHref(user.organization.id, path);
  const q = await searchParams;
  const today = bogotaToday();
  const thisYear = Number(today.slice(0, 4));
  const years = [thisYear - 2, thisYear - 1, thisYear];
  const askedYear = Number(typeof q.anio === 'string' ? q.anio : Number.NaN);
  const year = years.includes(askedYear)
    ? askedYear
    : Number(today.slice(5, 7)) <= 4
      ? thisYear - 1
      : thisYear;
  const kind: CertificateKind = (CERTIFICATE_KINDS as readonly string[]).includes(String(q.tipo))
    ? (q.tipo as CertificateKind)
    : 'renta';
  const askedPeriod = Number(typeof q.bimestre === 'string' ? q.bimestre : Number.NaN);
  const period =
    kind === 'iva' ? (askedPeriod >= 1 && askedPeriod <= 6 ? askedPeriod : null) : null;

  const [profile, certificates, records] = await Promise.all([
    readTaxProfile(db),
    loadCertificates(db, { kind, year, period }),
    listCertificateRecords(db, { year, kind }).catch((): CertificateRecord[] => []),
  ]);
  const [canAct, suppliers] = await Promise.all([
    canMarkTaxObligations(db, user.id, profile),
    supplierInfo(db, [
      ...new Set(certificates.map((c) => c.supplierId).filter(Boolean)),
    ] as string[]),
  ]);
  const data = buildCertificatesScreen({
    kind,
    year,
    period,
    years,
    certificates,
    records: records.filter((r) => (r.period ?? null) === period),
    suppliers,
    canAct,
    href,
    tabs: taxTabLinks(href),
  });
  return (
    <CertificatesView
      data={data}
      actions={{
        send: sendCertificatesAction.bind(null, { kind, year, period }),
        setConcept: setSupplierConceptAction,
      }}
    />
  );
}
