import { deflateSync, inflateSync } from 'node:zlib';
import { KIND_LABEL, type SalesDocumentRow, type SalesLineRow, documentNumber } from './shape';
import { TAX_RATE_LABEL, type TaxRate, displayTotal, documentTotals, formatMoney } from './totals';

/**
 * EL PDF DE UNA COTIZACIÓN (o pedido, o factura en borrador), CON LA MARCA DE
 * LA EMPRESA (migración 0182 + company_branding de 0170).
 *
 * Escrito a mano y sin dependencias, a propósito: el producto no tenía una
 * librería de PDF y un documento de una o dos páginas con texto, rectángulos y
 * un logo no la justifica. Usa las fuentes estándar de PDF (Helvetica y
 * Helvetica-Bold, que todo lector trae) con WinAnsiEncoding, que cubre el
 * español entero (á, é, ñ, ¿, ¡) y las comillas y rayas tipográficas.
 *
 * El logo: JPEG tal cual (DCTDecode) o PNG de 8 bits (gris, color o color con
 * transparencia, que va como máscara). Cualquier otro formato (WebP, PNG con
 * paleta o entrelazado) se omite y queda el nombre de la empresa: un PDF sin
 * logo es mejor que ningún PDF.
 *
 * Los totales salen de `documentTotals` sobre las líneas, la misma función que
 * usan la pantalla y la herramienta: el PDF no puede decir otra cifra.
 */

export interface PdfBrand {
  name: string;
  /** `#rrggbb` o null (= el índigo de Cortex). */
  primary: string | null;
  logo?: { bytes: Uint8Array; contentType: string } | null;
}

const PAGE_W = 612; // Carta, lo usual en Colombia.
const PAGE_H = 792;
const MARGIN = 44;
const CORTEX_PRIMARY = '#4338ca';

// Anchos de Helvetica y Helvetica-Bold (AFM estándar), de ' ' (32) a '~' (126).
const HELV = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const HELV_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667,
  611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556,
  278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/** Unicode → WinAnsi (un byte). Lo que no existe en WinAnsi sale como «?». */
const WIN_ANSI_EXTRA: Record<number, number> = {
  8364: 0x80,
  8230: 0x85,
  8216: 0x91,
  8217: 0x92,
  8220: 0x93,
  8221: 0x94,
  8226: 0x95,
  8211: 0x96,
  8212: 0x97,
  8482: 0x99,
  // El signo menos tipográfico (−) no existe en WinAnsi: sale como guion.
  8722: 0x2d,
};

export function winAnsi(text: string): number[] {
  const out: number[] = [];
  for (const ch of text.normalize('NFC')) {
    const cp = ch.codePointAt(0) ?? 63;
    if (cp === 0x2009 || cp === 0x202f || cp === 0xa0) out.push(32);
    else if ((cp >= 32 && cp <= 126) || (cp >= 160 && cp <= 255)) out.push(cp);
    else if (WIN_ANSI_EXTRA[cp]) out.push(WIN_ANSI_EXTRA[cp] as number);
    else if (cp === 9 || cp === 10 || cp === 13) out.push(32);
    else out.push(63);
  }
  return out;
}

/** Ancho aproximado en puntos. Las letras con tilde miden lo que su letra base. */
export function textWidth(text: string, size: number, bold = false): number {
  const table = bold ? HELV_BOLD : HELV;
  let units = 0;
  for (const ch of text.normalize('NFD').replace(/\p{M}/gu, '')) {
    const cp = ch.codePointAt(0) ?? 32;
    units += cp >= 32 && cp <= 126 ? (table[cp - 32] ?? 556) : 556;
  }
  return (units * size) / 1000;
}

