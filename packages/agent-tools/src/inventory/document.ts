import type { SupabaseClient } from '@supabase/supabase-js';
import { getFile } from '../files/store';
import { gmailFetch } from '../gmail/client';
import type { ToolContext } from '../types';
import { A4, PdfDocument, type Rgb, fitText, hexToRgb, pdfImageFrom, tint, wrapText } from './pdf';
import type { PurchaseOrder } from './purchasing';
import { formatMoneyCop, formatQty } from './shape';

/**
 * LA ORDEN DE COMPRA COMO PAPEL: PDF CON LA MARCA Y CORREO AL PROVEEDOR (0183).
 *
 * La marca es la de 0170 (`company_branding`): nombre para mostrar, color
 * principal y logo (en `app_files`, bucket `branding`). Sin marca, el nombre
 * del espacio y el índigo de Cortex. El correo sale del Gmail de quien aprueba,
 * con el PDF adjunto: es una orden de la empresa, no de Cortex.
 */

export interface PoBrand {
  name: string;
  primary: string | null;
  logo: Uint8Array | null;
}

export async function loadPoBrand(db: SupabaseClient, organizationId: string): Promise<PoBrand> {
  const [branding, org] = await Promise.all([
    db
      .from('company_branding')
      .select('display_name, primary_color, logo_path, logo_version')
      .maybeSingle(),
    db.from('ba_organization').select('name').eq('id', organizationId).maybeSingle(),
  ]);
  const row = branding.error
    ? null
    : (branding.data as {
        display_name: string | null;
        primary_color: string | null;
        logo_path: string | null;
      } | null);
  const orgName = org.error ? null : ((org.data as { name?: string } | null)?.name ?? null);
  let logo: Uint8Array | null = null;
  if (row?.logo_path) {
    const file = await getFile(db, 'branding', row.logo_path).catch(() => null);
    logo = file?.content ?? null;
  }
  return {
    name: row?.display_name?.trim() || orgName?.trim() || 'Nuestra empresa',
    primary: row?.primary_color ?? null,
    logo,
  };
}

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

const INK: Rgb = [28, 30, 38];
const MUTED: Rgb = [102, 106, 120];

