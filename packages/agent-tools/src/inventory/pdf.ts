import { deflateSync, inflateSync } from 'node:zlib';

/**
 * UN PDF SIN LIBRERÍAS (migración 0183).
 *
 * La orden de compra sale como PDF con la marca de la empresa (0170): logo,
 * color y nombre. El paquete no tiene un generador de PDF y una orden de compra
 * no lo necesita: texto en Helvetica, rectángulos y una imagen. Esto escribe
 * PDF 1.4 a mano — objetos, tabla de referencias, tráiler — con:
 *
 *   - texto en WinAnsi (tildes, eñes, «», ¿ y €), con anchos de Helvetica
 *     para alinear cifras a la derecha;
 *   - rectángulos de color;
 *   - el logo: JPEG tal cual (DCTDecode); PNG sin transparencia tal cual
 *     (FlateDecode con predictor); PNG con transparencia, aplanado sobre
 *     blanco. WebP no se puede dibujar sin decodificarlo: la orden sale con el
 *     nombre de la empresa en su color, sin logo.
 *
 * Coordenadas en puntos, origen ARRIBA a la izquierda (se invierten al
 * escribir), página A4.
 */

export const A4 = { width: 595.28, height: 841.89 } as const;

export type Rgb = [number, number, number];

type Op =
  | { t: 'text'; x: number; y: number; size: number; bold: boolean; color: Rgb; text: string }
  | { t: 'rect'; x: number; y: number; w: number; h: number; fill: Rgb }
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number; color: Rgb; width: number }
  | { t: 'image'; x: number; y: number; w: number; h: number };

export interface PdfImage {
  width: number;
  height: number;
  /** El diccionario del XObject sin `/Length` y los bytes del stream. */
  dict: string;
  data: Uint8Array;
}

// ---------------------------------------------------------------------------
// Texto: WinAnsi y anchos
// ---------------------------------------------------------------------------

/** Anchos de Helvetica (AFM) para 32–126, en milésimas de em. */
const HELVETICA: number[] = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

/** Lo que WinAnsi pone fuera de Latin-1 (0x80–0x9F). */
const WIN_ANSI_EXTRA: Record<string, number> = {
  '€': 0x80,
  '‚': 0x82,
  '„': 0x84,
  '…': 0x85,
  '•': 0x95,
  '–': 0x96,
  '—': 0x97,
  '‘': 0x91,
  '’': 0x92,
  '“': 0x93,
  '”': 0x94,
  '™': 0x99,
};

export function toWinAnsi(text: string): number[] {
  const out: number[] = [];
  for (const ch of text.normalize('NFC')) {
    const code = ch.codePointAt(0) ?? 63;
    if (WIN_ANSI_EXTRA[ch] !== undefined) out.push(WIN_ANSI_EXTRA[ch] as number);
    else if (code === 0x2009 || code === 0x202f || code === 0xa0) out.push(32);
    else if (code >= 32 && code <= 126) out.push(code);
    else if (code >= 0xa1 && code <= 0xff) out.push(code);
    else out.push(63);
  }
  return out;
}

function charWidth(code: number): number {
  if (code >= 32 && code <= 126) return HELVETICA[code - 32] ?? 556;
  // Letras con tilde: el ancho de su base (aprox.).
  if (code >= 0xc0 && code <= 0xff) {
    const base = String.fromCharCode(code).normalize('NFD')[0] ?? 'a';
    const b = base.charCodeAt(0);
    return b >= 32 && b <= 126 ? (HELVETICA[b - 32] ?? 556) : 556;
  }
  return code === 0x97 ? 1000 : 556;
}

export function textWidth(text: string, size: number, bold = false): number {
  const em = toWinAnsi(text).reduce((s, c) => s + charWidth(c), 0);
  return (em / 1000) * size * (bold ? 1.06 : 1);
}

/** Cortar a un ancho, con «…». */
export function fitText(text: string, size: number, maxWidth: number, bold = false): string {
  if (textWidth(text, size, bold) <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && textWidth(`${t}…`, size, bold) > maxWidth) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

/** Partir en líneas que quepan. */
export function wrapText(text: string, size: number, maxWidth: number, bold = false): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (textWidth(next, size, bold) <= maxWidth || !line) line = next;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

function pdfString(text: string): string {
  const bytes = toWinAnsi(text);
  let out = '(';
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += `\\${String.fromCharCode(b)}`;
    else if (b < 32 || b > 126) out += `\\${b.toString(8).padStart(3, '0')}`;
    else out += String.fromCharCode(b);
  }
  return `${out})`;
}

const n = (v: number) => (Math.round(v * 100) / 100).toString();
const rgb = (c: Rgb) => c.map((v) => n(v / 255)).join(' ');

