import { type PurchaseDocInput, round2 } from './draft-shape';
import { resolveConcept } from './drafts';
import { WITHHOLDING_CONCEPT_LABEL, type WithholdingConcept } from './rates-co';

/**
 * LOS CERTIFICADOS DE RETENCIÓN A PROVEEDORES (migración 0197). PURO.
 *
 * Como agente de retención, la empresa le expide a cada proveedor un
 * certificado con lo que le retuvo: renta (anual, art. 381 ET), IVA (por
 * bimestre o anual) e ICA (anual o según el municipio). Las cifras salen de
 * las facturas de proveedor (0181): base sin IVA y la retención anotada en
 * cada una. Las rechazadas no cuentan; las notas crédito restan.
 *
 * El certificado dice de qué facturas sale cada peso (`sources`), igual que
 * los borradores.
 */

export const CERTIFICATE_KINDS = ['renta', 'iva', 'ica'] as const;
export type CertificateKind = (typeof CERTIFICATE_KINDS)[number];

export const CERTIFICATE_KIND_LABEL: Record<CertificateKind, string> = {
  renta: 'Retención en la fuente a título de renta',
  iva: 'Retención a título de IVA (reteIVA)',
  ica: 'Retención de ICA (reteICA)',
};

export interface CertificateSource {
  id: string;
  docNumber: string;
  issueDate: string;
  base: number;
  withheld: number;
}

export interface WithholdingCertificate {
  kind: CertificateKind;
  year: number;
  /** Bimestre 1–6 para IVA por bimestre; null = el año. */
  period: number | null;
  supplierId: string | null;
  supplierNit: string | null;
  supplierName: string;
  /** Concepto dominante (renta) o una descripción de la tarifa. */
  concept: string | null;
  /** Para renta: base y retención por concepto. */
  byConcept: Array<{ concept: string; base: number; withheld: number }>;
  base: number;
  withheld: number;
  sources: CertificateSource[];
}

function supplierKey(d: Pick<PurchaseDocInput, 'supplierNit' | 'supplierName'>): string {
  return d.supplierNit ?? `nombre:${d.supplierName.trim().toLowerCase()}`;
}

function withheldFor(d: PurchaseDocInput, kind: CertificateKind): number {
  if (kind === 'renta') return d.retefuente;
  if (kind === 'iva') return d.reteiva;
  return d.reteica;
}

/** Base de la retención: la de IVA es el IVA; las demás, la base sin IVA. */
function baseFor(d: PurchaseDocInput, kind: CertificateKind): number {
  if (kind === 'iva') return d.iva;
  return d.subtotal ?? Math.max(0, d.total - d.iva);
}

export function bimesterOf(date: string): number {
  return Math.ceil(Number(date.slice(5, 7)) / 2);
}

/**
 * Los certificados de un año (o un bimestre, para IVA) a partir de las
 * facturas de proveedor. Un certificado por proveedor con retención > 0.
 */
export function buildWithholdingCertificates(
  purchases: PurchaseDocInput[],
  opts: { kind: CertificateKind; year: number; period?: number | null },
): WithholdingCertificate[] {
  const period = opts.kind === 'iva' ? (opts.period ?? null) : null;
  const rows = purchases.filter(
    (d) =>
      d.date.startsWith(`${opts.year}-`) &&
      (period === null || bimesterOf(d.date) === period) &&
      withheldFor(d, opts.kind) > 0,
  );
  const groups = new Map<string, PurchaseDocInput[]>();
  for (const d of rows) groups.set(supplierKey(d), [...(groups.get(supplierKey(d)) ?? []), d]);

  const out: WithholdingCertificate[] = [];
  for (const docs of groups.values()) {
    const first = docs[0] as PurchaseDocInput;
    const sign = (d: PurchaseDocInput) => (d.kind === 'credit_note' ? -1 : 1);
    const sources: CertificateSource[] = docs
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((d) => ({
        id: d.id,
        docNumber: d.number,
        issueDate: d.date,
        base: round2(sign(d) * baseFor(d, opts.kind)),
        withheld: round2(sign(d) * withheldFor(d, opts.kind)),
      }));
    const base = round2(sources.reduce((s, x) => s + x.base, 0));
    const withheld = round2(sources.reduce((s, x) => s + x.withheld, 0));
    if (withheld <= 0) continue;

    const byConceptMap = new Map<string, { base: number; withheld: number }>();
    if (opts.kind === 'renta') {
      for (const d of docs) {
        const { concept } = resolveConcept(d);
        const label = concept
          ? WITHHOLDING_CONCEPT_LABEL[concept as WithholdingConcept]
          : 'Sin concepto';
        const cur = byConceptMap.get(label) ?? { base: 0, withheld: 0 };
        cur.base = round2(cur.base + sign(d) * baseFor(d, 'renta'));
        cur.withheld = round2(cur.withheld + sign(d) * d.retefuente);
        byConceptMap.set(label, cur);
      }
    }
    const byConcept = [...byConceptMap.entries()]
      .map(([concept, v]) => ({ concept, ...v }))
      .sort((a, b) => b.withheld - a.withheld);
    const concept =
      opts.kind === 'renta'
        ? (byConcept[0]?.concept ?? null)
        : opts.kind === 'iva'
          ? `${base > 0 ? `${Math.round((withheld / base) * 100)} % del IVA` : 'ReteIVA'}`
          : `${base > 0 ? `${((withheld / base) * 1000).toFixed(2).replace('.', ',')} por mil` : 'ReteICA'}`;
    out.push({
      kind: opts.kind,
      year: opts.year,
      period,
      supplierId: first.supplierId,
      supplierNit: first.supplierNit,
      supplierName: first.supplierName,
      concept,
      byConcept,
      base,
      withheld,
      sources,
    });
  }
  return out.sort(
    (a, b) => b.withheld - a.withheld || a.supplierName.localeCompare(b.supplierName),
  );
}

export function certificatePeriodLabel(c: Pick<WithholdingCertificate, 'year' | 'period'>): string {
  const names = ['ene–feb', 'mar–abr', 'may–jun', 'jul–ago', 'sep–oct', 'nov–dic'];
  return c.period
    ? `Bimestre ${c.period} (${names[c.period - 1]} ${c.year})`
    : `Año gravable ${c.year}`;
}

export function certificateFileName(c: WithholdingCertificate): string {
  const who = (c.supplierNit ?? c.supplierName).replace(/[^\w-]+/g, '-').slice(0, 40);
  return `certificado-${c.kind}-${c.year}${c.period ? `-b${c.period}` : ''}-${who}.pdf`;
}