/** El PDF de la orden. Puro: recibe la orden y la marca, devuelve bytes. */
export function renderPurchaseOrderPdf(
  po: PurchaseOrder,
  brand: PoBrand,
  extra: { issuedOn: string; locationName?: string | null },
): Uint8Array {
  const doc = new PdfDocument();
  const color = hexToRgb(brand.primary);
  const image = pdfImageFrom(brand.logo);
  doc.setImage(image);
  const M = 48;
  const W = A4.width - M * 2;

  const header = () => {
    doc.rect(0, 0, A4.width, 6, color);
    let nameX = M;
    if (image) {
      const h = 42;
      const w = Math.min((image.width / image.height) * h, 150);
      const hh = (w / image.width) * image.height;
      doc.drawImage(M, 30, w, hh);
      nameX = M + w + 12;
    }
    doc.text(nameX, image ? 50 : 52, fitText(brand.name, 15, 230, true), {
      size: 15,
      bold: true,
      color: image ? INK : color,
    });
    doc.text(A4.width - M, 44, 'ORDEN DE COMPRA', {
      size: 9,
      bold: true,
      color: MUTED,
      align: 'right',
    });
    doc.text(A4.width - M, 64, po.label, { size: 18, bold: true, color: INK, align: 'right' });
    doc.text(A4.width - M, 80, `Fecha: ${longDate(extra.issuedOn)}`, {
      size: 9,
      color: MUTED,
      align: 'right',
    });
  };
  header();

  // Proveedor y entrega
  let y = 116;
  doc.line(M, y - 8, A4.width - M, y - 8);
  doc.text(M, y + 6, 'PROVEEDOR', { size: 8, bold: true, color: MUTED });
  doc.text(M, y + 22, fitText(po.supplierName, 12, W / 2 - 10, true), { size: 12, bold: true });
  let sy = y + 37;
  if (po.supplierTaxId) {
    doc.text(M, sy, `NIT ${po.supplierTaxId}`, { size: 9, color: MUTED });
    sy += 13;
  }
  if (po.supplierEmail) doc.text(M, sy, po.supplierEmail, { size: 9, color: MUTED });

  const cx = M + W / 2 + 10;
  doc.text(cx, y + 6, 'ENTREGA Y PAGO', { size: 8, bold: true, color: MUTED });
  const facts: string[] = [];
  if (extra.locationName) facts.push(`Entregar en: ${extra.locationName}`);
  if (po.expectedOn) facts.push(`Fecha esperada: ${longDate(po.expectedOn)}`);
  facts.push(`Plazo de pago: ${po.termsDays === 0 ? 'de contado' : `${po.termsDays} días`}`);
  facts.push(`Moneda: ${po.currency}`);
  facts.forEach((f, i) =>
    doc.text(cx, y + 22 + i * 13, fitText(f, 9.5, W / 2 - 10), { size: 9.5 }),
  );

  // Tabla
  y = 210;
  const cols = {
    n: M + 6,
    desc: M + 26,
    qty: M + W * 0.64,
    unit: M + W * 0.66,
    cost: M + W * 0.84,
    total: A4.width - M - 6,
  };
  const tableHeader = () => {
    doc.rect(M, y, W, 22, tint(color, 0.88));
    doc.text(cols.n, y + 14.5, '#', { size: 8, bold: true, color: MUTED });
    doc.text(cols.desc, y + 14.5, 'DESCRIPCIÓN', { size: 8, bold: true, color: MUTED });
    doc.text(cols.qty, y + 14.5, 'CANT.', { size: 8, bold: true, color: MUTED, align: 'right' });
    doc.text(cols.unit, y + 14.5, 'UND', { size: 8, bold: true, color: MUTED });
    doc.text(cols.cost, y + 14.5, 'COSTO UNIT.', {
      size: 8,
      bold: true,
      color: MUTED,
      align: 'right',
    });
    doc.text(cols.total, y + 14.5, 'TOTAL', { size: 8, bold: true, color: MUTED, align: 'right' });
    y += 22;
  };
  tableHeader();
  po.lines.forEach((l, i) => {
    if (y > A4.height - 170) {
      doc.addPage();
      header();
      y = 116;
      tableHeader();
    }
    const desc = fitText(l.description, 9.5, cols.qty - cols.desc - 40);
    doc.text(cols.n, y + 15, String(i + 1), { size: 9, color: MUTED });
    doc.text(cols.desc, y + 15, desc, { size: 9.5 });
    doc.text(cols.qty, y + 15, formatQty(l.qty), { size: 9.5, align: 'right' });
    doc.text(cols.unit, y + 15, fitText(l.unit, 8.5, 36), { size: 8.5, color: MUTED });
    doc.text(cols.cost, y + 15, formatMoneyCop(l.unitCost, po.currency), {
      size: 9.5,
      align: 'right',
    });
    doc.text(cols.total, y + 15, formatMoneyCop(l.lineTotal, po.currency), {
      size: 9.5,
      align: 'right',
    });
    if (l.taxRate > 0)
      doc.text(cols.desc, y + 26, `IVA ${formatQty(l.taxRate)} %`, { size: 7.5, color: MUTED });
    y += l.taxRate > 0 ? 32 : 24;
    doc.line(M, y, A4.width - M, y);
  });

  // Totales
  y += 18;
  const tx = A4.width - M - 180;
  const totalRow = (label: string, value: string, strong = false) => {
    doc.text(tx, y, label, { size: strong ? 11 : 9.5, bold: strong, color: strong ? INK : MUTED });
    doc.text(A4.width - M - 6, y, value, { size: strong ? 12 : 9.5, bold: strong, align: 'right' });
    y += strong ? 20 : 15;
  };
  totalRow('Subtotal', formatMoneyCop(po.subtotal, po.currency));
  if (po.taxTotal > 0) totalRow('IVA', formatMoneyCop(po.taxTotal, po.currency));
  doc.rect(tx - 8, y - 6, 180 + 8 + 6, 1.2, color);
  y += 10;
  totalRow('Total', formatMoneyCop(po.total, po.currency), true);

  if (po.notes) {
    y += 10;
    doc.text(M, y, 'NOTAS', { size: 8, bold: true, color: MUTED });
    y += 14;
    for (const line of wrapText(po.notes, 9.5, W).slice(0, 8)) {
      doc.text(M, y, line, { size: 9.5 });
      y += 13;
    }
  }

  // Pie
  const footer =
    'Por favor confirme la recepción de esta orden y la fecha de entrega respondiendo este correo. Al facturar, cite el número de la orden.';
  wrapText(footer, 8.5, W).forEach((line, i) =>
    doc.text(M, A4.height - 58 + i * 11, line, { size: 8.5, color: MUTED }),
  );
  doc.text(M, A4.height - 28, `${brand.name} · ${po.label}`, { size: 7.5, color: MUTED });

  return doc.toBytes({ title: `Orden de compra ${po.label}`, author: brand.name });
}