// ---------------------------------------------------------------------------
// Imágenes
// ---------------------------------------------------------------------------

function jpegImage(bytes: Uint8Array): PdfImage | null {
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1] as number;
    const len = ((bytes[i + 2] as number) << 8) | (bytes[i + 3] as number);
    // SOF0..SOF15 salvo DHT (C4), JPG (C8) y DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      const height = ((bytes[i + 5] as number) << 8) | (bytes[i + 6] as number);
      const width = ((bytes[i + 7] as number) << 8) | (bytes[i + 8] as number);
      const comps = bytes[i + 9] as number;
      const space =
        comps === 1
          ? '/DeviceGray'
          : comps === 4
            ? '/DeviceCMYK /Decode [1 0 1 0 1 0 1 0]'
            : '/DeviceRGB';
      return {
        width,
        height,
        dict: `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace ${space} /BitsPerComponent 8 /Filter /DCTDecode`,
        data: bytes,
      };
    }
    i += 2 + len;
  }
  return null;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function pngImage(bytes: Uint8Array): PdfImage | null {
  const view = Buffer.from(bytes);
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  while (pos + 8 <= view.length) {
    const len = view.readUInt32BE(pos);
    const type = view.toString('latin1', pos + 4, pos + 8);
    const body = view.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8] as number;
      colorType = body[9] as number;
      interlace = body[12] as number;
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!width || !height || depth !== 8 || interlace !== 0) return null;
  const compressed = Buffer.concat(idat);
  if (colorType === 0 || colorType === 2) {
    const colors = colorType === 2 ? 3 : 1;
    return {
      width,
      height,
      dict: `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace ${colors === 3 ? '/DeviceRGB' : '/DeviceGray'} /BitsPerComponent 8 /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors ${colors} /BitsPerComponent 8 /Columns ${width} >>`,
      data: compressed,
    };
  }
  if (colorType !== 6 && colorType !== 4) return null;
  // Con transparencia: quitar los filtros de cada fila y aplanar sobre blanco.
  const channels = colorType === 6 ? 4 : 2;
  const stride = width * channels;
  const raw = inflateSync(compressed);
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] as number;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[src + x] as number;
      const left = x >= channels ? (pixels[dst + x - channels] as number) : 0;
      const up = y > 0 ? (pixels[dst - stride + x] as number) : 0;
      const upLeft = y > 0 && x >= channels ? (pixels[dst - stride + x - channels] as number) : 0;
      const predicted =
        filter === 1
          ? left
          : filter === 2
            ? up
            : filter === 3
              ? (left + up) >> 1
              : filter === 4
                ? paeth(left, up, upLeft)
                : 0;
      pixels[dst + x] = (value + predicted) & 0xff;
    }
  }
  const colors = colorType === 6 ? 3 : 1;
  const flat = Buffer.alloc(width * height * colors);
  for (let p = 0; p < width * height; p++) {
    const alpha = (pixels[p * channels + channels - 1] as number) / 255;
    for (let c = 0; c < colors; c++) {
      const v = pixels[p * channels + c] as number;
      flat[p * colors + c] = Math.round(v * alpha + 255 * (1 - alpha));
    }
  }
  return {
    width,
    height,
    dict: `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace ${colors === 3 ? '/DeviceRGB' : '/DeviceGray'} /BitsPerComponent 8 /Filter /FlateDecode`,
    data: deflateSync(flat),
  };
}