/** Corta un texto en renglones que caben en `width`. */
export function wrapText(text: string, width: number, size: number, bold = false): string[] {
  const out: string[] = [];
  for (const paragraph of text.replace(/\r/g, '').split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (textWidth(candidate, size, bold) <= width) line = candidate;
      else {
        if (line) out.push(line);
        // Una palabra más larga que el renglón se parte a la fuerza.
        let rest = word;
        while (textWidth(rest, size, bold) > width && rest.length > 1) {
          let cut = rest.length - 1;
          while (cut > 1 && textWidth(rest.slice(0, cut), size, bold) > width) cut--;
          out.push(rest.slice(0, cut));
          rest = rest.slice(cut);
        }
        line = rest;
      }
    }
    out.push(line);
  }
  return out;
}

function pdfString(text: string): string {
  return `(${winAnsi(text)
    .map((b) => {
      if (b === 40 || b === 41 || b === 92) return `\\${String.fromCharCode(b)}`;
      if (b < 32 || b > 126) return `\\${b.toString(8).padStart(3, '0')}`;
      return String.fromCharCode(b);
    })
    .join('')})`;
}

function rgb(hex: string | null | undefined): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  const v = m ? Number.parseInt(m[1] as string, 16) : Number.parseInt(CORTEX_PRIMARY.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

const fmt = (n: number) => (Math.round(n * 100) / 100).toString();

// ---------------------------------------------------------------------------
// Imágenes
// ---------------------------------------------------------------------------

interface PdfImage {
  width: number;
  height: number;
  /** Diccionario sin `/Length`, y los bytes del flujo. */
  dict: string;
  data: Uint8Array;
  mask?: { dict: string; data: Uint8Array };
}

export function jpegInfo(
  bytes: Uint8Array,
): { width: number; height: number; components: number } | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1] as number;
    const len = ((bytes[i + 2] as number) << 8) | (bytes[i + 3] as number);
    // SOF0..SOF15 salvo DHT (C4), JPG (C8) y DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = ((bytes[i + 5] as number) << 8) | (bytes[i + 6] as number);
      const width = ((bytes[i + 7] as number) << 8) | (bytes[i + 8] as number);
      return { width, height, components: bytes[i + 9] as number };
    }
    i += 2 + len;
  }
  return null;
}

function u32(b: Uint8Array, at: number): number {
  return (
    (((b[at] as number) << 24) >>> 0) +
    ((b[at + 1] as number) << 16) +
    ((b[at + 2] as number) << 8) +
    (b[at + 3] as number)
  );
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** PNG de 8 bits, sin entrelazar, en gris (0), color (2) o color con alfa (6). */
export function pngToPdfImage(bytes: Uint8Array): PdfImage | null {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!sig.every((v, i) => bytes[i] === v)) return null;
  let at = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  let bitDepth = 0;
  let interlace = 0;
  const idat: Uint8Array[] = [];
  while (at + 8 <= bytes.length) {
    const len = u32(bytes, at);
    const type = String.fromCharCode(...bytes.slice(at + 4, at + 8));
    const data = bytes.slice(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      width = u32(data, 0);
      height = u32(data, 4);
      bitDepth = data[8] as number;
      colorType = data[9] as number;
      interlace = data[12] as number;
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    at += 12 + len;
  }
  if (!width || !height || bitDepth !== 8 || interlace !== 0) return null;
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  if (!channels) return null;
  const total = idat.reduce((n, c) => n + c.length, 0);
  const joined = new Uint8Array(total);
  let off = 0;
  for (const c of idat) {
    joined.set(c, off);
    off += c.length;
  }
  if (colorType !== 6) {
    // Sin alfa: el flujo de PNG se pasa tal cual, con su predictor.
    return {
      width,
      height,
      dict: `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /${channels === 1 ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent 8 /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors ${channels} /BitsPerComponent 8 /Columns ${width} >>`,
      data: joined,
    };
  }
  // Con alfa: se deshacen los filtros y se separa la transparencia en una máscara.
  const raw = new Uint8Array(inflateSync(joined));
  const stride = width * 4;
  const color = new Uint8Array(width * height * 3);
  const alpha = new Uint8Array(width * height);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] as number;
    const line = raw.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? (line[x - 4] as number) : 0;
      const b = prev[x] as number;
      const c = x >= 4 ? (prev[x - 4] as number) : 0;
      const v = line[x] as number;
      line[x] =
        filter === 1
          ? (v + a) & 255
          : filter === 2
            ? (v + b) & 255
            : filter === 3
              ? (v + ((a + b) >> 1)) & 255
              : filter === 4
                ? (v + paeth(a, b, c)) & 255
                : v;
    }
    for (let x = 0; x < width; x++) {
      color[(y * width + x) * 3] = line[x * 4] as number;
      color[(y * width + x) * 3 + 1] = line[x * 4 + 1] as number;
      color[(y * width + x) * 3 + 2] = line[x * 4 + 2] as number;
      alpha[y * width + x] = line[x * 4 + 3] as number;
    }
    prev = line;
  }
  return {
    width,
    height,
    dict: `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`,
    data: new Uint8Array(deflateSync(color)),
    mask: {
      dict: `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`,
      data: new Uint8Array(deflateSync(alpha)),
    },
  };
}