export function purchaseOrderFilename(po: PurchaseOrder): string {
  return `Orden-de-compra-${po.label}.pdf`;
}

/** El correo al proveedor: de usted, corto, con lo que tiene que hacer. */
export function purchaseOrderEmail(
  po: PurchaseOrder,
  brand: PoBrand,
  opts: { message?: string | null } = {},
): { subject: string; body: string } {
  const lines = po.lines
    .slice(0, 15)
    .map((l) => `  • ${formatQty(l.qty)} ${l.unit} — ${l.description}`);
  if (po.lines.length > 15) lines.push(`  • … y ${po.lines.length - 15} líneas más (ver PDF)`);
  return {
    subject: `Orden de compra ${po.label} — ${brand.name}`,
    body: [
      'Buen día:',
      '',
      `Adjuntamos la orden de compra ${po.label} por ${formatMoneyCop(po.total, po.currency)}${po.expectedOn ? `, con entrega esperada el ${longDate(po.expectedOn)}` : ''}.`,
      '',
      ...lines,
      '',
      ...(opts.message?.trim() ? [opts.message.trim(), ''] : []),
      'Le agradecemos confirmarnos el recibo de la orden y la fecha de entrega. Al facturar, por favor cite el número de la orden.',
      '',
      'Cordialmente,',
      brand.name,
    ].join('\n'),
  };
}

function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, 'utf-8').toString('base64')}?=`;
}

function base64Lines(bytes: Uint8Array): string {
  return (
    Buffer.from(bytes)
      .toString('base64')
      .match(/.{1,76}/g) ?? []
  ).join('\r\n');
}

/** El mensaje con el PDF adjunto (multipart/mixed). */
export function buildMimeWithAttachment(input: {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  filename: string;
  content: Uint8Array;
}): string {
  const boundary = `cortex-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const head = [
    `To: ${input.to.join(', ')}`,
    ...(input.cc?.length ? [`Cc: ${input.cc.join(', ')}`] : []),
    `Subject: ${encodeHeader(input.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];
  return [
    ...head,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(Buffer.from(input.body, 'utf-8')),
    `--${boundary}`,
    `Content-Type: application/pdf; name="${input.filename}"`,
    `Content-Disposition: attachment; filename="${input.filename}"`,
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(input.content),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

/** Enviar por el Gmail de quien aprueba. Lanza con el error de Google si falla. */
export async function sendPurchaseOrderEmail(
  ctx: Pick<ToolContext, 'integrations' | 'logger'> & Partial<ToolContext>,
  input: {
    to: string[];
    cc?: string[];
    subject: string;
    body: string;
    filename: string;
    content: Uint8Array;
  },
): Promise<{ messageId: string; threadId: string | null }> {
  const raw = Buffer.from(buildMimeWithAttachment(input), 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const r = await gmailFetch<{ id: string; threadId?: string }>(
    ctx as ToolContext,
    '/messages/send',
    {
      method: 'POST',
      body: JSON.stringify({ raw }),
    },
  );
  return { messageId: r.id, threadId: r.threadId ?? null };
}
