import type { PoBrand } from '../inventory/document';
import {
  A4,
  PdfDocument,
  type Rgb,
  fitText,
  hexToRgb,
  pdfImageFrom,
  tint,
  wrapText,
} from '../inventory/pdf';
import {
  CERTIFICATE_KIND_LABEL,
  type WithholdingCertificate,
  certificatePeriodLabel,
} from './certificates';
import { DRAFT_DISCLAIMER, type DraftFigures } from './draft-shape';

/**
 * LOS PAPELES DE IMPUESTOS CON LA MARCA DE LA EMPRESA (0197): el borrador de
 * una declaración (para el contador) y el certificado de retención (para el
 * proveedor). Puros: reciben las cifras y la marca (0170) y devuelven bytes.
 * Usan el mismo PDF hecho a mano de las órdenes de compra (inventory/pdf.ts).
 */

const INK: Rgb = [28, 30, 38];
const MUTED: Rgb = [102, 106, 120];
const AMBER: Rgb = [180, 83, 9];
const M = 48;
const W = A4.width - M * 2;

const cop = (n: number) => `$ ${Math.round(n).toLocaleString('es-CO')}`;

function longDate(day: string): string {
  const [y, m, d] = day.slice(0, 10).split('-').map(Number);
  const months = [
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
  return `${d} de ${months[(m ?? 1) - 1]} de ${y}`;
}

function header(
  doc: PdfDocument,
  brand: PoBrand,
  color: Rgb,
  hasImage: boolean,
  kicker: string,
  title: string,
  sub: string,
) {
  doc.rect(0, 0, A4.width, 6, color);
  let nameX = M;
  if (hasImage) {
    doc.drawImage(M, 30, 42, 42);
    nameX = M + 54;
  }
  doc.text(nameX, 52, fitText(brand.name, 15, 230, true), {
    size: 15,
    bold: true,
    color: hasImage ? INK : color,
  });
  doc.text(A4.width - M, 44, kicker, { size: 9, bold: true, color: MUTED, align: 'right' });
  doc.text(A4.width - M, 64, fitText(title, 15, 260, true), {
    size: 15,
    bold: true,
    color: INK,
    align: 'right',
  });
  doc.text(A4.width - M, 80, sub, { size: 9, color: MUTED, align: 'right' });
}

/** El borrador de una declaración: secciones, renglones y lo que falta. */
export function renderDraftPdf(
  f: DraftFigures,
  brand: PoBrand,
  extra: { issuedOn: string; statusLabel: string; nit?: string | null },
): Uint8Array {
  const doc = new PdfDocument();
  const color = hexToRgb(brand.primary);
  const image = pdfImageFrom(brand.logo);
  doc.setImage(image);
  const top = () => {
    header(
      doc,
      brand,
      color,
      Boolean(image),
      'BORRADOR PARA EL CONTADOR',
      f.title,
      `${extra.statusLabel} · ${longDate(extra.issuedOn)}`,
    );
    doc.rect(M, 98, W, 22, [254, 243, 199]);
    doc.text(M + 10, 113, `${DRAFT_DISCLAIMER}. Cortex no presenta nada ante la DIAN.`, {
      size: 9.5,
      bold: true,
      color: AMBER,
    });
  };
  top();
  let y = 140;
  doc.text(
    M,
    y,
    fitText(
      `Periodo: ${f.period.label} (${f.period.from} a ${f.period.to}) · ${f.basis}${extra.nit ? ` · NIT ${extra.nit}` : ''}`,
      9,
      W,
    ),
    { size: 9, color: MUTED },
  );
  y += 18;
  const ensure = (h: number) => {
    if (y + h > A4.height - 60) {
      doc.addPage();
      top();
      y = 140;
    }
  };
  for (const s of f.sections) {
    ensure(48);
    doc.rect(M, y, W, 20, tint(color, 0.88));
    doc.text(M + 8, y + 13.5, s.label.toUpperCase(), { size: 8, bold: true, color: MUTED });
    y += 20;
    for (const l of s.lines) {
      ensure(30);
      const rate = l.rate != null ? ` (${String(l.rate).replace('.', ',')} %)` : '';
      doc.text(M + 8, y + 14, fitText(`${l.label}${rate}`, 9.5, W - 170, Boolean(l.derived)), {
        size: 9.5,
        bold: Boolean(l.derived),
      });
      doc.text(A4.width - M - 8, y + 14, cop(l.amount), {
        size: 9.5,
        bold: Boolean(l.derived),
        align: 'right',
      });
      const meta = [
        l.sources.length
          ? `${l.sources.length} documento${l.sources.length === 1 ? '' : 's'}`
          : null,
        l.base != null && !l.derived ? `base ${cop(l.base)}` : null,
        l.needsConfirmation ? 'por confirmar' : null,
        l.formula && l.derived ? l.formula : null,
      ].filter(Boolean);
      if (meta.length) {
        doc.text(M + 8, y + 25, fitText(meta.join(' · '), 7.5, W - 170), {
          size: 7.5,
          color: l.needsConfirmation ? AMBER : MUTED,
        });
        y += 31;
      } else y += 22;
      doc.line(M, y, A4.width - M, y);
    }
    y += 10;
  }
  ensure(40);
  doc.rect(M, y, W, 1.2, color);
  y += 20;
  doc.text(M + 8, y, f.result.label, { size: 12, bold: true });
  doc.text(A4.width - M - 8, y, cop(Math.abs(f.result.amount)), {
    size: 13,
    bold: true,
    align: 'right',
  });
  y += 26;
  if (f.missing.length) {
    ensure(40);
    doc.text(M, y, 'DATOS QUE FALTAN', { size: 8, bold: true, color: AMBER });
    y += 14;
    for (const m of f.missing) {
      for (const line of wrapText(`• ${m.message}`, 9, W).slice(0, 4)) {
        ensure(14);
        doc.text(M, y, line, { size: 9 });
        y += 12;
      }
    }
    y += 6;
  }
  if (f.notes.length) {
    ensure(30);
    doc.text(M, y, 'NOTAS', { size: 8, bold: true, color: MUTED });
    y += 14;
    for (const n of f.notes)
      for (const line of wrapText(`• ${n}`, 8.5, W).slice(0, 4)) {
        ensure(13);
        doc.text(M, y, line, { size: 8.5, color: MUTED });
        y += 11;
      }
  }
  doc.text(
    M,
    A4.height - 28,
    fitText(
      `${brand.name} · ${f.title} · tarifas ${f.rulesVersion} · el detalle por documento está en Cortex › Impuestos`,
      7.5,
      W,
    ),
    { size: 7.5, color: MUTED },
  );
  return doc.toBytes({ title: `${f.title} (borrador)`, author: brand.name });
}

/** El certificado de retención para un proveedor. */
export function renderCertificatePdf(
  c: WithholdingCertificate,
  brand: PoBrand,
  issuer: { nit: string | null; dv: string | null; city: string | null; issuedOn: string },
): Uint8Array {
  const doc = new PdfDocument();
  const color = hexToRgb(brand.primary);
  const image = pdfImageFrom(brand.logo);
  doc.setImage(image);
  header(
    doc,
    brand,
    color,
    Boolean(image),
    'CERTIFICADO DE RETENCIÓN',
    CERTIFICATE_KIND_LABEL[c.kind].replace(/ \(.*\)$/, ''),
    certificatePeriodLabel(c),
  );
  let y = 118;
  doc.line(M, y - 8, A4.width - M, y - 8);
  doc.text(M, y + 6, 'AGENTE RETENEDOR', { size: 8, bold: true, color: MUTED });
  doc.text(M, y + 22, fitText(brand.name, 12, W / 2 - 10, true), { size: 12, bold: true });
  if (issuer.nit)
    doc.text(M, y + 37, `NIT ${issuer.nit}${issuer.dv ? `-${issuer.dv}` : ''}`, {
      size: 9,
      color: MUTED,
    });
  const cx = M + W / 2 + 10;
  doc.text(cx, y + 6, 'RETENIDO', { size: 8, bold: true, color: MUTED });
  doc.text(cx, y + 22, fitText(c.supplierName, 12, W / 2 - 10, true), { size: 12, bold: true });
  if (c.supplierNit) doc.text(cx, y + 37, `NIT / CC ${c.supplierNit}`, { size: 9, color: MUTED });

  y = 190;
  const rows: Array<[string, number, number]> =
    c.kind === 'renta' && c.byConcept.length
      ? c.byConcept.map((b) => [b.concept, b.base, b.withheld])
      : [[c.concept ?? CERTIFICATE_KIND_LABEL[c.kind], c.base, c.withheld]];
  doc.rect(M, y, W, 22, tint(color, 0.88));
  doc.text(M + 8, y + 14.5, 'CONCEPTO', { size: 8, bold: true, color: MUTED });
  doc.text(M + W * 0.72, y + 14.5, c.kind === 'iva' ? 'IVA (BASE)' : 'BASE', {
    size: 8,
    bold: true,
    color: MUTED,
    align: 'right',
  });
  doc.text(A4.width - M - 8, y + 14.5, 'VALOR RETENIDO', {
    size: 8,
    bold: true,
    color: MUTED,
    align: 'right',
  });
  y += 22;
  for (const [concept, base, withheld] of rows) {
    doc.text(M + 8, y + 15, fitText(concept, 9.5, W * 0.5), { size: 9.5 });
    doc.text(M + W * 0.72, y + 15, cop(base), { size: 9.5, align: 'right' });
    doc.text(A4.width - M - 8, y + 15, cop(withheld), { size: 9.5, align: 'right' });
    y += 24;
    doc.line(M, y, A4.width - M, y);
  }
  y += 18;
  doc.text(M + W * 0.5, y, 'Total retenido', { size: 11, bold: true });
  doc.text(A4.width - M - 8, y, cop(c.withheld), { size: 12, bold: true, align: 'right' });
  y += 30;
  doc.text(M, y, `FACTURAS INCLUIDAS (${c.sources.length})`, { size: 8, bold: true, color: MUTED });
  y += 14;
  for (const s of c.sources.slice(0, 28)) {
    doc.text(M, y, fitText(`${s.issueDate} · ${s.docNumber}`, 8.5, W * 0.5), {
      size: 8.5,
      color: MUTED,
    });
    doc.text(M + W * 0.72, y, cop(s.base), { size: 8.5, color: MUTED, align: 'right' });
    doc.text(A4.width - M - 8, y, cop(s.withheld), { size: 8.5, color: MUTED, align: 'right' });
    y += 12;
  }
  if (c.sources.length > 28) {
    doc.text(M, y, `… y ${c.sources.length - 28} facturas más.`, { size: 8.5, color: MUTED });
    y += 12;
  }
  const legal = [
    `Expedido el ${longDate(issuer.issuedOn)}${issuer.city ? ` en ${issuer.city}` : ''}, con base en las facturas registradas en la contabilidad del agente retenedor.`,
    'Las retenciones de renta e IVA se declaran ante la DIAN y las de ICA ante el municipio, en los plazos de ley, por el agente retenedor.',
    'Documento generado por computador a partir de los registros del agente retenedor.',
  ];
  let fy = A4.height - 100;
  for (const p of legal)
    for (const line of wrapText(p, 8, W)) {
      doc.text(M, fy, line, { size: 8, color: MUTED });
      fy += 10;
    }
  return doc.toBytes({ title: `Certificado de retención ${c.year}`, author: brand.name });
}
