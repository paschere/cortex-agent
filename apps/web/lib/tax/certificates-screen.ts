import type { CertificatesScreen, TaxTabLinks } from '@/components/tax/types';
import {
  type CertificateKind,
  type CertificateRecord,
  WITHHOLDING_CONCEPTS,
  WITHHOLDING_CONCEPT_LABEL,
  type WithholdingCertificate,
} from '@cortex/agent-tools';
import { shortDay } from './screen';

/**
 * DE LOS CERTIFICADOS A LA PANTALLA (0197). Puro: los certificados calculados
 * con las facturas de proveedor, lo ya expedido (a quién y cuándo) y los
 * proveedores (correo y concepto).
 */
export function buildCertificatesScreen(input: {
  kind: CertificateKind;
  year: number;
  period: number | null;
  years: number[];
  certificates: WithholdingCertificate[];
  records: CertificateRecord[];
  suppliers: Map<string, { email: string | null; concept: string | null }>;
  canAct: boolean;
  href: (path: string) => string;
  tabs: TaxTabLinks;
}): CertificatesScreen {
  const sent = new Map(
    input.records.map((r) => [`${r.supplierNit ?? r.supplierName}`, r] as const),
  );
  const rows = input.certificates.map((c) => {
    const key = c.supplierNit ?? c.supplierName;
    const rec = sent.get(key);
    const sup = c.supplierId ? input.suppliers.get(c.supplierId) : undefined;
    const q = new URLSearchParams({ tipo: c.kind, anio: String(c.year), proveedor: key });
    if (c.period) q.set('bimestre', String(c.period));
    return {
      key,
      supplierId: c.supplierId,
      supplierName: c.supplierName,
      supplierNit: c.supplierNit,
      concept: c.concept,
      supplierConcept: sup?.concept ?? null,
      base: c.base,
      withheld: c.withheld,
      invoices: c.sources.length,
      hasEmail: Boolean(sup?.email),
      sentLabel: rec?.sentAt
        ? `Enviado el ${shortDay(rec.sentAt.slice(0, 10))}${rec.sentTo ? ` a ${rec.sentTo}` : ''}`
        : null,
      pdfHref: input.href(`/api/impuestos/certificados/pdf?${q.toString()}`),
    };
  });
  const self = new URLSearchParams({ anio: String(input.year), tipo: input.kind });
  if (input.period) self.set('bimestre', String(input.period));
  return {
    kind: input.kind,
    year: input.year,
    period: input.period,
    years: input.years,
    rows,
    total: Math.round(rows.reduce((s, r) => s + r.withheld, 0) * 100) / 100,
    canAct: input.canAct,
    concepts: WITHHOLDING_CONCEPTS.map((c) => ({ value: c, label: WITHHOLDING_CONCEPT_LABEL[c] })),
    hrefs: { tabs: input.tabs, self: input.href(`/impuestos/certificados?${self.toString()}`) },
  };
}