/** El logo como imagen de PDF, o null si no se puede dibujar. Nunca lanza. */
export function pdfImageFrom(bytes: Uint8Array | null | undefined): PdfImage | null {
  if (!bytes || bytes.length < 16) return null;
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegImage(bytes);
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
      return pngImage(bytes);
  } catch {
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// El documento
// ---------------------------------------------------------------------------

export class PdfDocument {
  private pages: Op[][] = [[]];
  private image: PdfImage | null = null;

  get page(): number {
    return this.pages.length;
  }

  addPage(): void {
    this.pages.push([]);
  }

  private get ops(): Op[] {
    return this.pages[this.pages.length - 1] as Op[];
  }

  text(
    x: number,
    y: number,
    text: string,
    opts: { size?: number; bold?: boolean; color?: Rgb; align?: 'left' | 'right' } = {},
  ): void {
    const size = opts.size ?? 10;
    const bold = opts.bold ?? false;
    const left = opts.align === 'right' ? x - textWidth(text, size, bold) : x;
    this.ops.push({ t: 'text', x: left, y, size, bold, color: opts.color ?? [33, 33, 40], text });
  }

  rect(x: number, y: number, w: number, h: number, fill: Rgb): void {
    this.ops.push({ t: 'rect', x, y, w, h, fill });
  }

  line(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: Rgb = [220, 222, 228],
    width = 0.6,
  ): void {
    this.ops.push({ t: 'line', x1, y1, x2, y2, color, width });
  }

  /** Una sola imagen por documento (el logo); se puede dibujar en cada página. */
  setImage(image: PdfImage | null): void {
    this.image = image;
  }

  drawImage(x: number, y: number, w: number, h: number): void {
    if (this.image) this.ops.push({ t: 'image', x, y, w, h });
  }

  private content(ops: Op[]): string {
    const H = A4.height;
    const out: string[] = [];
    for (const op of ops) {
      if (op.t === 'rect')
        out.push(`${rgb(op.fill)} rg ${n(op.x)} ${n(H - op.y - op.h)} ${n(op.w)} ${n(op.h)} re f`);
      else if (op.t === 'line')
        out.push(
          `${rgb(op.color)} RG ${n(op.width)} w ${n(op.x1)} ${n(H - op.y1)} m ${n(op.x2)} ${n(H - op.y2)} l S`,
        );
      else if (op.t === 'image')
        out.push(`q ${n(op.w)} 0 0 ${n(op.h)} ${n(op.x)} ${n(H - op.y - op.h)} cm /Im1 Do Q`);
      else
        out.push(
          `BT /${op.bold ? 'F2' : 'F1'} ${n(op.size)} Tf ${rgb(op.color)} rg ${n(op.x)} ${n(H - op.y)} Td ${pdfString(op.text)} Tj ET`,
        );
    }
    return out.join('\n');
  }

  toBytes(info: { title?: string; author?: string } = {}): Uint8Array {
    const objects: Array<string | { dict: string; data: Uint8Array }> = [];
    const add = (o: string | { dict: string; data: Uint8Array }) => {
      objects.push(o);
      return objects.length;
    };
    const catalog = add('');
    const pagesId = add('');
    const font1 = add(
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    );
    const font2 = add(
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    );
    const imageId = this.image ? add({ dict: this.image.dict, data: this.image.data }) : null;
    const pageIds: number[] = [];
    for (const ops of this.pages) {
      const stream = Buffer.from(this.content(ops), 'latin1');
      const contentId = add({ dict: '', data: stream });
      const resources = `<< /Font << /F1 ${font1} 0 R /F2 ${font2} 0 R >>${imageId ? ` /XObject << /Im1 ${imageId} 0 R >>` : ''} >>`;
      pageIds.push(
        add(
          `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${n(A4.width)} ${n(A4.height)}] /Resources ${resources} /Contents ${contentId} 0 R >>`,
        ),
      );
    }
    objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
    objects[pagesId - 1] =
      `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
    const infoId = add(
      `<< /Producer (Cortex)${info.title ? ` /Title ${pdfString(info.title)}` : ''}${info.author ? ` /Author ${pdfString(info.author)}` : ''} >>`,
    );

    const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    let offset = chunks[0]?.length ?? 0;
    const offsets: number[] = [];
    objects.forEach((o, i) => {
      offsets.push(offset);
      const head = `${i + 1} 0 obj\n`;
      let body: Buffer;
      if (typeof o === 'string') body = Buffer.from(`${head}${o}\nendobj\n`, 'latin1');
      else
        body = Buffer.concat([
          Buffer.from(`${head}<< ${o.dict} /Length ${o.data.length} >>\nstream\n`, 'latin1'),
          Buffer.from(o.data),
          Buffer.from('\nendstream\nendobj\n', 'latin1'),
        ]);
      chunks.push(body);
      offset += body.length;
    });
    const xref = [
      'xref',
      `0 ${objects.length + 1}`,
      '0000000000 65535 f ',
      ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `),
      'trailer',
      `<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${infoId} 0 R >>`,
      'startxref',
      String(offset),
      '%%EOF',
    ].join('\n');
    chunks.push(Buffer.from(`${xref}\n`, 'latin1'));
    return new Uint8Array(Buffer.concat(chunks));
  }
}

/** «#1F6FEB» → [31,111,235]; null o inválido → el índigo de Cortex. */
export function hexToRgb(hex: string | null | undefined, fallback: Rgb = [79, 70, 229]): Rgb {
  const m = (hex ?? '').trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return fallback;
  const v = Number.parseInt(m[1] as string, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** Un tono muy claro del color (para el fondo del encabezado de la tabla). */
export function tint(c: Rgb, amount = 0.9): Rgb {
  return c.map((v) => Math.round(v + (255 - v) * amount)) as Rgb;
}