function imageFrom(logo: PdfBrand['logo']): PdfImage | null {
  if (!logo?.bytes?.length) return null;
  try {
    if (logo.contentType === 'image/jpeg') {
      const info = jpegInfo(logo.bytes);
      if (!info) return null;
      const space =
        info.components === 1 ? 'DeviceGray' : info.components === 4 ? 'DeviceCMYK' : 'DeviceRGB';
      return {
        width: info.width,
        height: info.height,
        dict: `/Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} /ColorSpace /${space} /BitsPerComponent 8 /Filter /DCTDecode`,
        data: logo.bytes,
      };
    }
    if (logo.contentType === 'image/png') return pngToPdfImage(logo.bytes);
  } catch {
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------

class Canvas {
  pages: string[][] = [[]];
  get ops() {
    return this.pages[this.pages.length - 1] as string[];
  }
  newPage() {
    this.pages.push([]);
  }
  text(
    x: number,
    y: number,
    text: string,
    size: number,
    opts: { bold?: boolean; color?: [number, number, number]; align?: 'left' | 'right' } = {},
  ) {
    const width = textWidth(text, size, opts.bold);
    const left = opts.align === 'right' ? x - width : x;
    const [r, g, b] = opts.color ?? [0.12, 0.13, 0.16];
    this.ops.push(
      `BT ${fmt(r)} ${fmt(g)} ${fmt(b)} rg /${opts.bold ? 'F2' : 'F1'} ${size} Tf ${fmt(left)} ${fmt(y)} Td ${pdfString(text)} Tj ET`,
    );
  }
  rect(x: number, y: number, w: number, h: number, color: [number, number, number]) {
    this.ops.push(
      `${fmt(color[0])} ${fmt(color[1])} ${fmt(color[2])} rg ${fmt(x)} ${fmt(y)} ${fmt(w)} ${fmt(h)} re f`,
    );
  }
  line(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: [number, number, number] = [0.85, 0.86, 0.89],
  ) {
    this.ops.push(
      `${fmt(color[0])} ${fmt(color[1])} ${fmt(color[2])} RG 0.6 w ${fmt(x1)} ${fmt(y1)} m ${fmt(x2)} ${fmt(y2)} l S`,
    );
  }
  image(name: string, x: number, y: number, w: number, h: number) {
    this.ops.push(`q ${fmt(w)} 0 0 ${fmt(h)} ${fmt(x)} ${fmt(y)} cm /${name} Do Q`);
  }
}

function longDate(iso: string | null | undefined): string {
  if (!iso) return '—';
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
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d} de ${months[(m ?? 1) - 1]} de ${y}`;
}

const qty = (n: number) => new Intl.NumberFormat('es-CO', { maximumFractionDigits: 4 }).format(n);

export function renderSalesPdf(input: {
  doc: SalesDocumentRow;
  lines: SalesLineRow[];
  brand: PdfBrand;
}): Uint8Array {
  const { doc, lines, brand } = input;
  const primary = rgb(brand.primary);
  const muted: [number, number, number] = [0.42, 0.44, 0.5];
  const white: [number, number, number] = [1, 1, 1];
  const soft: [number, number, number] = [
    1 - (1 - primary[0]) * 0.08,
    1 - (1 - primary[1]) * 0.08,
    1 - (1 - primary[2]) * 0.08,
  ];
  const image = imageFrom(brand.logo);
  const c = new Canvas();
  const right = PAGE_W - MARGIN;
  const title = (
    doc.kind === 'invoice' ? 'Factura (borrador)' : KIND_LABEL[doc.kind].one
  ).toUpperCase();
  const number = documentNumber(doc);

  const header = (first: boolean) => {
    c.rect(0, PAGE_H - 8, PAGE_W, 8, primary);
    let y = PAGE_H - 44;
    let nameX = MARGIN;
    if (image && first) {
      const h = 40;
      const w = Math.min((image.width / image.height) * h, 160);
      c.image('Im1', MARGIN, y - h + 14, w, (w / ((image.width / image.height) * h)) * h);
      nameX = MARGIN + w + 12;
    }
    c.text(nameX, y, brand.name.slice(0, 60), first ? 15 : 11, { bold: true });
    c.text(right, y, title, first ? 16 : 11, { bold: true, color: primary, align: 'right' });
    y -= 18;
    c.text(right, y, number, 11, { bold: true, align: 'right' });
    return y;
  };

  let y = header(true);
  y -= 16;
  c.text(right, y, `Fecha: ${longDate(doc.issue_date)}`, 9, { color: muted, align: 'right' });
  if (doc.kind === 'quote' && doc.valid_until) {
    y -= 13;
    c.text(right, y, `Válida hasta: ${longDate(doc.valid_until)}`, 9, {
      color: muted,
      align: 'right',
    });
  }

  // Para quién
  let cy = PAGE_H - 96;
  c.text(MARGIN, cy, 'PARA', 8, { bold: true, color: muted });
  cy -= 15;
  c.text(MARGIN, cy, doc.client_name.slice(0, 70), 12, { bold: true });
  for (const bit of [
    doc.client_tax_id ? `NIT ${doc.client_tax_id}` : null,
    doc.contact_name ? `Atención: ${doc.contact_name}` : null,
    doc.client_email,
  ]) {
    if (!bit) continue;
    cy -= 13;
    c.text(MARGIN, cy, bit.slice(0, 80), 9, { color: muted });
  }
  y = Math.min(y, cy) - 26;

  // Tabla
  const col = { desc: MARGIN + 8, qty: 360, price: 444, tax: 502, total: right - 8 };
  const descWidth = col.qty - col.desc - 40;
  const tableHeader = () => {
    c.rect(MARGIN, y - 6, right - MARGIN, 20, primary);
    c.text(col.desc, y, 'Descripción', 8.5, { bold: true, color: white });
    c.text(col.qty, y, 'Cant.', 8.5, { bold: true, color: white, align: 'right' });
    c.text(col.price, y, 'Precio unit.', 8.5, { bold: true, color: white, align: 'right' });
    c.text(col.tax, y, 'IVA', 8.5, { bold: true, color: white, align: 'right' });
    c.text(col.total, y, 'Total', 8.5, { bold: true, color: white, align: 'right' });
    y -= 22;
  };
  tableHeader();

  const totals = documentTotals(
    lines.map((l) => ({
      quantity: l.quantity,
      unitPrice: l.unit_price,
      discountPct: l.discount_pct,
      taxRate: l.tax_rate,
    })),
    {
      retefuentePct: Number(doc.withholdings?.retefuente_pct ?? 0),
      reteicaPerMil: Number(doc.withholdings?.reteica_per_mil ?? 0),
      reteivaPct: Number(doc.withholdings?.reteiva_pct ?? 0),
    },
  );
  const taxShort: Record<TaxRate, string> = {
    iva_19: '19 %',
    iva_5: '5 %',
    iva_0: '0 %',
    excluido: 'Excl.',
  };

  lines.forEach((line, i) => {
    const descLines = wrapText(line.description, descWidth, 9.5);
    const extra = [
      line.product_code ? `Cód. ${line.product_code}` : null,
      line.discount_pct > 0 ? `Descuento ${qty(line.discount_pct)} %` : null,
    ].filter(Boolean) as string[];
    const rowHeight = descLines.length * 12 + (extra.length ? 11 : 0) + 8;
    if (y - rowHeight < 150) {
      c.newPage();
      y = header(false) - 30;
      tableHeader();
    }
    if (i % 2 === 1) c.rect(MARGIN, y - rowHeight + 12, right - MARGIN, rowHeight, soft);
    descLines.forEach((t, j) => c.text(col.desc, y - j * 12, t, 9.5));
    if (extra.length)
      c.text(col.desc, y - descLines.length * 12, extra.join(' · '), 7.5, { color: muted });
    c.text(col.qty, y, `${qty(line.quantity)}${line.unit ? ` ${line.unit}` : ''}`, 9.5, {
      align: 'right',
    });
    c.text(col.price, y, formatMoney(line.unit_price, doc.currency), 9.5, { align: 'right' });
    c.text(col.tax, y, taxShort[line.tax_rate] ?? '', 9.5, { align: 'right', color: muted });
    c.text(col.total, y, formatMoney(totals.lines[i]?.lineTotal ?? 0, doc.currency), 9.5, {
      align: 'right',
      bold: true,
    });
    y -= rowHeight;
  });
  c.line(MARGIN, y + 8, right, y + 8);

  // Totales
  if (y < 230) {
    c.newPage();
    y = header(false) - 40;
  }
  y -= 12;
  const labelX = 420;
  const row = (
    label: string,
    value: string,
    opts: { bold?: boolean; color?: [number, number, number]; size?: number } = {},
  ) => {
    c.text(labelX, y, label, opts.size ?? 9.5, {
      align: 'right',
      color: opts.color ?? muted,
      bold: opts.bold,
    });
    c.text(col.total, y, value, opts.size ?? 9.5, {
      align: 'right',
      bold: opts.bold,
      color: opts.color,
    });
    y -= (opts.size ?? 9.5) + 6;
  };
  row('Subtotal', formatMoney(totals.subtotal, doc.currency));
  if (totals.discountTotal > 0)
    row('Descuentos', `−${formatMoney(totals.discountTotal, doc.currency)}`);
  for (const r of totals.ivaByRate)
    if (r.rate !== 'excluido')
      row(
        `${TAX_RATE_LABEL[r.rate]} (base ${formatMoney(r.base, doc.currency)})`,
        formatMoney(r.iva, doc.currency),
      );
  const shown = displayTotal(totals.total, doc.currency);
  if (shown.rounding !== 0) row('Ajuste al peso', formatMoney(shown.rounding, doc.currency));
  y -= 8;
  c.rect(labelX - 110, y - 7, right - labelX + 110, 24, soft);
  row('Total', formatMoney(shown.value, doc.currency), { bold: true, size: 12, color: primary });
  if (totals.withholdingTotal > 0) {
    y -= 2;
    if (totals.retefuente > 0)
      row('Retención en la fuente (estimada)', `−${formatMoney(totals.retefuente, doc.currency)}`);
    if (totals.reteica > 0)
      row('ReteICA (estimada)', `−${formatMoney(totals.reteica, doc.currency)}`);
    if (totals.reteiva > 0)
      row('ReteIVA (estimada)', `−${formatMoney(totals.reteiva, doc.currency)}`);
    row('Neto estimado a recibir', formatMoney(totals.netTotal, doc.currency), { bold: true });
  }

  // Condiciones y notas
  const blocks: Array<[string, string]> = [];
  blocks.push([
    'Forma de pago',
    doc.payment_form === 'contado' ? 'De contado.' : `A crédito, ${doc.payment_days} días.`,
  ]);
  if (doc.notes) blocks.push(['Notas', doc.notes]);
  if (doc.terms) blocks.push(['Condiciones', doc.terms]);
  y -= 10;
  for (const [label, body] of blocks) {
    const wrapped = wrapText(body, right - MARGIN, 9);
    if (y - wrapped.length * 12 - 20 < 60) {
      c.newPage();
      y = header(false) - 40;
    }
    c.text(MARGIN, y, label.toUpperCase(), 8, { bold: true, color: muted });
    y -= 13;
    for (const t of wrapped.slice(0, 40)) {
      c.text(MARGIN, y, t, 9);
      y -= 12;
    }
    y -= 8;
  }

  // Pie en cada página
  const pageCount = c.pages.length;
  c.pages.forEach((ops, i) => {
    const footer = `${brand.name} · ${number}${doc.kind === 'quote' ? ' · Esta cotización no es una factura.' : doc.kind === 'invoice' ? ' · Borrador: no es una factura electrónica.' : ''}`;
    ops.push(
      `BT ${fmt(muted[0])} ${fmt(muted[1])} ${fmt(muted[2])} rg /F1 7.5 Tf ${MARGIN} 28 Td ${pdfString(footer.slice(0, 140))} Tj ET`,
    );
    const pageLabel = `Página ${i + 1} de ${pageCount}`;
    ops.push(
      `BT ${fmt(muted[0])} ${fmt(muted[1])} ${fmt(muted[2])} rg /F1 7.5 Tf ${fmt(right - textWidth(pageLabel, 7.5))} 28 Td ${pdfString(pageLabel)} Tj ET`,
    );
  });

  return assemble(c.pages, image, `${title} ${number}`);
}

function assemble(pages: string[][], image: PdfImage | null, title: string): Uint8Array {
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (bytes: Uint8Array) => {
    chunks.push(bytes);
    length += bytes.length;
  };
  const ascii = (s: string) => Uint8Array.from(winAnsi(s));
  const raw = (s: string) => Uint8Array.from([...s].map((ch) => ch.charCodeAt(0) & 255));
  const object = (id: number, body: string, stream?: Uint8Array) => {
    offsets[id] = length;
    if (stream) {
      push(raw(`${id} 0 obj\n<< ${body} /Length ${stream.length} >>\nstream\n`));
      push(stream);
      push(raw('\nendstream\nendobj\n'));
    } else push(raw(`${id} 0 obj\n${body}\nendobj\n`));
  };

  push(raw('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'));
  // 1 catálogo, 2 páginas, 3 Helvetica, 4 Helvetica-Bold, 5 info, 6 imagen, 7 máscara, 8… páginas.
  const firstPage = 8;
  const pageIds = pages.map((_, i) => firstPage + i * 2);
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(
    2,
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`,
  );
  object(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  object(
    4,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  );
  offsets[5] = length;
  push(raw('5 0 obj\n<< /Producer (Cortex) /Title '));
  push(ascii(pdfString(title)).map((b) => b));
  push(raw(' >>\nendobj\n'));
  if (image?.mask) object(7, image.mask.dict, image.mask.data);
  else object(7, '<< >>');
  if (image) object(6, `${image.dict}${image.mask ? ' /SMask 7 0 R' : ''}`, image.data);
  else object(6, '<< >>');
  pages.forEach((ops, i) => {
    const pageId = pageIds[i] as number;
    const resources = `<< /Font << /F1 3 0 R /F2 4 0 R >>${image && i === 0 ? ' /XObject << /Im1 6 0 R >>' : ''} >>`;
    object(
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources ${resources} /Contents ${pageId + 1} 0 R >>`,
    );
    object(pageId + 1, '', raw(ops.join('\n')));
  });
  const count = firstPage + pages.length * 2;
  const xrefAt = length;
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let id = 1; id < count; id++)
    xref += `${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`;
  push(
    raw(
      `${xref}trailer\n<< /Size ${count} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`,
    ),
  );

  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
